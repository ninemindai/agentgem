// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/coldBuildParser.ts
//
// Builds the OffThreadParse producer @agentgem/capture consumes. This is the ONLY place
// worker_threads + the worker path live; capture never references either. Resolution reuses
// #267's resolveWorkerPath with THIS worker's candidates — both files sit at root src/→dist/ and
// esbuild inlines this module into dist/index.js, so import.meta.url is dist/ in loose AND bundled
// layouts; the single candidate "./transcriptParseWorker.js" covers both (A5).
import { Worker } from "node:worker_threads";
import { createLogger } from "@agentgem/base";
import { resolveWorkerPath } from "./warm/workerPath.js";
import type { OffThreadParse } from "@agentgem/capture";

const log = createLogger("capture");
const CANDIDATES = ["./transcriptParseWorker.js"] as const;
const BATCH_SIZE = 64;

/** `candidates` param is for tests (force an unresolvable path); production uses the default. */
export function buildOffThreadParse(candidates: readonly string[] = CANDIDATES): OffThreadParse {
  return async (input, onBatch) => {
    const workerPath = resolveWorkerPath(import.meta.url, candidates);
    if (!workerPath) throw new Error("transcript parse worker not found");
    return await new Promise<{ seen: string[] }>((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: { changed: input.changed, hooks: input.hooks, batchSize: BATCH_SIZE } });
      const chain: Promise<void> = Promise.resolve();
      let tail = chain;
      let settled = false;
      worker.on("message", (m: { results?: never[]; done?: boolean; seen?: string[] }) => {
        if (m.results) { tail = tail.then(() => onBatch(m.results as never)); return; }
        if (m.done) { settled = true; tail.then(() => { resolve({ seen: m.seen ?? [] }); void worker.terminate(); }).catch(reject); }
      });
      worker.on("error", reject);
      worker.on("exit", (code) => { if (!settled) reject(new Error(`transcript parse worker exited with code ${code}`)); });
    });
  };
}
