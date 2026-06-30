// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/index.ts
import { config as loadEnv } from "dotenv";
import { credentialsEnvPath } from "@agentgem/capture";
// Load env before anything reads it: cwd .env (a dev override) layered over the
// persisted server credentials in ~/.agentgem/.env. `override` defaults to false,
// so a value already set in the cwd .env wins. `quiet` silences dotenv's banner/
// tips so the `agentgem` CLI output stays clean.
loadEnv({ quiet: true });
loadEnv({ path: credentialsEnvPath(), quiet: true });
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isMain } from "@agentback/core";
import { RestApplication } from "@agentback/rest";
import { installExplorer } from "@agentback/rest-explorer";
import { MCPComponent } from "@agentback/mcp";
import { installMcpHttp } from "@agentback/mcp-http";
import { GemController } from "./gem.controller.js";
import { GemTools } from "./gem.tools.js";
import { streamWorkflowAnalyze } from "./workflowStream.js";
import { streamGemRun } from "./gemRunStream.js";
import { streamScorecard } from "./scorecardStream.js";
import { originGuard } from "./originGuard.js";
import { registerDrizzle } from "@agentback/drizzle";
import { AggregatorController } from "./aggregator.controller.js";
import { ShareController } from "./share.controller.js";
import { requireShareOriginSecret } from "./originSecret.js";
import { ShareProxyController } from "./share.proxy.controller.js";
import { resolveAggregatorDb } from "@agentgem/aggregator";
import { mountGating } from "./gating.js";

const here = dirname(fileURLToPath(import.meta.url));

// The React console SPA (one self-contained file). dist build path first, then a
// dev fallback to the console package's own dist; finally a placeholder.
function consoleHtml(): string {
  for (const p of [
    join(here, "public", "console", "index.html"),
    join(here, "..", "packages", "console", "dist", "index.html"),
  ]) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  return '<!doctype html><div id="root"></div><p>console not built — run pnpm build</p>';
}

// The bind address. Defaults to loopback so local runs stay loopback-only (the
// security model assumes 127.0.0.1); a deploy sets HOST=0.0.0.0 to accept external
// traffic, where originGuard + the public-read allowlist are the real boundary.
export function serverHost(): string {
  return process.env.HOST ?? "127.0.0.1";
}

export async function createApp(port: number): Promise<RestApplication> {
  const app = new RestApplication({});
  // Raise the JSON body limit above express's 100kb default: routes that carry a whole gem
  // archive in the request body (/gem/apply, /materialize with bytesBase64) send base64 that
  // routinely exceeds 100kb. A generous ceiling is safe; originGuard + the public-read allowlist
  // are the real boundary. bodyParser lives on the RestServer config (alongside port/host), not
  // the top-level app config. Host comes from serverHost() so a deploy can bind 0.0.0.0.
  app.configure("servers.RestServer").to({ port, host: serverHost(), bodyParser: { json: { limit: "25mb" } } });
  app.component(MCPComponent);
  app.configure("servers.MCPServer").to({ name: "agentgem", version: "0.1.0", transports: { stdio: false } });
  app.restController(GemController);
  app.restController(ShareProxyController);
  app.service(GemTools);
  // Aggregator (B1) + gating: always registered now — Postgres when DATABASE_URL is set, else
  // embedded pglite for local runs (ephemeral). mountGating adds the api-key identity middleware
  // + the two-tier rate limiters over /api/aggregator. Public read endpoints are CORS-open and
  // originGuard-exempt; auth boundary is apiKeyIdentity + rate limiters.
  {
    const { db, onStop, mode } = await resolveAggregatorDb();
    registerDrizzle(app, db as never, { onStop });
    app.restController(AggregatorController);
    app.restController(ShareController);
    // POST /api/aggregator/share (anonymous create) is rate-limited by mountGating's anon per-IP
    // bucket below (keyed on CLIENT_IP_HEADER). That IP is only trustworthy if the request came
    // through Cloudflare, so require a CF-injected origin secret on the create (no-op until
    // ORIGIN_SHARED_SECRET is set). Public reads + /healthz are never gated.
    app.expressMiddleware("middleware.shareOriginSecret", requireShareOriginSecret);
    await mountGating(app, db);
    console.log(`aggregator: ${mode}${mode === "pglite" ? " (set DATABASE_URL for Postgres)" : ""}`);
  }
  // CSRF / drive-by guard: reject browser-initiated cross-site requests to the loopback API
  // (controller routes). Same-origin UI and non-browser clients (CLI/MCP/tests) pass. Mounted in
  // the framework middleware chain so it runs before controller dispatch.
  app.expressMiddleware("middleware.originGuard", originGuard);
  await installExplorer(app, { title: "agentgem API" });
  await installMcpHttp(app);
  const server = await app.restServer;
  // Behind a proxy/LB, req.ip is the proxy's address unless we trust the forwarding header.
  // Off by default (loopback dev). Deploys set TRUST_PROXY to the hop count (e.g. "1"), a
  // boolean, or a subnet string — see Express "trust proxy". Trusting all proxies blindly
  // lets clients spoof X-Forwarded-For, so this is opt-in via env, not "true" by default.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    const n = Number(trustProxy);
    server.expressApp.set("trust proxy", Number.isFinite(n) ? n : trustProxy);
  }
  // The React console (`dist/public/console`) is the UI, served at `/` (and `/console`).
  // It replaced the original vanilla UI, now removed (history in git). The gem-transfer
  // feature's backend (/api/transfer/*) ships, but its web redeem UI is not yet ported to
  // the console — use the `agentgem receive` CLI until then.
  // Liveness probe for deploy orchestrators (Cloud Run / ECS / Fly / k8s). Unauthenticated
  // and origin-less by design — registered as a raw route, so it's outside originGuard.
  server.expressApp.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  // The desktop console UI is served at `/` (and `/console`) for LOCAL runs only. The hosted
  // public deployment (app.agentgem.ai) is API-only — the console is a local desktop app, not a
  // public surface — so SERVE_CONSOLE=false disables it there and redirects `/` to the site.
  if (process.env.SERVE_CONSOLE !== "false") {
    const consolePage = consoleHtml();
    server.expressApp.get("/", (_req, res) => res.type("html").send(consolePage));
    server.expressApp.get("/console", (_req, res) => res.type("html").send(consolePage));
  } else {
    server.expressApp.get("/", (_req, res) => res.redirect(302, "https://agentgem.ai"));
  }
  // SSE progress stream for workflow analysis (raw Express — the decorator
  // framework only returns single JSON bodies). The POST /api/workflow/analyze
  // route stays for programmatic/test callers. originGuard is applied per-route because these raw
  // routes are registered directly on expressApp, outside the controller dispatch chain.
  server.expressApp.get("/api/workflow/analyze/stream", originGuard, streamWorkflowAnalyze);
  // SSE progress stream for running a Gem with a local ACP agent (materialize →
  // run → tool/token deltas → done). POST /api/gem/run stays for programmatic callers.
  server.expressApp.get("/api/gem/run/stream", originGuard, streamGemRun);
  // SSE scorecard scan: per-project progress with live-climbing counts, then the
  // final aggregate scorecard. GET /api/scorecard/stream?projects=[...]&dir=...
  server.expressApp.get("/api/scorecard/stream", originGuard, (req, res) => streamScorecard(req as never, res as never));
  return app;
}

// Graceful shutdown: orchestrators (k8s / Cloud Run / ECS / Fly) send SIGTERM and
// expect the process to drain in-flight work (and close the pg pool — see createApp)
// then exit within the grace period. Without this, Node exits immediately on SIGTERM,
// dropping connections. Hooks are injectable so it's unit-testable without spawning.
export function installGracefulShutdown(
  app: { stop: () => Promise<void> },
  opts: {
    on?: (signal: "SIGTERM" | "SIGINT", cb: () => void) => void;
    exit?: (code: number) => void;
    log?: (msg: string) => void;
  } = {},
): void {
  const on = opts.on ?? ((sig, cb) => { process.once(sig, cb); });
  const exit = opts.exit ?? ((code) => process.exit(code));
  const log = opts.log ?? ((msg) => console.log(msg));
  let stopping = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (stopping) return; // a second signal mid-drain must not double-stop
    stopping = true;
    log(`agentgem received ${sig}, draining…`);
    try { await app.stop(); exit(0); }
    catch (err) { console.error(err); exit(1); }
  };
  on("SIGTERM", () => void shutdown("SIGTERM"));
  on("SIGINT", () => void shutdown("SIGINT"));
}

// Start the server and print where its surfaces live. Shared by the default
// entry point (below) and the `agentgem` CLI (src/cli.ts).
export async function run(port: number = Number(process.env.PORT ?? 4317)): Promise<RestApplication> {
  const app = await createApp(port);
  await app.start();
  installGracefulShutdown(app);
  const server = await app.restServer;
  console.log(`agentgem listening at ${server.url}`);
  console.log(`  UI:       ${server.url}/`);
  console.log(`  API:      ${server.url}/api/inventory  ·  POST ${server.url}/api/gem`);
  console.log(`  Explorer: ${server.url}/explorer/`);
  console.log(`  MCP:      ${server.url}/mcp`);
  return app;
}

if (isMain(import.meta)) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
