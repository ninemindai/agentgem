// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { openTranscriptIndex, type TranscriptIndex, type OffThreadParse } from "@agentgem/capture";
import type { FileUsage } from "@agentgem/insight";

// A fake off-thread producer: parses the changed files INLINE via a supplied fn, but delivers
// them through the same batch/onBatch protocol the real worker uses — so this exercises the
// streamed write path with zero worker flakiness.
function fakeProducer(parse: (p: string) => FileUsage, batchSize = 2) {
  const state = { batchCalls: 0 };
  const p: OffThreadParse = async (input, onBatch) => {
    const seen: string[] = [];
    let buf: { path: string; mtime: number; size: number; usage: FileUsage }[] = [];
    for (const c of input.changed) {
      seen.push(c.path);
      buf.push({ path: c.path, mtime: c.mtime, size: c.size, usage: parse(c.path) });
      if (buf.length >= batchSize) { state.batchCalls++; await onBatch(buf); buf = []; }
    }
    if (buf.length) { state.batchCalls++; await onBatch(buf); }
    return { seen };
  };
  return { p, state }; // read state.batchCalls after the run
}

function write(path: string, content: string, mtimeSec?: number) {
  writeFileSync(path, content);
  if (mtimeSec !== undefined) utimesSync(path, mtimeSec, mtimeSec);
}
const usage = (raw: FileUsage["raw"], hooks: FileUsage["hooks"] = []): FileUsage => ({ raw, hooks });

describe("syncUsage streamed path (offThreadParse)", () => {
  let dir: string; let index: TranscriptIndex;
  beforeEach(async () => {
    // Force the streamed branch regardless of pendingBytes — these are tiny test fixtures, far
    // below the real 20 MB BYTE_THRESHOLD, so routing needs the env override to exercise the
    // producer at all (see doSyncRouted).
    process.env.AGENTGEM_USAGE_WORKER_BYTES = "0";
    dir = mkdtempSync(join(tmpdir(), "strm-"));
    index = await openTranscriptIndex("memory://");
  });
  afterEach(async () => {
    delete process.env.AGENTGEM_USAGE_WORKER_BYTES;
    await index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("streamed rows are byte-identical to inline for the same corpus", async () => {
    const a = join(dir, "a.jsonl"); const b = join(dir, "b.jsonl");
    write(a, "aaaaaaaaaa"); write(b, "bbbbbbbbbb");
    const rows = new Map<string, FileUsage>([
      [a, usage([{ kind: "skill", token: "qa", invocations: 2 }])],
      [b, usage([{ kind: "mcp_server", token: "ctx", invocations: 1 }], [{ name: "stopper", invocations: 1 }])],
    ]);
    const parse = (p: string) => rows.get(p)!;
    // Inline reference index:
    const ref = await openTranscriptIndex("memory://");
    const inline = await ref.syncUsage([a, b], "hd", parse);
    await ref.close();
    // Streamed via the fake producer, forced over threshold by passing offThreadParse:
    const prod = fakeProducer(parse);
    const streamed = await index.syncUsage([a, b], "hd", parse, prod.p);
    expect(streamed.raw).toEqual(inline.raw);
    expect(streamed.hooks).toEqual(inline.hooks);
  });

  it("writes each batch in its own transaction (2 files, batchSize 2 → rows present after)", async () => {
    const a = join(dir, "a.jsonl"); const b = join(dir, "b.jsonl");
    write(a, "a"); write(b, "b");
    const parse = (_p: string) => usage([{ kind: "skill", token: "qa", invocations: 1 }]);
    const prod = fakeProducer(parse, 1); // one file per batch → 2 batches
    const out = await index.syncUsage([a, b], "hd", parse, prod.p);
    expect(out.raw.filter((r) => r.token === "qa").length).toBe(2);
    expect(prod.state.batchCalls).toBe(2);
  });

  it("a failed:true result skips its upsert, keeps prior rows", async () => {
    const a = join(dir, "a.jsonl"); write(a, "a", 1000);
    await index.syncUsage([a], "hd", () => usage([{ kind: "skill", token: "qa", invocations: 3 }]));
    // now a read-failure on a changed a:
    write(a, "a-longer", 2000);
    const prod = fakeProducer(() => ({ raw: [], hooks: [], failed: true }));
    const out = await index.syncUsage([a], "hd", () => ({ raw: [], hooks: [], failed: true }), prod.p);
    expect(out.raw.find((r) => r.token === "qa")?.invocations).toBe(3); // prior row survives
  });

  it("an adversarial producer's seen:[] does not prune a failed file's prior rows", async () => {
    // The producer's returned `seen` must not be the only thing protecting a failed file from
    // pruneVanished: even a producer that (wrongly, or just differently) omits attempted-but-failed
    // paths from its own `seen` must not cause the file's prior rows to be deleted. The batch
    // handler itself must add every processed path to `seen`, mirroring the inline branch.
    const a = join(dir, "a.jsonl"); write(a, "a", 1000);
    await index.syncUsage([a], "hd", () => usage([{ kind: "skill", token: "qa", invocations: 3 }]));
    write(a, "a-longer", 2000); // now changed, will be handed to the producer
    const adversarial: OffThreadParse = async (input, onBatch) => {
      await onBatch(input.changed.map((c) => ({
        path: c.path, mtime: c.mtime, size: c.size,
        usage: { raw: [], hooks: [], failed: true } as FileUsage,
      })));
      return { seen: [] }; // adversarial: does not report the failed path as seen
    };
    const out = await index.syncUsage([a], "hd", () => ({ raw: [], hooks: [], failed: true }), adversarial);
    expect(out.raw.find((r) => r.token === "qa")?.invocations).toBe(3); // prior row survives, not pruned
  });

  it("prunes files that vanished from paths", async () => {
    const a = join(dir, "a.jsonl"); const b = join(dir, "b.jsonl");
    write(a, "a"); write(b, "b");
    const parse = (_p: string) => usage([{ kind: "skill", token: "qa", invocations: 1 }]);
    await index.syncUsage([a, b], "hd", parse, fakeProducer(parse).p);
    rmSync(b);
    const out = await index.syncUsage([a], "hd", parse, fakeProducer(parse).p);
    expect(out.raw.every((r) => r.path === a)).toBe(true);
  });

  it("serializes an overlapping streamed + inline sync (shared single-flight chain)", async () => {
    // A single-file, single-batch overlap is toothless: node:sqlite writes are synchronous, and
    // the streamed producer's BEGIN..writeFileRows..COMMIT for one batch completes before its
    // first real suspension point, so plain single-threaded JS execution "serializes" the two
    // calls even with the chain removed. To actually exercise the single-flight guarantee, p1
    // must have a genuine suspension point (the `await setImmediate` between batches) that p2's
    // synchronous body could run inside of if the two calls were not chained. So p1 streams 3
    // files with batchSize 1 → 3 batches, 2 real setImmediate gaps between them.
    const a = join(dir, "a.jsonl"); const b = join(dir, "b.jsonl"); const c = join(dir, "c.jsonl");
    write(a, "a"); write(b, "b"); write(c, "c");
    const order: string[] = [];
    const slow = (p: string) => { order.push(`streamed-parse:${basename(p)}`); return usage([{ kind: "skill", token: "qa", invocations: 1 }]); };
    const prod = fakeProducer(slow, 1); // 3 files, batchSize 1 → 3 batches, 2 setImmediate gaps
    // Fire both without awaiting the first: the chain must run them one at a time. p2 uses a
    // different hookDigest so its planSync sees "a" as changed (needing reparse) even though p1
    // already synced it with the same mtime/size — otherwise p2 would see the file as already
    // up-to-date (since the chain makes p1 fully land before p2's planSync runs) and never call
    // its parse fn at all, which would defeat this test regardless of serialization.
    const p1 = index.syncUsage([a, b, c], "hd", slow, prod.p);
    const p2 = index.syncUsage([a], "hd2", (_p) => { order.push("inline-parse"); return usage([{ kind: "skill", token: "qa", invocations: 1 }]); });
    await Promise.all([p1, p2]);
    // Not interleaved: p1 (streamed) is issued first, so the single-flight chain must run it fully
    // to completion — all 3 batches, across their setImmediate gaps — before p2 (inline) starts.
    // Without the chain, p2's synchronous body runs during p1's first setImmediate gap (right
    // after "streamed-parse:a" lands but before "streamed-parse:b"/"streamed-parse:c"), so this
    // exact-sequence assertion is false under a chain-bypass regression.
    expect(order).toEqual(["streamed-parse:a.jsonl", "streamed-parse:b.jsonl", "streamed-parse:c.jsonl", "inline-parse"]);
    const out = await index.syncUsage([a], "hd", slow);
    expect(out.raw.find((r) => r.token === "qa")?.invocations).toBe(1); // consistent, not doubled
  });
});
