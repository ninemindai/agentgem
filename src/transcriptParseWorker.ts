// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/transcriptParseWorker.ts
//
// Parses the transcript-index cold build OFF the event loop. The main thread owns the sole
// node:sqlite DatabaseSync handle and does all writes; this worker only reads + parses the
// pre-identified changed files (planSync already statted them) and streams compact result
// batches back. Mirrors src/warm/scorecardWorker.ts. No SQLite, no DB import.
//
// one changed file ─┬─ scanFileUsage (readFileSync + JSON.parse, the ~286ms/79MB cost) ─┐
//                   └─ buffer {path,mtime,size,usage}; flush a batch every `batchSize` ──┴─▶ postMessage
import { parentPort, workerData } from "node:worker_threads";
import { scanFileUsage } from "@agentgem/insight";
import type { HookArtifact } from "@agentgem/model";

export interface ParseWorkerInput {
  changed: { path: string; mtime: number; size: number }[];
  hooks: HookArtifact[];
  batchSize: number;
}
export type ParseResult = { path: string; mtime: number; size: number; usage: ReturnType<typeof scanFileUsage> };

/** Pure body: emit result batches. Exported for the inline fallback / tests. */
export function parseChangedFiles(input: ParseWorkerInput, emit: (batch: ParseResult[]) => void): { seen: string[] } {
  const seen: string[] = [];
  let buf: ParseResult[] = [];
  for (const c of input.changed) {
    const usage = scanFileUsage(c.path, input.hooks);
    seen.push(c.path);
    buf.push({ path: c.path, mtime: c.mtime, size: c.size, usage });
    if (buf.length >= input.batchSize) { emit(buf); buf = []; }
  }
  if (buf.length) emit(buf);
  return { seen };
}

if (parentPort) {
  const port = parentPort;
  const { seen } = parseChangedFiles(workerData as ParseWorkerInput, (batch) => port.postMessage({ results: batch }));
  port.postMessage({ done: true, seen });
}
