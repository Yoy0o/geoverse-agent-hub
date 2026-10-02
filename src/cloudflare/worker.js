import { DurableObject } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import { createServer } from "node:http";
import { createApp } from "../app.js";
import { createStore } from "../store.js";
import { createConfig } from "./config.js";
import { sqliteAdapter } from "./sqlite.js";
import { runtime, current } from "./runtime.js";
import { authorizeAccess, AccessError, localRequest } from "./access.js";

const nodeHandler = httpServerHandler(createServer((req, res) => current().app(req, res)));
const dynamicPath = /^(?:\/(?:api|hooks|v1|oauth|\.well-known)(?:\/|$)|\/(?:mcp|connect\.mjs|runner\.mjs|authorize|token|register|revoke)(?:\/|$))/;
const interval = 6 * 3600 * 1000;

export class AgentHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.runtime = { config: createConfig(env), store: createStore(sqliteAdapter(ctx.storage)) };
    ctx.blockConcurrencyWhile(() => runtime.run(this.runtime, async () => {
      this.runtime.app = await createApp({ serveStatic: false, trustProxy: 1 });
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + interval);
    }));
  }

  async fetch(request) {
    return runtime.run(this.runtime, () => nodeHandler.fetch(request, this.env, this.ctx));
  }

  async alarm() {
    runtime.run(this.runtime, () => {
      this.runtime.store.pruneEvents(this.runtime.config.eventRetentionDays);
      this.runtime.store.pruneRuns(this.runtime.config.eventRetentionDays);
      this.runtime.store.kv.prune();
    });
    await this.ctx.storage.setAlarm(Date.now() + interval);
  }
}

function privateResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    try {
      if (String(env.HUB_TOKEN || "").trim().length < 24) throw new AccessError(503, "hub_secret_not_configured");
      if (!localRequest(request, env)) {
        if (!/^https:\/\/[^/]+$/.test(env.PUBLIC_URL || "")) throw new AccessError(503, "public_url_not_configured");
      }
      await authorizeAccess(request, env);
      const url = new URL(request.url);
      if (!dynamicPath.test(url.pathname)) return privateResponse(await env.ASSETS.fetch(request));
      const headers = new Headers(request.headers);
      headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
      headers.set("x-forwarded-host", url.host);
      headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") || "127.0.0.1");
      const forwarded = new Request(request, { headers });
      // One coordination/storage atom for this personal workspace, never one per request.
      return privateResponse(await env.HUB.getByName(env.HUB_INSTANCE || "personal").fetch(forwarded));
    } catch (error) {
      const expected = error instanceof AccessError;
      if (!expected) console.error(JSON.stringify({ event: "hub_request_error", name: error.name }));
      return privateResponse(Response.json({ error: expected ? error.message : "internal_error" }, { status: expected ? error.status : 500 }));
    }
  },
};
