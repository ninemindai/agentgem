// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTranscriptIndex, type TranscriptIndex } from "@agentgem/capture";
import { scanFileUsage } from "@agentgem/insight";
import { buildOffThreadParse } from "../../coldBuildParser.js";

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
