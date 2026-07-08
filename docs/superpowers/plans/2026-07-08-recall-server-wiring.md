# Recall Server Wiring (Plan 2 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Expose the merged `@agentgem/recall` library over the local server — a `search_session_content` MCP tool, `/api/recall/*` REST+SSE routes (instant search + the capped funnel job), a `recall` Warmable that keeps the on-disk index fresh, and streaming LLM synthesis — so Plan 3's `#/recall` panel has a backend.

**Architecture:** The index is on-disk `node:sqlite` (WAL), so multiple processes share it safely: the **`recall` warmable** is the lone (warm-lock-serialized) **writer** (`syncRecallIndex`), while the **routes** (boot-opened read handle) and the **MCP subprocess** (`search_session_content`, opens its own read handle) are **readers**. The funnel routes mirror `chatRoutes.ts`' SSE pattern; streaming synthesis reuses the insight ACP seam (`promptText(prompt, onDelta)`).

**Tech Stack:** TypeScript ESM (Node ≥24), `@agentback/mcp` (`@tool`), duck-typed Express, `@agentgem/recall`, `@agentgem/insight` (`askSession`, `scanSessionsCached`, `loadSessionTranscript`, the ACP connect seam), `vitest`.

**Depends on:** #210 (recall package, merged). Independent of #213.

## Global Constraints

- Node ≥24 ESM; relative imports use `.js`. 2-line SPDX header on every source file:
  `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT`
- **Privacy boundary unchanged:** search is lexical over the scrubbed on-disk index; synthesis sees only per-session answer strings (via the funnel), never raw transcripts.
- **The `@agentgem/recall` package is NOT modified** — Plan 2 only consumes it. The streaming synthesize + db-path helper live in `src/`.
- **The recall warmable is the only writer.** Route/MCP handles open read-only-in-practice (search only). Never open a second long-lived write handle.
- Commit bodies end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Types co-locate with their module.

## File Structure

| File | Responsibility |
|---|---|
| `src/goldmine/recall.ts` (new) | `defaultRecallDbPath()`; `serverFunnelDeps(opts?)` — `askOne` via `askSession`, `synthesize` streaming ACP over answers (injectable connect seam for tests). |
| `src/goldmine/recallRoutes.ts` (new) | `registerRecallRoutes(app, deps, guard)` — `GET /api/recall/search`, `POST /api/recall/run`, `GET /api/recall/stream`, `DELETE /api/recall/:jobId`, `GET /api/recall/status`; the jobs `Map`. |
| `src/goldmine/mcpServer.ts` (modify) | Add `@tool("search_session_content", …)` to `GoldmineTools` (opens its own read `RecallIndex`). |
| `src/warm/registry.ts` (modify) | Add `"recall"` to the `Warmable.id` union (line 22) + the `recall` array entry. |
| `src/index.ts` (modify) | Boot: open read `RecallIndex`, `app.onStop(() => idx.close())`, `registerRecallRoutes(...)`. |
| tests | `src/goldmine/__tests__/recall.test.ts` (funnel deps + db path); warmable id list update in `src/warm/__tests__/registry.test.ts`. |

---

### Task 1: `src/goldmine/recall.ts` — db path + streaming funnel deps

**Files:** Create `src/goldmine/recall.ts`; Test `src/goldmine/__tests__/recall.test.ts`.

**Interfaces — Produces:**
- `function defaultRecallDbPath(): string` → mirrors `transcriptIndex.defaultIndexDir()`'s pattern: `join(agentgemHome(), ".agentgem", "recall-index.db")` (verify `agentgemHome()`'s return by matching the sibling `transcriptIndex.ts` usage exactly — same base, different filename).
- `type SynthConnect = (question: string, onDelta: (t: string) => void, signal: AbortSignal) => Promise<string>`
- `function serverFunnelDeps(opts?: { synthConnect?: SynthConnect }): FunnelDeps` — from `@agentgem/recall`. `askOne` wraps `askSession(ref.sessionId, ref.agent, prompt)` → `{answered, answer}`. `synthesize(answers, prompt, mode, signal)` is an `async function*` that builds a cross-session synthesis prompt from the answered per-session answers, calls the `synthConnect` (default: real ACP via the `acpRecommender`/`sessionAsk` connect pattern — connect deny-perms neutral `analysisWorkspace()` cwd, `setMode("plan")`, `promptText(prompt, onDelta)`), and yields each streamed delta. Default `synthConnect` is the real one; tests inject a fake.

- [ ] **Step 1: Write the failing test** — `recall.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { defaultRecallDbPath, serverFunnelDeps } from "../recall.js";

describe("defaultRecallDbPath", () => {
  it("resolves under ~/.agentgem and ends with recall-index.db", () => {
    const p = defaultRecallDbPath();
    expect(p).toMatch(/\.agentgem[/\\]recall-index\.db$/);
  });
});

describe("serverFunnelDeps.synthesize", () => {
  it("streams the injected synth output as deltas over the answered sessions", async () => {
    const seen: string[] = [];
    const deps = serverFunnelDeps({
      synthConnect: async (q, onDelta) => { onDelta("syn"); onDelta("thesis"); return "synthesis"; },
    });
    const answers = [
      { sessionId: "s1", agent: "claude", answered: true, answer: "did X" },
      { sessionId: "s2", agent: "claude", answered: false, answer: "failed" },
    ];
    let out = "";
    for await (const delta of deps.synthesize(answers, "summarize", "extract", new AbortController().signal)) {
      seen.push(delta); out += delta;
    }
    expect(out).toBe("synthesis");
    expect(seen).toEqual(["syn", "thesis"]);
  });
});
```

- [ ] **Step 2: Run it, watch it fail** — `pnpm build && pnpm exec vitest run dist/goldmine/__tests__/recall.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `src/goldmine/recall.ts`.** `defaultRecallDbPath` per the interface. `serverFunnelDeps`: `askOne` via `askSession`; `synthesize` an `async function*` that (a) filters `answers` to `answered`, (b) builds a prompt like `"You are synthesizing findings from N past sessions to answer: <prompt>. Per-session findings:\n\n" + answers.map(a => "### " + a.agent + ":" + a.sessionId + "\n" + a.answer).join("\n\n")`, (c) collects deltas via a small queue bridging the `onDelta` callback into the generator (mirror `chatSession.ts`'s queue+wake bridge, `:130-152`), (d) yields each delta; on `signal.aborted` stops. Default `synthConnect` wires the real ACP connect (model on `sessionAsk.defaultAskConnectFn` / `acpRecommender`): connect (deny, neutral cwd), open, `setMode("plan")`, `promptText(prompt, onDelta)`, dispose/close. Keep the ACP path resilient (never throw — degrade to yielding the deterministic join of answers on connect failure).

- [ ] **Step 4: Run it, watch it pass.** Same command → PASS.

- [ ] **Step 5: Commit** — `feat(recall): server funnel deps + db path helper`.

---

### Task 2: `recall` Warmable — keep the on-disk index fresh

**Files:** Modify `src/warm/registry.ts`; Modify `src/warm/__tests__/registry.test.ts`.

**Interfaces — Consumes:** `RecallIndex`, `syncRecallIndex` from `@agentgem/recall`; `scanSessionsCached`, `loadSessionTranscript` from `@agentgem/insight`; `defaultRecallDbPath` (Task 1). Produces: a new `WARMABLES` entry `id:"recall"`.

- [ ] **Step 1: Update the id-list test.** In `registry.test.ts`, find the assertion listing warmable ids (the map/lookup at `:13-14,65`) and add `"recall"` to the expected set. Run → FAIL (id not present yet).

- [ ] **Step 2: Add `"recall"` to the union** — `src/warm/registry.ts:22`: append `| "recall"` to the `id` union.

- [ ] **Step 3: Add the warmable entry** to `WARMABLES` (after `scorecard`, keep it a `cheap`/`global`):

```ts
{
  id: "recall", cost: "cheap", scope: "global",
  async warm(_root, { dir, force }) {
    const index = new RecallIndex(defaultRecallDbPath());
    try {
      const sessions = await scanSessionsCached(Date.now(), dir ? { claudeDir: dir } : undefined, force);
      const r = await syncRecallIndex(index, sessions, { loadTranscript: (id, agent) => loadSessionTranscript(id, agent as never) });
      return (r.indexed + r.removed) > 0 ? "warmed" : "hit";
    } finally { index.close(); }
  },
},
```
Add the imports at the top of `registry.ts` (`RecallIndex`, `syncRecallIndex` from `@agentgem/recall`; `loadSessionTranscript` from `@agentgem/insight` — `scanSessionsCached` is likely already imported; check). Add `@agentgem/recall` to `package.json`/root deps + the root `tsconfig` reference already includes it (merged).

- [ ] **Step 4: Run the registry test** → PASS. Then `pnpm build` → clean (confirms the warmable typechecks and `@agentgem/recall` resolves from the root package).

- [ ] **Step 5: Commit** — `feat(recall): recall warmable — keep the on-disk index warm`.

---

### Task 3: `search_session_content` MCP tool

**Files:** Modify `src/goldmine/mcpServer.ts`. (Test: extend `src/goldmine/__tests__/mcpServerTools.test.ts` if it can construct `GoldmineTools` without spawning; otherwise assert via a direct method call with a temp index.)

**Interfaces — Consumes:** `RecallIndex` from `@agentgem/recall`; `defaultRecallDbPath` (Task 1).

- [ ] **Step 1: Add the input schema + tool method** to `GoldmineTools` (mirror `search_sessions` at `mcpServer.ts:41-48`):

```ts
const SearchContentInput = z.object({
  query: z.string(),
  project: z.string().optional(),
  agent: z.string().optional(),
  since: z.number().optional(),
  limit: z.number().int().min(1).max(50).default(12),
});

@tool("search_session_content", { input: SearchContentInput, description: "Search past session transcript CONTENT (not just metadata) for moments matching a query; returns ranked moments across sessions with snippets." })
async searchSessionContentTool({ query, project, agent, since, limit }: z.infer<typeof SearchContentInput>) {
  const index = new RecallIndex(defaultRecallDbPath());
  try {
    return { moments: index.search(query, { project, agent, since }, limit) };
  } finally { index.close(); }
}
```
Add imports (`RecallIndex` from `@agentgem/recall`, `defaultRecallDbPath` from `./recall.js`). Note: this runs in the stdio subprocess; opening its own on-disk read handle is correct and WAL-safe.

- [ ] **Step 2: Verify** — `pnpm build` clean. If `mcpServerTools.test.ts` constructs `GoldmineTools` directly, add a test: seed a temp index (via `RecallIndex` + `upsertSession`), point `defaultRecallDbPath` at it (inject or env), assert `searchSessionContentTool({query})` returns matching moments. If the harness can't inject the path cheaply, assert the tool is registered (schema present) and defer content assertion to the route test in Task 4.

- [ ] **Step 3: Commit** — `feat(recall): search_session_content MCP tool`.

---

### Task 4: `src/goldmine/recallRoutes.ts` — search + funnel job SSE

**Files:** Create `src/goldmine/recallRoutes.ts`; Test `src/goldmine/__tests__/recallRoutes.test.ts` (unit-test the funnel-stream helper with a fake generator + a fake `Res`).

**Interfaces — Produces:**
- `interface RecallRouteDeps { readIndex: RecallIndex; listSessions: () => Promise<SessionRef[]>; funnelDeps: FunnelDeps; indexStatus: () => { ready: boolean; indexed: number; total: number } }`
- `function registerRecallRoutes(app: App, deps: RecallRouteDeps, guard?: Middleware): void`
- `async function streamFunnel(res: Res, gen: AsyncGenerator<FunnelEvent>): Promise<void>` (exported for tests) — SSE-writes each event via `send(ev.type, ev)`, then `res.end()`.

Reuse the duck-typed `App/Req/Res/Middleware` interfaces + the `send` SSE helper verbatim from `chatRoutes.ts:26-45,154-155`.

- [ ] **Step 1: Write the failing test** — `recallRoutes.test.ts`: build a fake `Res` capturing `write`/`end`; feed `streamFunnel` a hand-rolled `AsyncGenerator<FunnelEvent>` yielding `session_started`, `session_done`, `done`; assert the written SSE frames are `event: session_started\ndata: {…}\n\n` … and `res.end()` was called once.

- [ ] **Step 2: Run → FAIL** (module missing).

- [ ] **Step 3: Implement `recallRoutes.ts`.** The five routes (guard each with `guard`):
  - `GET /api/recall/search` — parse `q`, `project`, `agent`, `since`, `limit` from query; `res.json({ moments: deps.readIndex.search(q, {project,agent,since}, limit) })`. Empty/whitespace `q` → `{moments:[]}`.
  - `GET /api/recall/status` — `res.json(deps.indexStatus())`.
  - `POST /api/recall/run` — body `{ sessionIds: {sessionId,agent}[], prompt, mode }`; validate; mint `jobId = recall_${++counter}`; store `{ input, ctrl: new AbortController() }` in an in-closure `Map`; `res.json({ jobId })`.
  - `GET /api/recall/stream?jobId=` — set the SSE headers (mirror `chatRoutes.ts:147-150`); look up the job (404 if missing); `await streamFunnel(res, recallFunnel({ ...job.input, signal: job.ctrl.signal }, deps.funnelDeps))`; delete the job after; on client disconnect (`req.on?.("close")` if available) abort.
  - `DELETE /api/recall/:jobId` — `job.ctrl.abort()`, delete, `res.json({ ok: true })`.
  `streamFunnel` as specified. Client-error vs 500 mapping like `chatRoutes.ts:138-140`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** — `feat(recall): /api/recall search + funnel job routes`.

---

### Task 5: Boot wiring in `src/index.ts`

**Files:** Modify `src/index.ts`. (No unit test — integration; verified by build + a manual smoke in the finish step.)

- [ ] **Step 1: Open the read index + register routes.** Near the chat block (`~:310`), after `const adapterCtx = …`:

```ts
const recallIndex = new RecallIndex(defaultRecallDbPath());
app.onStop(() => { try { recallIndex.close(); } catch { /* ignore */ } });   // pattern: index.ts:146
registerRecallRoutes(server.expressApp as never, {
  readIndex: recallIndex,
  listSessions: async () => (await scanSessionsCached(Date.now())).map((s) => ({ sessionId: s.sessionId, agent: s.agent })),
  funnelDeps: serverFunnelDeps(),
  indexStatus: () => ({ ready: true, indexed: recallIndex.indexedSessions().size, total: recallIndex.indexedSessions().size }),
}, originGuard as never);
```
Add imports: `RecallIndex` from `@agentgem/recall`; `defaultRecallDbPath`, `serverFunnelDeps` from `./goldmine/recall.js`; `registerRecallRoutes` from `./goldmine/recallRoutes.js`. (`scanSessionsCached`, `originGuard` are already imported — verify.)

- [ ] **Step 2: Build the whole app** — `pnpm build` → clean.

- [ ] **Step 3: Smoke** — `node dist/index.js` (or the project run skill); `curl 'localhost:<port>/api/recall/status'` → `{ready:…}`; `curl 'localhost:<port>/api/recall/search?q=migration'` → `{moments:[…]}` (after a warm pass, or trigger `agentgem warm`). Confirm no boot crash + clean shutdown.

- [ ] **Step 4: Commit** — `feat(recall): wire RecallIndex + routes into server boot`.

---

## Self-Review

**Spec coverage:** `search_session_content` MCP tool → Task 3. `/api/recall/*` routes (search/run/stream/cancel/status) → Task 4. `recall` Warmable → Task 2. Streaming LLM synthesis → Task 1 (`serverFunnelDeps.synthesize`). Boot wiring → Task 5. Privacy boundary → search over scrubbed index; synthesis over per-session answers only. Recall package untouched → all new code in `src/`.

**Placeholder scan:** none — each testable task ships complete code; integration tasks cite exact anchors + patterns to mirror.

**Type consistency:** `defaultRecallDbPath`/`serverFunnelDeps` (Task 1) consumed in Tasks 2–5; `FunnelDeps`/`FunnelEvent`/`SessionRef`/`MomentHit`/`RecallFilters` from `@agentgem/recall`; `RecallIndex.search(query, filters, limit)` sync; `syncRecallIndex(index, sessions, {loadTranscript})`.

**Known integration risks to watch during execution:**
- `agentgemHome()` return shape — match `transcriptIndex.ts`'s exact `join(...)` usage, don't assume.
- `mcpServerTools.test.ts` may not construct `GoldmineTools` without a subprocess — Task 3 Step 2 has a fallback.
- WAL multi-process: warmable is the only writer; if a second writer is ever added, revisit.
- Chat Exit A (scoped "chat with these") is **Plan 3** (console opens `/api/chat` with a session-scoped brief; the new `search_session_content` tool is already on the goldmine MCP) — not in this plan.
