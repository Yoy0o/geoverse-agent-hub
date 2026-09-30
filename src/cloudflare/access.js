import { createRemoteJWKSet, jwtVerify } from "jose";

const keySets = new Map(); // Public signing-key cache, never request/session state.
const list = (value) => String(value || "").split(",").map(v => v.trim()).filter(Boolean);
export const localRequest = (request, env) => env.LOCAL_DEV === "1" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname);

export class AccessError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

export async function authorizeAccess(request, env, testKeys) {
  if (localRequest(request, env)) return { local: true };
  const team = String(env.ACCESS_TEAM_DOMAIN || "").trim();
  const aud = list(env.ACCESS_AUD);
  const emails = list(env.ACCESS_ALLOWED_EMAILS).map(v => v.toLowerCase());
  const services = list(env.ACCESS_SERVICE_IDS);
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !aud.length || !emails.length) throw new AccessError(503, "access_not_configured");
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new AccessError(401, "access_required");
  const issuer = `https://${team}`;
  let keys = testKeys;
  if (!keys) {
    if (!keySets.has(team)) {
      if (keySets.size >= 8) keySets.clear();
      keySets.set(team, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
    }
    keys = keySets.get(team);
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keys, { issuer, audience: aud, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub"] }));
  } catch { throw new AccessError(401, "invalid_access_token"); }
  if (typeof payload.email === "string" && emails.includes(payload.email.toLowerCase())) return { email: payload.email };
  if (typeof payload.common_name === "string" && services.includes(payload.common_name)) return { service: payload.common_name };
  throw new AccessError(403, "identity_not_allowed");
}
