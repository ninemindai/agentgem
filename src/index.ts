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
import { isMain } from "@agentback/core";
import type { RestApplication } from "@agentback/rest";
import { buildCommonApp, finalizeCommonApp, installGracefulShutdown, warmEnabled } from "./appCommon.js";
import { mountAggregator } from "./serverAggregator.js";
import { BenchmarkProxyController } from "./benchmark.proxy.controller.js";
import { AgentTasksController } from "./agentTasks.controller.js";
import { startWarmSchedule } from "./warm/schedule.js";

// Moved to serverAggregator.ts (Task 4); re-exported here because
// src/__tests__/migrateAccountsOrFail.test.ts imports it from "../index.js".
export { migrateAccountsOrFail } from "./serverAggregator.js";

// Moved to appCommon.ts (Task 5); re-exported here because
// src/__tests__/serverHost.test.ts imports it from "../index.js".
export { serverHost } from "./appCommon.js";

// Moved to appCommon.ts (Task 6, pure move — no behaviour change: src/client.ts needs both
// and must not import from index.ts); re-exported here because
// src/__tests__/gracefulShutdown.test.ts and src/__tests__/warmEnabled.test.ts import them
// from "../index.js".
export { installGracefulShutdown, warmEnabled } from "./appCommon.js";

export async function createApp(port: number): Promise<RestApplication> {
  const { app, server } = await buildCommonApp(port);
  // Aggregator + gating + better-auth + stars/reviews/catalog/groups/gemShares/usage/handles/
  // account + OG cards + the GitHub App + registry upload-publish (Task 4: extracted into
  // serverAggregator.ts, no behaviour change).
  await mountAggregator(app, server, process.env);
  // The console's Benchmark tab reads the hosted benchmark NETWORK (k-anon, cross-producer) at
  // /api/benchmark in every mode — that data lives on the hosted aggregator, never in the local
  // pglite. The desktop client entry mounts this proxy; the server entry (npx / dev) must too, or
  // the tab 404s. It fetches AGENTGEM_AGGREGATOR_URL (default api.agentgem.ai) — a different route
  // (/api/aggregator/benchmarks) than this one, so even on the hosted box it's one hop, not a loop.
  app.restController(BenchmarkProxyController);
  // Settings for background agent tasks (report/distill/recommend/judge model+agent defaults).
  app.restController(AgentTasksController);
  // Global originGuard + /healthz + console-serving + the raw SSE routes (Task 5: extracted into
  // appCommon.ts, no behaviour change). Registered AFTER mountAggregator — see appCommon.ts's
  // module comment for why the ordering matters (AgentBack orders same-group express middlewares
  // by registration order; middleware.shareOriginSecret + mountGating's rate limiters must run
  // before the global originGuard).
  finalizeCommonApp(app, server);
  return app;
}

// Start the server and print where its surfaces live. Shared by the default
// entry point (below) and the `agentgem` CLI (src/cli.ts).
export async function run(port: number = Number(process.env.PORT ?? 4317)): Promise<RestApplication> {
  const app = await createApp(port);
  await app.start();
  const sched = warmEnabled(process.env) ? startWarmSchedule() : null;
  installGracefulShutdown({ stop: async () => { sched?.stop(); await app.stop(); } });
  const server = await app.restServer;
  // A parent process (the desktop host forks this entry with PORT=0) needs the
  // OS-assigned port back. One JSON line, before the human lines, so the parent
  // never has to parse prose that log rewording would break.
  if (process.env.AGENTGEM_IPC === "1") console.log(JSON.stringify({ type: "ready", url: server.url }));
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
