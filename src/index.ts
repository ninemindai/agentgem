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
import { originGuard } from "./originGuard.js";

const here = dirname(fileURLToPath(import.meta.url));
// Read a static UI asset from dist/public (built) or src/public (dev fallback).
function publicAsset(name: string): string {
  for (const p of [join(here, "public", name), join(here, "..", "src", "public", name)]) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  return "";
}
function pageHtml(): string {
  return publicAsset("index.html") || "<!doctype html><p>index.html not found</p>";
}

export async function createApp(port: number): Promise<RestApplication> {
  const app = new RestApplication({});
  app.configure("servers.RestServer").to({ port, host: "127.0.0.1" });
  app.component(MCPComponent);
  app.configure("servers.MCPServer").to({ name: "agentgem", version: "0.1.0", transports: { stdio: false } });
  app.restController(GemController);
  app.service(GemTools);
  // CSRF / drive-by guard: reject browser-initiated cross-site requests to the loopback API
  // (controller routes). Same-origin UI and non-browser clients (CLI/MCP/tests) pass. Mounted in
  // the framework middleware chain so it runs before controller dispatch.
  app.expressMiddleware("middleware.originGuard", originGuard);
  await installExplorer(app, { title: "agentgem API" });
  await installMcpHttp(app);
  const server = await app.restServer;
  const html = pageHtml();
  server.expressApp.get("/", (_req, res) => res.type("html").send(html));
  // Serve the client-side decrypt ES module for the web-receiver's private redeem.
  const transferDecryptJs = publicAsset("transfer-decrypt.js");
  server.expressApp.get("/transfer-decrypt.js", (_req, res) =>
    transferDecryptJs
      ? res.type("application/javascript").send(transferDecryptJs)
      : res.status(404).send("// transfer-decrypt.js not found"), // fail loud, not an empty 200
  );
  // SSE progress stream for workflow analysis (raw Express — the decorator
  // framework only returns single JSON bodies). The POST /api/workflow/analyze
  // route stays for programmatic/test callers. originGuard is applied per-route because these raw
  // routes are registered directly on expressApp, outside the controller dispatch chain.
  server.expressApp.get("/api/workflow/analyze/stream", originGuard, streamWorkflowAnalyze);
  // SSE progress stream for running a Gem with a local ACP agent (materialize →
  // run → tool/token deltas → done). POST /api/gem/run stays for programmatic callers.
  server.expressApp.get("/api/gem/run/stream", originGuard, streamGemRun);
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
