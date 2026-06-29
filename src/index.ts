// src/index.ts
import { config as loadEnv } from "dotenv";
import { credentialsEnvPath } from "./gem/credentials.js";
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
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { registerDrizzle } from "@agentback/drizzle";
import { schema, ensureSchema } from "./aggregator/schema.js";
import { AggregatorController } from "./aggregator.controller.js";
import { ShareController } from "./share.controller.js";
import { shareRateLimit } from "./share/rateLimit.js";
import { ShareProxyController } from "./share.proxy.controller.js";

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

export async function createApp(port: number): Promise<RestApplication> {
  const app = new RestApplication({});
  // Raise the JSON body limit above express's 100kb default: routes that carry a whole gem
  // archive in the request body (/gem/apply, /materialize with bytesBase64) send base64 that
  // routinely exceeds 100kb. Loopback-only server, so a generous ceiling is safe. bodyParser
  // lives on the RestServer config (alongside port/host), not the top-level app config.
  app.configure("servers.RestServer").to({ port, host: "127.0.0.1", bodyParser: { json: { limit: "25mb" } } });
  app.component(MCPComponent);
  app.configure("servers.MCPServer").to({ name: "agentgem", version: "0.1.0", transports: { stdio: false } });
  app.restController(GemController);
  app.restController(ShareProxyController);
  app.service(GemTools);
  // Aggregator (B1): registered only when a Postgres DATABASE_URL is configured. The public read
  // routes are CORS-open + originGuard-exempt; POST /ingest stays guarded. Drains the pool on stop.
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const db = drizzle(pool, { schema });
    await ensureSchema(db as never);
    registerDrizzle(app, db, { onStop: () => pool.end() });
    app.restController(AggregatorController);
    app.restController(ShareController);
    // The anonymous create endpoint (POST /api/aggregator/share) has no auth, so cap it by client
    // IP — originGuard intentionally lets non-browser clients through, so this is the only guard
    // against scripted row-insertion abuse. In-memory fixed window (per-instance).
    app.expressMiddleware("middleware.shareRateLimit", shareRateLimit);
  }
  // CSRF / drive-by guard: reject browser-initiated cross-site requests to the loopback API
  // (controller routes). Same-origin UI and non-browser clients (CLI/MCP/tests) pass. Mounted in
  // the framework middleware chain so it runs before controller dispatch.
  app.expressMiddleware("middleware.originGuard", originGuard);
  await installExplorer(app, { title: "agentgem API" });
  await installMcpHttp(app);
  const server = await app.restServer;
  // The React console (`dist/public/console`) is the UI, served at `/` (and `/console`).
  // It replaced the original vanilla UI, now removed (history in git). The gem-transfer
  // feature's backend (/api/transfer/*) ships, but its web redeem UI is not yet ported to
  // the console — use the `agentgem receive` CLI until then.
  const consolePage = consoleHtml();
  server.expressApp.get("/", (_req, res) => res.type("html").send(consolePage));
  server.expressApp.get("/console", (_req, res) => res.type("html").send(consolePage));
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

// Start the server and print where its surfaces live. Shared by the default
// entry point (below) and the `agentgem` CLI (src/cli.ts).
export async function run(port: number = Number(process.env.PORT ?? 4317)): Promise<RestApplication> {
  const app = await createApp(port);
  await app.start();
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
