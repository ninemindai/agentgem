// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/client.ts — DESKTOP entry: a pure API client, independent of src/index.ts. Imports only
// from appCommon.ts (the shared app-building surface) and benchmark.proxy.controller.ts (the
// same-origin proxy to the hosted aggregator) — never from index.ts or serverAggregator.ts, so a
// bundle built from this file pulls in no aggregator/DB code (@agentgem/aggregator, PGlite,
// drizzle). See appCommon.ts's module comment for why buildCommonApp/finalizeCommonApp are split.
import { config as loadEnv } from "dotenv";
import { credentialsEnvPath } from "@agentgem/capture";
// Load env before anything reads it — mirrors index.ts's bootstrap (see there for the layering
// rationale: cwd .env, a dev override, layered over the persisted server credentials).
loadEnv({ quiet: true });
loadEnv({ path: credentialsEnvPath(), quiet: true });
import { isMain } from "@agentback/core";
import type { RestApplication } from "@agentback/rest";
import { buildCommonApp, finalizeCommonApp, installGracefulShutdown, warmEnabled } from "./appCommon.js";
import { BenchmarkProxyController } from "./benchmark.proxy.controller.js";
import { startWarmSchedule } from "./warm/schedule.js";

export async function createClientApp(port: number): Promise<RestApplication> {
  const { app, server } = await buildCommonApp(port);
  // Client-only proxy: same-origin route the console's Benchmark tab calls, forwarding to the
  // hosted aggregator over plain fetch. Slots where mountAggregator sits on the server entry —
  // this is the ONLY controller the client entry adds, and it needs no DB.
  app.restController(BenchmarkProxyController);
  // Same global originGuard + /healthz + console-serving + SSE routes as the server entry
  // (Task 5), registered after the controller step like createApp does with mountAggregator.
  finalizeCommonApp(app, server);
  return app;
}

// Start the client and print where its surfaces live. Mirrors index.ts's run(), minus every
// aggregator-specific concern (no DB migration logging, no aggregator mode line).
export async function runClient(port: number = Number(process.env.PORT ?? 4317)): Promise<RestApplication> {
  const app = await createClientApp(port);
  await app.start();
  const sched = warmEnabled(process.env) ? startWarmSchedule() : null;
  installGracefulShutdown({ stop: async () => { sched?.stop(); await app.stop(); } });
  const server = await app.restServer;
  // A parent process (the desktop host forks this entry with PORT=0) needs the OS-assigned port
  // back. One JSON line, before the human lines, so the parent never has to parse prose that log
  // rewording would break.
  if (process.env.AGENTGEM_IPC === "1") console.log(JSON.stringify({ type: "ready", url: server.url }));
  console.log(`agentgem (client mode) listening at ${server.url}`);
  console.log(`  UI:        ${server.url}/`);
  console.log(`  Benchmark: ${server.url}/api/benchmark`);
  console.log(`  MCP:       ${server.url}/mcp`);
  return app;
}

if (isMain(import.meta)) {
  runClient().catch((err) => { console.error(err); process.exit(1); });
}
