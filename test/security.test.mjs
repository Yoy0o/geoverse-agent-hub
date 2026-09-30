import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPair, SignJWT } from "jose";
import { authorizeAccess } from "../src/cloudflare/access.js";
import { createStore } from "../src/store.js";

const base = "http://127.0.0.1:8796";
const token = "security-fixture-token-not-a-deployed-secret";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-security-"));
let hub;
let logs = "";
let privateKey, publicKey;
const accessEnv = { ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com", ACCESS_AUD: "hub-test", ACCESS_ALLOWED_EMAILS: "hio250@163.com", ACCESS_SERVICE_IDS: "approved-client" };
const signed = (claims, audience = "hub-test", expiry = "5m") => new SignJWT(claims).setProtectedHeader({ alg: "RS256" }).setIssuer("https://example.cloudflareaccess.com").setAudience(audience).setSubject("fixture").setIssuedAt().setExpirationTime(expiry).sign(privateKey);
const accessRequest = value => new Request("https://hub.example.com/", { headers: { "Cf-Access-Jwt-Assertion": value } });
const cookieOf = response => response.headers.get("set-cookie").split(";")[0];
const call = (p, options = {}) => fetch(base + p, { ...options, signal: AbortSignal.timeout(10000) });
const login = () => call("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });

before(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("RS256"));
  hub = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "src/server.js"], { env: { ...process.env, HUB_DATA_DIR: dir, HUB_TOKEN: token, HOST: "127.0.0.1", PORT: "8796", PUBLIC_URL: "https://hub.example.com", OAUTH_ENABLED: "0", SESSION_TTL_SECONDS: "2" }, stdio: ["ignore", "pipe", "pipe"] });
  hub.stdout.on("data", d => logs += d); hub.stderr.on("data", d => logs += d);
  for (let n = 0; n < 100; n++) {
    if (hub.exitCode !== null) throw new Error(logs);
    try { if ((await call("/api/health")).ok) return; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Test service did not start: " + logs);
});
after(async () => {
  if (hub && hub.exitCode === null) { const closed = once(hub, "exit"); hub.kill(); await closed; }
  if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith("ah-security-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("Access denies unconfigured applications and forged identity headers", async () => {
  await assert.rejects(authorizeAccess(new Request("https://hub.example.com/"), {}), e => e.status === 503);
  await assert.rejects(authorizeAccess(new Request("https://hub.example.com/", { headers: { "Cf-Access-Authenticated-User-Email": "hio250@163.com" } }), accessEnv), e => e.status === 401);
  await assert.rejects(authorizeAccess(accessRequest("forged"), accessEnv, publicKey), e => e.status === 401);
});
test("Access accepts only signed owner identities and approved service tokens", async () => {
  assert.equal((await authorizeAccess(accessRequest(await signed({ email: "hio250@163.com" })), accessEnv, publicKey)).email, "hio250@163.com");
  await assert.rejects(authorizeAccess(accessRequest(await signed({ email: "other@example.com" })), accessEnv, publicKey), e => e.status === 403);
  assert.equal((await authorizeAccess(accessRequest(await signed({ common_name: "approved-client" })), accessEnv, publicKey)).service, "approved-client");
  await assert.rejects(authorizeAccess(accessRequest(await signed({ common_name: "other-client" })), accessEnv, publicKey), e => e.status === 403);
});
test("Access rejects wrong audience, expired tokens, wrong issuer and wrong signature", async () => {
  await assert.rejects(authorizeAccess(accessRequest(await signed({ email: "hio250@163.com" }, "other-app")), accessEnv, publicKey), e => e.status === 401);
  await assert.rejects(authorizeAccess(accessRequest(await signed({ email: "hio250@163.com" }, "hub-test", "-5m")), accessEnv, publicKey), e => e.status === 401);
  const wrongIssuer = await new SignJWT({ email: "hio250@163.com" }).setProtectedHeader({ alg: "RS256" }).setIssuer("https://attacker.example.com").setAudience("hub-test").setSubject("fixture").setIssuedAt().setExpirationTime("5m").sign(privateKey);
  await assert.rejects(authorizeAccess(accessRequest(wrongIssuer), accessEnv, publicKey), e => e.status === 401);
  const other = await generateKeyPair("RS256");
  await assert.rejects(authorizeAccess(accessRequest(await signed({ email: "hio250@163.com" })), accessEnv, other.publicKey), e => e.status === 401);
});
test("local development bypass never applies to public hosts", async () => {
  assert.equal((await authorizeAccess(new Request("http://127.0.0.1:8788/"), { LOCAL_DEV: "1" })).local, true);
  await assert.rejects(authorizeAccess(new Request("https://hub.example.com/"), { LOCAL_DEV: "1" }), e => e.status === 503);
});
test("sessions are unique, Secure on HTTPS, persisted and revoked on logout", async () => {
  const first = await login(), second = await login();
  assert.equal(first.status, 200);
  assert.match(first.headers.get("set-cookie"), /HttpOnly; SameSite=Lax; Max-Age=2; Secure/);
  const cookie = cookieOf(first), other = cookieOf(second);
  assert.notEqual(cookie, other);
  assert.equal((await call("/api/tasks", { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await call("/api/logout", { method: "POST", headers: { Cookie: cookie } })).status, 403);
  assert.equal((await call("/api/logout", { method: "POST", headers: { Cookie: cookie, "X-Requested-With": "agent-hub" } })).status, 200);
  assert.equal((await call("/api/tasks", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await call("/api/tasks", { headers: { Cookie: other } })).status, 200);
});
test("server enforces session expiry and treats malformed cookies as unauthorized", async () => {
  const cookie = cookieOf(await login());
  await new Promise(r => setTimeout(r, 2100));
  assert.equal((await call("/api/tasks", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await call("/api/tasks", { headers: { Cookie: "hub_session=%ZZ" } })).status, 401);
});
test("logout and expiry close already-open cookie-authenticated SSE streams", async () => {
  for (const revoke of [true, false]) {
    const cookie = cookieOf(await login());
    const response = await call("/api/stream", { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    if (revoke) await call("/api/logout", { method: "POST", headers: { Cookie: cookie, "X-Requested-With": "agent-hub" } });
    const pending = reader.read();
    const result = await pending;
    assert.equal(result.done, true);
  }
});
test("REST and MCP cookie writes require CSRF header; private responses forbid caching", async () => {
  const cookie = cookieOf(await login());
  for (const p of ["/api/docs/tasks/probe", "/mcp"]) assert.equal((await call(p, { method: p === "/mcp" ? "POST" : "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" })).status, 403);
  const res = await call("/api/export", { headers: { Authorization: "Bearer " + token } });
  assert.equal(res.status, 200); assert.match(res.headers.get("cache-control"), /no-store/);
  assert.equal(logs.includes(token), false);
});
test("failed imports roll back SQLite changes and do not broadcast uncommitted documents", () => {
  const db = new DatabaseSync(":memory:"), store = createStore(db), changes = [];
  store.bus.on("doc", event => changes.push(event));
  assert.throws(() => store.transaction(() => { store.setDoc("tasks", "one", { title: "one" }); throw new Error("rollback"); }));
  assert.equal(store.getDoc("tasks", "one"), null); assert.equal(changes.length, 0);
  store.transaction(() => store.setDoc("tasks", "two", { title: "two" }));
  assert.equal(store.getDoc("tasks", "two").data.title, "two"); assert.equal(changes.length, 1);
  db.close();
});
