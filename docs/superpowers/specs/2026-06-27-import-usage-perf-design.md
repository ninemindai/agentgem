# Import-view usage: loading state + stale-while-revalidate scan

Date: 2026-06-27
Status: Approved (design)
Builds on: `2026-06-27-import-view-usage-design.md` (the Import-view usage feature, merged at `1941a27`)

## Problem

Opening the Import modal triggers `GET /api/usage?scope=global`, which scans **all** Claude
transcripts. On a real machine that's **~2,999 transcripts → ~4s cold**. The token-keyed cache
(`count + newest-mtime`) barely helps an active user: every new Claude session changes the token, so
the cache misses and most opens pay the full ~4s scan. During that window the Import modal shows the
full artifact list **unbadged and unfiltered** with **no loading indicator** (the `impUsageLoaded`
no-flash gate shows everything until usage lands) — so it reads as "Import isn't working."

Measured on this machine: 2,999 transcripts; scan calls timed 4.37s, 3.15s, then 0.01s (one cache
hit before the token moved again). Badges appeared in the live modal at ~4.5s after open.

## Goals

1. **Make the wait visible** — the Import modal clearly shows usage is loading, so a slow scan never
   looks like a dead feature.
2. **Make opens feel instant after the first** — serve the last known result immediately and refresh
   in the background (stale-while-revalidate), so an active user no longer waits ~4s every open.

## Decisions (locked)

- **Faster scan = stale-while-revalidate (SWR)**, not incremental per-file caching.
- Loading indicator is **Import-only** for now (the ledger's per-project scan is small/fast; not worth
  touching its `decorateUsage` in this change).
- Staleness is acceptable: counts may trail by ~1 session — fine for a usage-discovery view.

## Design

### Part 1 — Backend: stale-while-revalidate `scope=global`

**Factor the scan into a pure, testable function** — new `src/gem/globalUsage.ts`:

```ts
import { introspectConfig } from "./introspect.js";
import { scanWorkflow } from "./workflowScan.js";
import type { resolveDirs } from "../resolveDir.js";

export interface GlobalUsageResult { artifacts: { type: string; name: string; root: null; invocations: number; sessionsUsedIn: number; lastUsedMs: number | null }[] }

/** Scan the given transcripts against an empty project so every resolved call attributes to a global. */
export function computeGlobalUsage(dirs: ReturnType<typeof resolveDirs>, paths: string[]): GlobalUsageResult {
  const globalInv = introspectConfig(dirs);
  const emptyProject = { root: "", name: "", skills: [], mcpServers: [], instructions: [], hooks: [] };
  const scanInv = { project: emptyProject, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
  const signal = scanWorkflow(paths, scanInv);
  return { artifacts: signal.artifacts
    .filter((a) => a.root === null)
    .map((a) => ({ type: a.type, name: a.name, root: a.root as null, invocations: a.invocations, sessionsUsedIn: a.sessionsUsedIn, lastUsedMs: a.lastUsedMs })) };
}
```

**Add a stale read** to `src/gem/usageCache.ts` (keep `readGlobalUsageCache(token)` / `writeGlobalUsageCache` as-is):

```ts
/** The stored result regardless of token (for stale-while-revalidate). null if no cache file. */
export function readGlobalUsageCacheStale(): { artifacts: unknown[] } | null {
  try {
    const j = JSON.parse(readFileSync(cachePath(), "utf8")) as { result?: { artifacts: unknown[] } };
    return j && j.result ? j.result : null;
  } catch { return null; }
}
```

**Rewrite the global branch** in `src/gem.controller.ts` (`usage()`), with a module-level single-flight
guard so repeated opens don't pile up concurrent rescans:

```ts
// module scope (top of gem.controller.ts), one guard:
let globalUsageRefreshing = false;

// inside usage(), replacing the current scope==="global" block:
if (input.query.scope === "global") {
  const dirs = resolveDirs(input.query.dir);
  const paths = allClaudeTranscripts(dirs.claudeDir);
  const token = transcriptToken(paths);
  const exact = readGlobalUsageCache(token);
  if (exact) return exact as z.infer<typeof UsageSchema>;
  const stale = readGlobalUsageCacheStale();
  if (stale) {
    // serve stale immediately; refresh in the background (single-flight, best-effort)
    if (!globalUsageRefreshing) {
      globalUsageRefreshing = true;
      void Promise.resolve().then(() => {
        try { writeGlobalUsageCache(token, computeGlobalUsage(dirs, paths)); }
        catch (e) { console.error("[usage] bg refresh failed:", e); }
        finally { globalUsageRefreshing = false; }
      });
    }
    return stale as z.infer<typeof UsageSchema>;
  }
  // first-ever scan (no cache at all): block once, then cache
  const result = computeGlobalUsage(dirs, paths);
  writeGlobalUsageCache(token, result);
  return result;
}
```

**Tradeoff (documented, accepted):** the background refresh runs `scanWorkflow` synchronously on the
event loop when the microtask fires, so the server is busy ~4s *after* the response returns. For a
local single-user tool that's acceptable — the user-facing Import latency is gone, and a worker-thread
scan would be over-engineering here. The single-flight guard prevents stacking refreshes.

### Part 2 — Frontend: loading indicator in the Import modal

In `src/public/index.html`:

- Add a loading element to the import control bar (next to the sort buttons / Used-only):
  `<span id="impLoading" class="d" hidden>Loading usage…</span>`.
- In `openImport()`, wrap the usage decoration so the indicator shows during the scan:
  ```js
  document.getElementById("impLoading").hidden = false;
  document.querySelectorAll("#importModal .bar .sortbtn, #impUsedOnly").forEach(el => el.disabled = true);
  await decorateImportUsage();
  document.getElementById("impLoading").hidden = true;
  document.querySelectorAll("#importModal .bar .sortbtn, #impUsedOnly").forEach(el => el.disabled = false);
  ```
  (`decorateImportUsage` already sets `impUsageLoaded` and runs sort+filter at its end, so on hide the
  list is correctly badged/filtered.) With SWR the fetch usually returns instantly, so the indicator
  just flashes; on the first-ever scan it stays visible for the ~4s — exactly when it's needed.
- `.sortbtn:disabled,#impUsedOnly:disabled` styling: add `opacity:.5;cursor:default` so the disabled
  controls read as "not yet ready".

## Data flow

```
openImport()
  ├─ show "Loading usage…", disable controls
  ├─ decorateImportUsage() → GET /api/usage?scope=global
  │     ├─ exact-token cache hit → return immediately
  │     ├─ stale cache present   → return stale NOW + background rescan (single-flight)
  │     └─ no cache at all       → blocking scan once, cache, return
  └─ hide indicator, re-enable controls  (list now badged + filtered)
```

## Error handling

- Endpoint stays best-effort: the whole `usage()` body is wrapped in `try/catch → { artifacts: [] }`.
- Background refresh is fully guarded (`try/catch` + `finally` clears the flag); a failed refresh logs
  and leaves the prior cache intact.
- `readGlobalUsageCacheStale` swallows IO/parse errors → `null` (treated as "no cache", falls through
  to a blocking first scan).
- Frontend: `decorateImportUsage` already catches fetch failure (`artifacts = []`); the `finally`-style
  hide of the indicator must run even if the fetch rejects — wrap in try/finally so the indicator never
  sticks on.

## Testing

Backend (vitest):
- `computeGlobalUsage(dirs, paths)` returns global artifacts only (root null), aggregating across
  multiple project transcripts (reuse the `usageGlobal.test.ts` fixture shape).
- `readGlobalUsageCacheStale()` returns the stored result for a NON-matching token (the SWR contract),
  and `null` when no cache file exists. (Isolate via `AGENTGEM_HOME`.)
- Endpoint SWR behavior: prime the cache with a known result under token T1 (`writeGlobalUsageCache`);
  call `usage({query:{scope:"global",dir}})` when the real transcripts yield a different token T2 → the
  response equals the primed (stale) result, served synchronously (no ~4s wait). (The background refresh
  is fire-and-forget; assert the synchronous stale-serve, not the async write timing.)
- First-ever (no cache) still computes + returns + writes.
- Existing per-project `/api/usage` and the `usageGlobal`/`usageCache` tests stay green.

Frontend (`index.html` inline JS — no harness, consistent with prior work): verified by `pnpm build`
+ manual Import open (indicator shows during scan, clears with badges/filter; controls disabled while
loading). Keep `computeGlobalUsage` pure so the risky logic is server-side and unit-tested.

## Out of scope

- Incremental per-file caching (approach B) — not chosen.
- A loading indicator on the main ledger (`decorateUsage`) — per-project scans are small; revisit only
  if it proves slow.
- Worker-thread / off-event-loop scanning — over-engineering for a local single-user tool.
- Codex/multi-flavor scanning — still its own separate fast-follow.
```
