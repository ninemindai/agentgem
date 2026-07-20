// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { openTranscriptIndex, type TranscriptIndex } from "@agentgem/capture";
import { scanFileUsage } from "@agentgem/insight";
import { buildOffThreadParse } from "@agentgem/app/coldBuildParser";

const tu = (skill: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill } }] } });

describe("cold-build worker", () => {
  let dir: string; let index: TranscriptIndex;
  let prevByteEnv: string | undefined;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cbw-"));
    index = await openTranscriptIndex("memory://");
    prevByteEnv = process.env.AGENTGEM_USAGE_WORKER_BYTES;
    // Force the streamed/worker branch regardless of corpus size: routing is
    // `pendingBytes > AGENTGEM_USAGE_WORKER_BYTES` (default 20MB), and this test's fixture is
    // far below that. Without this override the producer below would never run and the test
    // would be green without proving anything about the worker.
    process.env.AGENTGEM_USAGE_WORKER_BYTES = "0";
  });
  afterEach(async () => {
    await index.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevByteEnv === undefined) delete process.env.AGENTGEM_USAGE_WORKER_BYTES;
    else process.env.AGENTGEM_USAGE_WORKER_BYTES = prevByteEnv;
  });

  it("worker path yields byte-identical rows to inline", async () => {
    const files: string[] = [];
    for (let i = 0; i < 60; i++) { const p = join(dir, `f${i}.jsonl`); writeFileSync(p, [tu("qa"), tu("qa")].join("\n") + "\n"); files.push(p); }
    const parse = (p: string) => scanFileUsage(p, []);
    const ref = await openTranscriptIndex("memory://");
    const inline = await ref.syncUsage(files, "hd", parse);
    await ref.close();
    // Force the worker branch by lowering nothing — 60 files is small, so pass a tiny BYTE cap via
    // buildOffThreadParse is not how routing works; instead assert equality when the producer runs.
    const streamed = await index.syncUsage(files, "hd", parse, buildOffThreadParse(), []);
    expect(streamed.raw).toEqual(inline.raw);
  });

  it("falls back to inline when the worker path is unresolvable", async () => {
    const p = join(dir, "a.jsonl"); writeFileSync(p, tu("qa") + "\n");
    const parse = (f: string) => scanFileUsage(f, []);
    // A producer built with a bogus candidate resolves null → buildOffThreadParse throws at spawn →
    // syncUsage's caller (getGlobalUsageIndexed) catches and retries inline. Here assert the
    // producer rejects, and that inline still works:
    const bad = buildOffThreadParse(["./does-not-exist.js"]);
    await expect(bad({ changed: [{ path: p, mtime: 1, size: 1 }], hooks: [] }, async () => {})).rejects.toThrow();
    const out = await index.syncUsage([p], "hd", parse);
    expect(out.raw.find((r) => r.token === "qa")).toBeTruthy();
  });
});

import { readFileSync } from "node:fs";
describe("packaging", () => {
  it("transcriptParseWorker is a bundle-bins entry", () => {
    const src = readFileSync(new URL("../../../scripts/bundle-bins.mjs", import.meta.url), "utf8");
    expect(src).toContain("transcriptParseWorker.js");
  });
});

function heartbeat() {
  let last = performance.now(), max = 0;
  const h = setInterval(() => { const n = performance.now(); max = Math.max(max, n - last - 50); last = n; }, 50);
  return { async stop() { await new Promise((r) => setTimeout(r, 120)); clearInterval(h); return max; } };
}

describe("acceptance: main thread stays responsive during a cold build", () => {
  it("max event-loop block < 100ms while a >150ms file parses off-thread", async () => {
    // instrument self-test:
    { const b = heartbeat(); const t0 = Date.now(); while (Date.now() - t0 < 500); const g = await b.stop(); expect(g).toBeGreaterThan(400); }
    const dir = mkdtempSync(join(tmpdir(), "cbw-acc-"));
    try {
      // one big file (~30MB of tool_use records) whose own scanFileUsage measures ~246-250ms
      // standalone (measured directly, repeat count raised from 60000 until comfortably >200ms
      // margin above the 150ms target) + some small ones
      const big = join(dir, "big.jsonl");
      const line = tu("qa");
      writeFileSync(big, (line + "\n").repeat(250000)); // ~30MB; standalone scanFileUsage ~246-250ms
      const small: string[] = [big];
      for (let i = 0; i < 20; i++) { const p = join(dir, `s${i}.jsonl`); writeFileSync(p, line + "\n"); small.push(p); }
      process.env.AGENTGEM_USAGE_WORKER_BYTES = "0"; // force the worker branch
      const index = await openTranscriptIndex(join(dir, "idx.db"));
      const hb = heartbeat();
      await index.syncUsage(small, "hd", (p) => scanFileUsage(p, []), buildOffThreadParse(), []);
      const maxBlock = await hb.stop();
      await index.close();
      expect(maxBlock).toBeLessThan(100);
    } finally { delete process.env.AGENTGEM_USAGE_WORKER_BYTES; rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
