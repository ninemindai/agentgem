// src/index.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isMain } from "@agentback/core";
import { RestApplication } from "@agentback/rest";
import { installExplorer } from "@agentback/rest-explorer";
import { MCPComponent } from "@agentback/mcp";
import { installMcpHttp } from "@agentback/mcp-http";
import { PackController } from "./pack.controller.js";
import { PackTools } from "./pack.tools.js";

const here = dirname(fileURLToPath(import.meta.url));
function pageHtml(): string {
  for (const p of [join(here, "public", "index.html"), join(here, "..", "src", "public", "index.html")]) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  return "<!doctype html><p>index.html not found</p>";
}

export async function createApp(port: number): Promise<RestApplication> {
  const app = new RestApplication({});
  app.configure("servers.RestServer").to({ port, host: "127.0.0.1" });
  app.component(MCPComponent);
  app.configure("servers.MCPServer").to({ name: "agentpack", version: "0.1.0", transports: { stdio: false } });
  app.restController(PackController);
  app.service(PackTools);
  await installExplorer(app, { title: "agentpack API" });
  await installMcpHttp(app);
  const server = await app.restServer;
  const html = pageHtml();
  server.expressApp.get("/", (_req, res) => res.type("html").send(html));
  return app;
}

async function main() {
  const port = Number(process.env.PORT ?? 4317);
  const app = await createApp(port);
  await app.start();
  const server = await app.restServer;
  console.log(`agentpack listening at ${server.url}`);
  console.log(`  UI:       ${server.url}/`);
  console.log(`  API:      ${server.url}/api/inventory  ·  POST ${server.url}/api/pack`);
  console.log(`  Explorer: ${server.url}/explorer/`);
  console.log(`  MCP:      ${server.url}/mcp`);
}

if (isMain(import.meta)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
