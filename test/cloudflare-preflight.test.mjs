import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentErrors } from "../scripts/cloudflare-preflight.mjs";

const bootstrap = () => ({
  name: "fixture-hub", account_id: "a".repeat(32), workers_dev: false, preview_urls: false,
  assets: { binding: "ASSETS", run_worker_first: true }, secrets: { required: ["HUB_TOKEN"] },
  durable_objects: { bindings: [{ name: "HUB", class_name: "AgentHub" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["AgentHub"] }],
  vars: { HUB_INSTANCE: "personal", OAUTH_ENABLED: "0", ACCESS_TEAM_DOMAIN: "fixture.cloudflareaccess.com", ACCESS_ALLOWED_EMAILS: "owner@example.com", ACCESS_AUD: "", PUBLIC_URL: "" },
});
const production = () => {
  const config = bootstrap();
  config.workers_dev = true;
  config.vars.PUBLIC_URL = `https://${config.name}.fixture.workers.dev`;
  config.vars.ACCESS_AUD = "a".repeat(64);
  return config;
};

test("offline deployment gate rejects incomplete or unsafe production settings", () => {
  assert.deepEqual(deploymentErrors(bootstrap(), { bootstrap: true }), []);
  assert.ok(deploymentErrors(bootstrap()).length > 0);
  assert.deepEqual(deploymentErrors(production()), []);
  for (const mutate of [
    config => { config.preview_urls = true; },
    config => { config.assets.run_worker_first = false; },
    config => { config.vars.LOCAL_DEV = "1"; },
    config => { config.vars.HUB_TOKEN = "fixture-secret"; },
    config => { config.vars.ACCESS_ALLOWED_EMAILS = "*@example.com"; },
    config => { config.vars.ACCESS_AUD = "placeholder"; },
    config => { config.vars.PUBLIC_URL = "https://another-worker.fixture.workers.dev"; },
    config => { config.vars.PUBLIC_URL += "/"; },
    config => { config.workers_dev = false; },
  ]) {
    const config = production(); mutate(config);
    assert.ok(deploymentErrors(config).length > 0);
  }
});

test("bootstrap cannot open routes and custom domain must match PUBLIC_URL", () => {
  for (const mutate of [
    config => { config.workers_dev = true; },
    config => { config.routes = [{ pattern: "hub.example.com", custom_domain: true }]; },
    config => { config.route = "hub.example.com/*"; },
    config => { config.vars.ACCESS_AUD = "a".repeat(64); },
    config => { config.vars.PUBLIC_URL = "https://hub.example.com"; },
  ]) {
    const config = bootstrap(); mutate(config);
    assert.ok(deploymentErrors(config, { bootstrap: true }).length > 0);
  }
  const config = production();
  config.workers_dev = false;
  config.vars.PUBLIC_URL = "https://hub.example.com";
  config.routes = [{ pattern: "hub.example.com", custom_domain: true }];
  assert.deepEqual(deploymentErrors(config), []);
  config.routes[0].pattern = "wrong.example.com";
  assert.ok(deploymentErrors(config).length > 0);
});
