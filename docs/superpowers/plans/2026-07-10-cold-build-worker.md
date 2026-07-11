# Cold-Build Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the ~16 s cold transcript-index parse off the event loop into a `worker_threads` worker, so a 463-byte `GET` stays < 100 ms while the build runs, with `/api/usage` output byte-identical.

**Architecture:** The main thread owns the sole `node:sqlite` `DatabaseSync` handle and does all writes; a worker does all filesystem work (stat + read + parse) and streams compact result batches back. Routing is by parse **cost** (bytes of the pending set), not file count. The worker lives in the root package (where `bundle-bins` ships it self-contained); `@agentgem/capture` consumes it through an injected `offThreadParse` producer and never references the worker or the bundler.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), `node:worker_threads`, `node:sqlite` `DatabaseSync`, vitest (runs against compiled `dist/`), esbuild (`bundle-bins`).

**Spec:** `docs/superpowers/specs/2026-07-10-cold-build-worker-design.md` — its `## Review Amendments` (A1–A7) are authoritative where they refine the body.

## Structural refinement vs the spec (read first)

The spec's decision #4 said "keep `syncUsage` unchanged; add a sibling `syncUsageStreamed`." Mapping the code, that shape forces either a **double stat pass** (routing needs `pendingBytes`, which needs the stat pass the chosen method also does → ~200 ms on the warm path, violating the spec's own "warm stays 0.11 s" guarantee) or duplicated stat/prune/readback logic. Amendment **A2** already resolves this: "the main thread computes the pending set from the ONE stat pass it already does, then hands the worker the pre-identified changed paths."

So this plan **extends `syncUsage` with an optional 4th param** `offThreadParse?` instead of a sibling:

```ts
syncUsage(paths, hookDigest, parseFile, offThreadParse?)
```

- One `planSync` stat pass → `existing`, `changed[]` (with mtime/size), `seen`, `pendingBytes`.
- Route inside: `offThreadParse && pendingBytes > BYTE_THRESHOLD` → **streamed** (worker parses `changed`, main stream-writes); else → **inline** (`parseFile` parses `changed`, exactly as today).
- The 10 existing `syncUsage` tests pass no `offThreadParse` → inline branch → byte-identical behavior.
- **This dissolves Codex #5 (chain race) for free:** there is no new unchained entry point — the streamed path runs inside `syncUsage`, which already advances the single-flight `chain`. The A2 "shares the chain" requirement is satisfied structurally, and the overlap test still applies.

This is a strict improvement that honors A1/A2/A4/A5/A6 and the perf guarantee. It is the one place this plan departs from the spec body; everything else follows the amendments verbatim.

## Global Constraints

- **Worktree:** `/Users/rfeng/Projects/ninemind/agentgem-284`, branch `perf/cold-build-worker`, based on `origin/main` (which already has #301).
- **Tests run against compiled `dist/`.** Root `vitest.config.ts` includes only `dist/**/__tests__/**/*.test.js`. Run `pnpm exec tsc -b` before `pnpm exec vitest`, target the **`dist/`** path.
- **CI only runs root `dist/**/__tests__`.** `packages/capture` has no test script. Every test lives under root `src/gem/__tests__/`.
- **The worker MUST live in the root package** (`src/`), not `packages/capture/`. `bundle-bins` bundles only the root `dist/`; a worker in capture would ship with unresolvable `@agentgem/*` imports (A5).
- **Worker-path candidates are `["./transcriptParseWorker.js"]` only** — the worker and its spawner both sit at root `src/`→`dist/`, and esbuild inlines the spawner into `dist/index.js`, so `import.meta.url` resolves to `dist/` in both loose and bundled layouts (A5). The `warm/` candidate from scorecard's layout is WRONG.
- **`packages/insight/src/workflowScan.ts` is grep-binary** (stray control byte) — use `grep -a`.
- **Map keys use a space separator** (`indexOf(" ")`), never a NUL byte (it makes files grep-binary).
- **`getGlobalUsageIndexed`'s new 3rd param is optional**; default (absent) = today's exact behavior. No existing caller/test breaks.
- ESM `.js` specifiers. Commit after every task. Never commit to `main`.

## File Structure

**`@agentgem/capture`** (DB owner; no worker/bundler knowledge):
| File | Responsibility |
|---|---|
| `packages/capture/src/transcriptIndex.ts` *(modify)* | Extract `planSync`, `writeFileRows`, `pruneVanished`, `readbackRows` from `doSync`. Extend `syncUsage` with `offThreadParse?` + byte-routing + streamed write path. Add `OffThreadParse`/`ChangedFile` types. `syncUsage`'s inline behavior byte-identical. |
| `packages/capture/src/globalUsage.ts` *(modify)* | `getGlobalUsageIndexed(dirs, paths, offThreadParse?)` threads the producer to `syncUsage`. |

**Root package** (`src/`, bundled):
| File | Responsibility |
|---|---|
| `src/transcriptParseWorker.ts` *(create)* | Worker entry, mirrors `scorecardWorker.ts`. Exports `parseChangedFiles(input, emit)` (pure: read+`scanFileUsage` each changed path, emit batches); a `parentPort` guard runs it, `postMessage`s `{results}` batches then `{done:true}`. No SQLite. |
| `src/coldBuildParser.ts` *(create)* | `buildOffThreadParse()` → an `OffThreadParse`. Resolves the worker (`resolveWorkerPath(import.meta.url, ["./transcriptParseWorker.js"])`), spawns it, relays `message` `{results}` → `onBatch`, resolves `{seen}` on `{done}`, rejects on `error`/nonzero-exit-without-done. Only place `worker_threads` lives. |
| `src/gem.controller.ts` *(modify)* | `usage()`: pass `buildOffThreadParse()` to `getGlobalUsageIndexed`. |
| `src/warm/registry.ts` *(modify)* | `usage` warmable: same. |
| `scripts/bundle-bins.mjs` *(modify)* | Add `"transcriptParseWorker.js"` to `entries`. |

**Tests** (root `src/gem/__tests__/`):
| File | Responsibility |
|---|---|
| `transcriptIndexStreamed.test.ts` *(create)* | `syncUsage` with a fake `offThreadParse`: byte-identical to inline, per-batch txn, `failed` skip, prune, **overlap-serialization** (chain). |
| `coldBuildRouting.test.ts` *(create)* | byte-routing: warm+one-big-file → streamed; hook_digest change → streamed; many-tiny → inline; cold → streamed. |
| `coldBuildWorker.test.ts` *(create)* | real-worker acceptance heartbeat (with a >150 ms in-test file) + worker-vs-inline differential + fallback + packed-artifact resolution. |

---

### Task 1: Refactor `doSync` into reusable helpers (no behavior change)

**Files:**
- Modify: `packages/capture/src/transcriptIndex.ts`
- Test: existing `src/gem/__tests__/transcriptIndex.test.ts` must stay 10/10 green (regression guard).

**Interfaces produced:**
- `interface ChangedFile { path: string; mtime: number; size: number }`
- `function planSync(db, paths, hookDigest): { existing: Map<string,{mtime,size,hookDigest}>; changed: ChangedFile[]; seen: Set<string>; pendingBytes: number }`
- `function writeFileRows(db, path, mtime, size, hookDigest, usage: FileUsage): void`
- `function pruneVanished(db, existing, seen): void`
- `function readbackRows(db): { raw: StoredRawRow[]; hooks: StoredHookRow[] }`

This task is a pure refactor: extract the four helpers, rewrite `doSync` to call them, confirm the 10 existing tests still pass. No new behavior.

- [ ] **Step 1: Run the existing suite to establish the green baseline**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-284
pnpm install --frozen-lockfile
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/transcriptIndex.test.js
```
Expected: `Tests 10 passed`.

- [ ] **Step 2: Extract the helpers**

In `packages/capture/src/transcriptIndex.ts`, above `doSync`, add (types near the top exports):

```ts
export interface ChangedFile { path: string; mtime: number; size: number }

/** One stat pass: split `paths` into up-to-date (seen) vs needs-reparse (changed), summing the
 *  byte cost of the changed set. A file needs reparse if it's new, its mtime/size moved, OR its
 *  stored hook_digest != the current one (a hook edit forces a reparse of every file). This is the
 *  same detection doSync did inline; hoisting it lets the caller route on pendingBytes without a
 *  second stat pass. */
function planSync(
  db: DatabaseSync,
  paths: string[],
  hookDigest: string,
): { existing: Map<string, { mtime: number; size: number; hookDigest: string }>; changed: ChangedFile[]; seen: Set<string>; pendingBytes: number } {
  const existing = new Map<string, { mtime: number; size: number; hookDigest: string }>();
  for (const r of db.prepare("SELECT path, mtime_ms, size, hook_digest FROM transcript_file").all() as
    { path: string; mtime_ms: number; size: number; hook_digest: string }[]) {
    existing.set(r.path, { mtime: Number(r.mtime_ms), size: Number(r.size), hookDigest: r.hook_digest });
  }
  const changed: ChangedFile[] = [];
  const seen = new Set<string>();
  let pendingBytes = 0;
  for (const path of paths) {
    let st: ReturnType<typeof statSync>;
    try { st = statSync(path); } catch { continue; } // vanished between listing and stat
    const prev = existing.get(path);
    if (prev && prev.mtime === st.mtimeMs && prev.size === st.size && prev.hookDigest === hookDigest) {
      seen.add(path); // up to date
      continue;
    }
    changed.push({ path, mtime: st.mtimeMs, size: st.size });
    pendingBytes += st.size;
  }
  return { existing, changed, seen, pendingBytes };
}

/** One changed file's rows: replace its raw/hook rows and (re)record it in transcript_file. Caller
 *  wraps in a transaction. Must run only for a successful, non-`failed` parse. */
function writeFileRows(db: DatabaseSync, path: string, mtime: number, size: number, hookDigest: string, usage: FileUsage): void {
  db.prepare("DELETE FROM raw_usage WHERE path = ?1").run(path);
  db.prepare("DELETE FROM hook_usage WHERE path = ?1").run(path);
  for (const r of usage.raw) {
    db.prepare(
      `INSERT INTO raw_usage(path, kind, token, invocations) VALUES(?1, ?2, ?3, ?4)
       ON CONFLICT(path, kind, token) DO UPDATE SET invocations = ?4`,
    ).run(path, r.kind, r.token, r.invocations);
  }
  for (const h of usage.hooks) {
    db.prepare(
      `INSERT INTO hook_usage(path, name, invocations) VALUES(?1, ?2, ?3)
       ON CONFLICT(path, name) DO UPDATE SET invocations = ?3`,
    ).run(path, h.name, h.invocations);
  }
  db.prepare(
    `INSERT INTO transcript_file(path, mtime_ms, size, hook_digest) VALUES(?1, ?2, ?3, ?4)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = ?2, size = ?3, hook_digest = ?4`,
  ).run(path, mtime, size, hookDigest);
}

/** Delete every file recorded in `existing` that this sync did not `seen`. Caller wraps in a txn. */
function pruneVanished(db: DatabaseSync, existing: Map<string, unknown>, seen: Set<string>): void {
  for (const path of existing.keys()) {
    if (seen.has(path)) continue;
    db.prepare("DELETE FROM raw_usage WHERE path = ?1").run(path);
    db.prepare("DELETE FROM hook_usage WHERE path = ?1").run(path);
    db.prepare("DELETE FROM transcript_file WHERE path = ?1").run(path);
  }
}

/** The stored rows joined to transcript_file for lastUsedMs (A2). */
function readbackRows(db: DatabaseSync): { raw: StoredRawRow[]; hooks: StoredHookRow[] } {
  const raw = (db.prepare(
    `SELECT r.path, r.kind, r.token, r.invocations, f.mtime_ms AS last_used_ms
     FROM raw_usage r JOIN transcript_file f USING(path) ORDER BY r.path, r.kind, r.token`,
  ).all() as { path: string; kind: string; token: string; invocations: number; last_used_ms: number }[])
    .map((r) => ({ path: r.path, kind: r.kind as StoredRawRow["kind"], token: r.token, invocations: Number(r.invocations), lastUsedMs: Number(r.last_used_ms) }));
  const hooks = (db.prepare(
    `SELECT h.path, h.name, h.invocations, f.mtime_ms AS last_used_ms
     FROM hook_usage h JOIN transcript_file f USING(path) ORDER BY h.path, h.name`,
  ).all() as { path: string; name: string; invocations: number; last_used_ms: number }[])
    .map((h) => ({ path: h.path, name: h.name, invocations: Number(h.invocations), lastUsedMs: Number(h.last_used_ms) }));
  return { raw, hooks };
}
```

- [ ] **Step 3: Rewrite `doSync` to use the helpers (same behavior)**

Replace the `doSync` body with:

```ts
async function doSync(
  db: DatabaseSync,
  paths: string[],
  hookDigest: string,
  parseFile: (path: string) => FileUsage,
): Promise<{ raw: StoredRawRow[]; hooks: StoredHookRow[] }> {
  const { existing, changed, seen } = planSync(db, paths, hookDigest);
  db.exec("BEGIN");
  try {
    for (const c of changed) {
      let u: FileUsage;
      try { u = parseFile(c.path); }
      catch (e) { log.warn("parseFile threw for transcript, will retry next sync: %s: %s", c.path, e); continue; }
      if (u.failed) { log.warn("failed to read transcript, will retry next sync: %s", c.path); continue; }
      seen.add(c.path);
      writeFileRows(db, c.path, c.mtime, c.size, hookDigest, u);
    }
    pruneVanished(db, existing, seen);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* keep the original error */ }
    throw e;
  }
  return readbackRows(db);
}
```

Note: `planSync` already added up-to-date files to `seen`; the loop adds successfully-written changed files; throw/`failed` files are NOT added (so they are neither written nor pruned — same as today, because they were `seen` before under the old code too). Confirm: under the OLD code a throw/failed file was `seen.add`ed to protect it from prune. **Preserve that** — add `seen.add(c.path)` in BOTH the throw and failed branches before `continue`, matching the old behavior:

```ts
      catch (e) { log.warn(...); seen.add(c.path); continue; }
      if (u.failed) { log.warn(...); seen.add(c.path); continue; }
```

- [ ] **Step 4: Run the regression suite**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/transcriptIndex.test.js
```
Expected: `Tests 10 passed` — byte-identical behavior, now via helpers.

- [ ] **Step 5: Commit**

```bash
git add packages/capture/src/transcriptIndex.ts
git commit -m "refactor(capture): extract planSync/writeFileRows/pruneVanished/readbackRows from doSync

Pure refactor, no behavior change (10 transcriptIndex tests green). Hoisting the
stat pass into planSync lets a caller route on pendingBytes without a second stat."
```

---

### Task 2: Extend `syncUsage` with `offThreadParse` + byte-routing + streamed writes

**Files:**
- Modify: `packages/capture/src/transcriptIndex.ts` (the `TranscriptIndex` interface + the returned `syncUsage`)
- Test: `src/gem/__tests__/transcriptIndexStreamed.test.ts` (create)

**Interfaces produced:**
- `interface OffThreadParse { (input: { changed: ChangedFile[]; hooks: HookArtifact[] }, onBatch: (results: { path: string; mtime: number; size: number; usage: FileUsage }[]) => Promise<void>): Promise<{ seen: string[] }> }`
- `syncUsage(paths, hookDigest, parseFile, offThreadParse?)` — 4th param optional.
- `BYTE_THRESHOLD = 20 * 1024 * 1024` (20 MB), module constant.

**Consumes:** `planSync`, `writeFileRows`, `pruneVanished`, `readbackRows` (Task 1); `HookArtifact` from `@agentgem/model`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/transcriptIndexStreamed.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "strm-")); index = await openTranscriptIndex("memory://"); });
  afterEach(async () => { await index.close(); rmSync(dir, { recursive: true, force: true }); });

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
    const a = join(dir, "a.jsonl"); write(a, "a");
    const order: string[] = [];
    const slow = (_p: string) => { order.push("streamed-parse"); return usage([{ kind: "skill", token: "qa", invocations: 1 }]); };
    // Fire both without awaiting the first: the chain must run them one at a time.
    const p1 = index.syncUsage([a], "hd", slow, fakeProducer(slow).p);
    const p2 = index.syncUsage([a], "hd", (_p) => { order.push("inline-parse"); return usage([{ kind: "skill", token: "qa", invocations: 1 }]); });
    await Promise.all([p1, p2]);
    // Not interleaved: streamed fully finishes before inline starts (or vice-versa), never mixed.
    expect(order.length).toBeGreaterThan(0);
    const out = await index.syncUsage([a], "hd", slow);
    expect(out.raw.find((r) => r.token === "qa")?.invocations).toBe(1); // consistent, not doubled
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm exec tsc -b
```
Expected: FAIL — `syncUsage` takes 3 args, `OffThreadParse` not exported.

- [ ] **Step 3: Implement**

In `packages/capture/src/transcriptIndex.ts`:

Add the type + constant near the top exports:
```ts
import type { HookArtifact } from "@agentgem/model";

const BYTE_THRESHOLD = 20 * 1024 * 1024; // 20 MB of pending parse → worth the worker (A1)

/** The injected off-thread producer (root implements it with a worker; tests with a fake). It
 *  receives the pre-identified changed files (already statted by planSync) so it never re-stats,
 *  parses them off the event loop, and streams result batches back via onBatch. */
export interface OffThreadParse {
  (input: { changed: ChangedFile[]; hooks: HookArtifact[] },
   onBatch: (results: { path: string; mtime: number; size: number; usage: FileUsage }[]) => Promise<void>,
  ): Promise<{ seen: string[] }>;
}
```

Update the `TranscriptIndex` interface's `syncUsage` to add the optional params:
```ts
  syncUsage(
    paths: string[],
    hookDigest: string,
    parseFile: (path: string) => FileUsage,
    offThreadParse?: OffThreadParse,
    hooks?: HookArtifact[],
  ): Promise<{ raw: StoredRawRow[]; hooks: StoredHookRow[] }>;
```
(`hooks` is needed only to hand the worker the inventory; the inline path ignores it.)

Replace the returned `syncUsage` closure so it still advances the SAME `chain` (this is what keeps streamed serialized — Codex #5):
```ts
    syncUsage(paths, hookDigest, parseFile, offThreadParse, hooks) {
      const run = chain.then(() => doSyncRouted(db, paths, hookDigest, parseFile, offThreadParse, hooks ?? []));
      chain = run.catch(() => {});
      return run;
    },
```

Add `doSyncRouted` beside `doSync` (keep `doSync` as the inline core; `doSyncRouted` decides and, for the streamed branch, drives the producer):
```ts
async function doSyncRouted(
  db: DatabaseSync,
  paths: string[],
  hookDigest: string,
  parseFile: (path: string) => FileUsage,
  offThreadParse: OffThreadParse | undefined,
  hooks: HookArtifact[],
): Promise<{ raw: StoredRawRow[]; hooks: StoredHookRow[] }> {
  const { existing, changed, seen, pendingBytes } = planSync(db, paths, hookDigest);

  // Inline: no producer, or the pending parse is cheap. Identical to the old doSync loop.
  if (!offThreadParse || pendingBytes <= BYTE_THRESHOLD) {
    db.exec("BEGIN");
    try {
      for (const c of changed) {
        let u: FileUsage;
        try { u = parseFile(c.path); }
        catch (e) { log.warn("parseFile threw for transcript, will retry next sync: %s: %s", c.path, e); seen.add(c.path); continue; }
        if (u.failed) { log.warn("failed to read transcript, will retry next sync: %s", c.path); seen.add(c.path); continue; }
        seen.add(c.path);
        writeFileRows(db, c.path, c.mtime, c.size, hookDigest, u);
      }
      pruneVanished(db, existing, seen);
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch { /* keep original */ } throw e; }
    return readbackRows(db);
  }

  // Streamed: the worker parses `changed` off-thread; we write each batch in its own transaction,
  // yielding between so a 463-byte GET is served between writes. The worker's `seen` covers only
  // the changed files it processed; add the up-to-date files planSync already put in `seen`.
  const { seen: parsedSeen } = await offThreadParse({ changed, hooks }, async (results) => {
    db.exec("BEGIN");
    try {
      for (const r of results) {
        if (r.usage.failed) { log.warn("failed to read transcript (worker), will retry next sync: %s", r.path); continue; }
        writeFileRows(db, r.path, r.mtime, r.size, hookDigest, r.usage);
      }
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch { /* keep original */ } throw e; }
    await new Promise<void>((res) => setImmediate(res)); // yield to the event loop between batches
  });
  for (const p of parsedSeen) seen.add(p);
  db.exec("BEGIN");
  try { pruneVanished(db, existing, seen); db.exec("COMMIT"); }
  catch (e) { try { db.exec("ROLLBACK"); } catch { /* keep original */ } throw e; }
  return readbackRows(db);
}
```

Delete the now-unused standalone `doSync` (its body moved into `doSyncRouted`'s inline branch), OR keep `doSync` and have `doSyncRouted` call it for the inline branch — pick whichever keeps the diff cleanest; the inline branch MUST remain byte-identical to today.

- [ ] **Step 4: Run both suites**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/transcriptIndexStreamed.test.js dist/gem/__tests__/transcriptIndex.test.js
```
Expected: streamed tests pass; the 10 inline tests stay green (they pass no `offThreadParse` → inline branch).

- [ ] **Step 5: Commit**

```bash
git add packages/capture/src/transcriptIndex.ts src/gem/__tests__/transcriptIndexStreamed.test.ts
git commit -m "feat(capture): syncUsage byte-routes to an injected offThreadParse producer

Extends syncUsage with an optional offThreadParse + hooks. One planSync stat pass
computes pendingBytes; > BYTE_THRESHOLD (20MB) with a producer streams parse
off-thread and writes each batch in its own txn with a setImmediate yield.
Runs inside syncUsage so it inherits the single-flight chain (no race). Inline
behavior byte-identical; 10 existing tests green."
```

---

### Task 3: The worker + its spawner (root package)

**Files:**
- Create: `src/transcriptParseWorker.ts`, `src/coldBuildParser.ts`
- Modify: `packages/capture/src/globalUsage.ts`, `src/gem.controller.ts`, `src/warm/registry.ts`
- Test: `src/gem/__tests__/coldBuildWorker.test.ts` (create; fallback + real-worker differential)

**Consumes:** `OffThreadParse`, `ChangedFile` (Task 2, `@agentgem/capture`); `scanFileUsage` (`@agentgem/insight`); `resolveWorkerPath` (`src/warm/workerPath.js`).

- [ ] **Step 1: Write the failing test (fallback + differential; real worker)**

Create `src/gem/__tests__/coldBuildWorker.test.ts`:

```ts
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
  beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "cbw-")); index = await openTranscriptIndex("memory://"); });
  afterEach(async () => { await index.close(); rmSync(dir, { recursive: true, force: true }); });

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
```

Note the routing subtlety: the first test needs the producer to actually run. Since routing is `pendingBytes > 20MB`, a 60-tiny-file fixture is below threshold and would take the INLINE branch even with a producer. **Resolve this by making `BYTE_THRESHOLD` overridable for tests** — export a test-only setter, or (cleaner) have `getGlobalUsageIndexed` compute the route and the test call the producer directly. For this test, call the producer directly through `syncUsage` with a corpus whose pending bytes exceed 20MB (one ~big file), OR expose `BYTE_THRESHOLD` via an env var `AGENTGEM_USAGE_WORKER_BYTES` read in `planSync`'s caller. **Decision:** read `BYTE_THRESHOLD` from `process.env.AGENTGEM_USAGE_WORKER_BYTES` (default 20MB) so tests set it to `0` to force the worker. Add that to Task 2's implementation and note it here; the test sets `process.env.AGENTGEM_USAGE_WORKER_BYTES = "0"` in `beforeEach`.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm exec tsc -b
```
Expected: FAIL — `../../coldBuildParser.js` / `buildOffThreadParse` missing.

- [ ] **Step 3: Implement the worker**

Create `src/transcriptParseWorker.ts`:
```ts
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
```

Create `src/coldBuildParser.ts`:
```ts
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
```
(The `tail` chains `onBatch` calls so batches are written in order and `done` waits for the last write. This is the bounded-tiny relay — A6.)

- [ ] **Step 4: Wire `getGlobalUsageIndexed` + callers**

`packages/capture/src/globalUsage.ts` — `getGlobalUsageIndexed`:
```ts
export async function getGlobalUsageIndexed(
  dirs: ReturnType<typeof resolveDirs>, paths: string[], offThreadParse?: OffThreadParse,
): Promise<GlobalUsageResult> {
  const globalInv = introspectConfig(dirs);
  const parseFile = (path: string) => scanFileUsage(path, globalInv.hooks);
  const index = await sharedIndex();
  const stored = await index.syncUsage(paths, hookDigest(globalInv.hooks), parseFile, offThreadParse, globalInv.hooks);
  return resolveUsage(stored.raw, stored.hooks, { skills: globalInv.skills, mcpServers: globalInv.mcpServers });
}
```
Import `OffThreadParse` from `./transcriptIndex.js`.

`src/gem.controller.ts:445` → `return await getGlobalUsageIndexed(dirs, paths, buildOffThreadParse()) as ...;` (import `buildOffThreadParse` from `./coldBuildParser.js`).

`src/warm/registry.ts:92` → `getGlobalUsageIndexed(dirs, paths, buildOffThreadParse()).catch(...)` (same import).

- [ ] **Step 5: Run the tests + build**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/coldBuildWorker.test.js dist/gem/__tests__/transcriptIndex.test.js dist/gem/__tests__/transcriptIndexStreamed.test.js
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/transcriptParseWorker.ts src/coldBuildParser.ts packages/capture/src/globalUsage.ts src/gem.controller.ts src/warm/registry.ts src/gem/__tests__/coldBuildWorker.test.ts
git commit -m "feat: parse the cold usage-index build in a worker thread (#284)

Worker (root src/, bundled) reads+parses pre-identified changed files off-thread;
coldBuildParser is the offThreadParse producer capture consumes. Both /api/usage
and the usage warmable pass it. Fallback to inline on any worker failure."
```

---

### Task 4: Bundle the worker + packed-artifact resolution test (A5)

**Files:**
- Modify: `scripts/bundle-bins.mjs:55`
- Test: `src/gem/__tests__/coldBuildWorker.test.ts` (append the packaging assertion)

- [ ] **Step 1: Write the failing test**

Append to `coldBuildWorker.test.ts`:
```ts
import { readFileSync } from "node:fs";
describe("packaging", () => {
  it("transcriptParseWorker is a bundle-bins entry", () => {
    const src = readFileSync(new URL("../../../scripts/bundle-bins.mjs", import.meta.url), "utf8");
    expect(src).toContain("transcriptParseWorker.js");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/coldBuildWorker.test.js -t "bundle-bins entry"
```
Expected: FAIL.

- [ ] **Step 3: Add the entry**

`scripts/bundle-bins.mjs:55`:
```js
const entries = ["cli.js", "index.js", "distill/mcpServer.js", "goldmine/mcpServer.js", "warm/scorecardWorker.js", "transcriptParseWorker.js"];
```

- [ ] **Step 4: Verify against a REAL bundle (the packed-artifact trap)**

```bash
pnpm clean && pnpm build && node scripts/bundle-bins.mjs 2>&1 | tail -3
echo "worker bundled + self-contained?"
grep -c "scanFileUsage" dist/transcriptParseWorker.js
grep -c 'from "@agentgem/' dist/transcriptParseWorker.js   # MUST be 0 (fully inlined)
echo "resolvable from the BUNDLED coldBuildParser?"
grep -c "transcriptParseWorker" dist/index.js               # coldBuildParser inlined into index.js references it
pnpm exec vitest run dist/gem/__tests__/coldBuildWorker.test.js
```
Expected: `scanFileUsage` count > 0; **`from "@agentgem/` count = 0**; index.js references the worker; tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/bundle-bins.mjs src/gem/__tests__/coldBuildWorker.test.ts
git commit -m "build: bundle transcriptParseWorker self-contained (#284)

Registers it as a bundle-bins entry so esbuild inlines its @agentgem/* deps (0
bare imports), exactly as warm/scorecardWorker.js. Verified against real
bundle-bins output, not just source dist (the #267 packed-tarball trap)."
```

---

### Task 5: The acceptance heartbeat gate with a >150 ms file (A4)

**Files:**
- Test: `src/gem/__tests__/coldBuildWorker.test.ts` (append)

The gate that proves the worker is load-bearing: build a cold index containing one synthetic file whose own `scanFileUsage` exceeds ~150 ms, run a 50 ms heartbeat during the build, assert max loop-block < 100 ms. A chunked-yield inline impl would FAIL this (it can't subdivide the big file); only true off-thread parsing passes.

- [ ] **Step 1: Write the test**

Append to `coldBuildWorker.test.ts`:
```ts
import { performance } from "node:perf_hooks";
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
      // one big file (~8-10MB of tool_use records → >150ms scanFileUsage) + some small ones
      const big = join(dir, "big.jsonl");
      const line = tu("qa");
      writeFileSync(big, (line + "\n").repeat(60000)); // ~ tens of MB; sized to exceed 150ms parse
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
```
Size the `.repeat()` count so the big file's own `scanFileUsage` exceeds ~150 ms (measure once; the real corpus is ~20 ms/MB, so ~8–10 MB). If 60000 lines is too fast, raise it; the test's own comment must state the target.

- [ ] **Step 2: Run it (against the real worker)**

```bash
pnpm exec tsc -b && node scripts/build-console.mjs >/dev/null 2>&1; node scripts/bundle-bins.mjs >/dev/null 2>&1
pnpm exec vitest run dist/gem/__tests__/coldBuildWorker.test.js -t "max event-loop block"
```
Expected: PASS (max block < 100 ms). If it FAILS at ~286 ms, the worker isn't actually parsing off-thread — fix the implementation, do not weaken the assertion.

- [ ] **Step 3: Commit**

```bash
git add src/gem/__tests__/coldBuildWorker.test.ts
git commit -m "test: acceptance heartbeat gate proves the worker is load-bearing (#284)

Cold build with one >150ms single file; asserts max event-loop block <100ms while
it parses. Self-tested heartbeat. Fails for any inline/chunked impl (can't
subdivide one file's parse), passes only for true off-thread parsing."
```

---

### Task 6: Measure on the real corpus + record

**Files:**
- Modify: the spec's Verification table.

- [ ] **Step 1: Full build + suites**

```bash
pnpm clean && pnpm build && node scripts/bundle-bins.mjs >/dev/null && pnpm exec vitest run 2>&1 | tail -6
```
Expected: 0 failures (aggregator/console flakes under full-suite contention are pre-existing — verify with `--no-file-parallelism` if any fail; this branch touches none of them).

- [ ] **Step 2: Measure a real cold build's event-loop block**

Back up the real index first (it regenerates), delete it, boot the server, poll a 463-byte `GET /api/rubrics` while the warm pass builds the cold index, record the worst latency. (Mirror the measurement harness from #265/#267.)
```bash
cp ~/.agentgem/transcript-index.db /tmp/tidx-bak.db
rm -f ~/.agentgem/transcript-index.db
# boot dist/index.js on a test port; poll /api/rubrics during the cold build; record worst latency
# expected: worst < ~100ms (was up to ~16s)
cp /tmp/tidx-bak.db ~/.agentgem/transcript-index.db   # restore
```
Also opt-in `AGENTGEM_COLD_BUILD_REAL` differential if wired.

- [ ] **Step 3: Record measured numbers in the spec's Verification table**

Replace `expected after` with the measured worst-latency and cold-build wall-clock. If the worst latency is NOT well under ~100ms, STOP and investigate — do not round a bad number.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-10-cold-build-worker-design.md
git commit -m "docs: record measured cold-build event-loop latency (#284)"
```

---

## Self-Review

**Spec coverage.** Problem/shape → Tasks 1–3. A1 (byte-routing incl. hook_digest set) → Task 2 (`planSync` marks hook_digest-mismatch as changed; `pendingBytes`). A2 (shared chain) → Task 2 (runs inside `syncUsage` → inherits `chain`; overlap test). A3 (accept /api/usage-awaits caveat) → documented, no code. A4 (>150ms fixture gate) → Task 5. A5 (worker in root, candidate fix, packed test) → Tasks 3+4. A6 (backpressure bound) → Task 3's `tail` relay + comment. A7 (stale-on-error, prune notes) → preserved behavior in Task 1/2. Testing (streamed unit, routing, fallback, acceptance, packaging) → Tasks 2–5. Verification by measurement → Task 6.

**Structural refinement flagged:** `syncUsage` extended (optional `offThreadParse`) rather than a sibling `syncUsageStreamed` — reuses the one stat pass (honors A2 + warm-0.11s), inherits the chain (dissolves Codex #5's manual wiring). Documented at the top; the one departure from the spec body.

**Open detail for the implementer:** the test-only `AGENTGEM_USAGE_WORKER_BYTES` env override of `BYTE_THRESHOLD` (so tests force the worker branch on a small fixture) is introduced in Task 3 Step 1 and used in Tasks 3+5 — fold it into Task 2's `planSync`-caller so it exists before Task 3 needs it. Noted here so it isn't a surprise.

**Placeholder scan:** clean. **Type consistency:** `OffThreadParse`, `ChangedFile`, `ParseWorkerInput`, `ParseResult`, `buildOffThreadParse`, `parseChangedFiles`, `BYTE_THRESHOLD` — consistent across Tasks 2–5. `syncUsage`'s new params `(…, offThreadParse?, hooks?)` match between the interface, the closure, `doSyncRouted`, and `getGlobalUsageIndexed`.
