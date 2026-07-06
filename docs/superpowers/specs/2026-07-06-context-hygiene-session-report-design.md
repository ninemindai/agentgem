# Context-Hygiene Per-Session Report — design

**Date:** 2026-07-06
**Status:** Draft for review
**Depends on:** PR #153 (`feat/context-hygiene-detectors`) — the detector engine. This branch (`feat/context-hygiene-session-report`) is **stacked** on it and must land after it (or be rebased onto `main` once #153 merges).
**Visual template:** `mockups/context-bloat-report.html` (the hero bloat-curve + verdict badges + factor rows).

## Problem

PR #153 shipped the context-hygiene detector engine (`context-pinned`, `cache-churn-late`, `task-sprawl`, `task-pingpong`, `reread-churn`, `hygieneScore`, and `SessionSequence.contextSeries`). But nothing surfaces it: no console view renders the `hygiene` verdict, and the bloat-curve visualization lives only as a static mockup. A user cannot click anything and see "how healthy was this session's context?"

## Goal

Add a **per-session context-hygiene report** reachable from **Inspect → Session** (the Observe panel's `TranscriptViewer`, routed at `#/inspect/<agent>/<sessionId>`). A user opens a Claude session and **immediately sees** — with no extra click — the bloat curve, a `bounded`/`mixed`/`bloated` verdict, and which detectors fired with their advice, computed by the real PR #153 engine on the server.

**Non-goals:** the Rubrics-panel trigger and a built-in hygiene rubric (separate follow-up); the live Watch-SSE nudge / EMBER game (Phase 2); Tier-2 LLM boundary-judge; Codex sessions (see Scope).

## Scope: Claude sessions only (v1)

The bloat curve is per-turn `contextTokens` derived from each assistant message's `usage` block — the Claude transcript shape. `scanWorkflow` only populates `contextSeries` for Claude records (PR #153 Task 7), and Codex uses a cumulative `token_count` model with no clean per-turn curve. So the endpoint accepts `agent=claude` only and rejects Codex with a clear message; the UI hides the Analyze button for a Codex selection. This mirrors the existing `/inspect/distill` route, which is already Claude-only.

## Architecture

Three units, each independently testable. The detector logic, thresholds, and curve extraction all come from PR #153 — this feature adds only a thin endpoint, its schema, and a presentation component. **Zero threshold logic in the browser.**

### 1. Server endpoint — `GET /inspect/session/hygiene`

A near-copy of `inspectDistill`'s scan setup (gem.controller.ts:416), with a different tail.

- **Query:** `{ id: string; agent: "claude" }` (reuse `InspectSessionQuerySchema`; reject `agent !== "claude"` with `InvalidInputError("Context hygiene is available for Claude sessions only.")`, matching the distill guard).
- **Body of the handler:**
  1. `const found = await resolveClaudeSession(id)` — the same resolver distill uses; throw `InvalidInputError("No Claude session '<id>' found ...")` when absent or `!found.cwd`.
  2. Build `scanInv` exactly as distill does:
     ```ts
     const inventory = introspectAll(undefined, [found.cwd]);
     const project = (inventory.projects ?? []).find((p) => p.root === resolveProject(found.cwd!));
     if (!project) throw new InvalidInputError(`Project for session '${id}' not found in inventory.`);
     const scanInv = { project, global: { skills: inventory.skills, mcpServers: inventory.mcpServers, hooks: inventory.hooks } };
     ```
  3. `const signal = scanWorkflow([found.path], scanInv, { retainSequences: true });`
  4. `const session = signal.sequences?.sessions?.[0];` — the one scanned session (may be `undefined` for a tool-free session that never produced a `SessionSequence`; handle by returning an empty-curve payload, not an error).
  5. Run the five hygiene detectors and score:
     ```ts
     const findings = runDetectors(signal);
     const hygieneSpecs = DETECTORS.filter((d) => HYGIENE_FACTOR_IDS.has(d.id));
     const factors = summariesForSpecs(hygieneSpecs, findings);   // one row per hygiene factor, count 0 when unfired
     const hygiene = hygieneScore(factors);
     ```
     `summariesForSpecs` is currently module-private in `rubricReport.ts`; export it (small, safe) so the endpoint reuses the exact "row per spec, 0 when unfired" shaping the rubric report uses. `HYGIENE_FACTOR_IDS` is a new small exported set in `contextHygiene.ts` (the keys of the existing `WEIGHTS` map) — also lets `assessesHygiene` be defined in terms of it.
  6. **Return:**
     ```ts
     {
       meta: { sessionId, transcript, model, cap },   // cap = contextCap(session?.model)
       curve: session?.contextSeries ?? [],           // TurnUsage[]
       factors,                                        // DetectorSummary[]
       hygiene,                                        // { score, verdict }
     }
     ```

- **Response schema** (`HygieneReportSchema`) added to `gem.controller.ts` and mirrored in `packages/console/src/api/routes.ts` with a `hygieneRoute`, following the `inspectSessionRoute` pattern.

### 2. Console route binding

Add `hygieneRoute` (a typed GET with the query + response schema) to `routes.ts`, next to `inspectSessionRoute`. Export the `HygieneReport` type via `z.infer`.

### 3. UI — `HygieneReport.tsx` component

New `packages/console/src/panels/Observe/HygieneReport.tsx`, rendered inline inside `TranscriptViewer` as an always-present **"Context hygiene"** section (not a separate tab, not collapsed behind a click — fewer clicks is the priority).

- **Auto-load:** on session open, when `agent === "claude"`, the section fetches `hygieneRoute` with `{ id, agent }` immediately (in a `useEffect` keyed on the session ref, aborting on unmount/ref-change — same fetch discipline as the panel's `observeRawRoute` effect). No Analyze button.
- **Cost note:** this triggers a second transcript parse per session open (the endpoint's `scanWorkflow` re-reads the file `inspectSession` already read). Accepted deliberately for the fewer-clicks goal; it is one file, and the section renders its own loading state so it never blocks the transcript view.
- **Renders:**
  1. **Verdict badge** — `bounded` (teal) / `mixed` (amber) / `bloated` (red) + the 0–100 score.
  2. **Bloat curve** — a `<canvas>` of `curve[].ctxTokens` per turn with a dashed `cap` line and a shaded area fill, adapted from `mockups/context-bloat-report.html`'s hero canvas, using the console's existing CSS theme tokens (not the mockup's hardcoded hex).
  3. **Factor rows** — one row per fired factor: title, count, and its one-line `advice`. Unfired factors collapse to a single "N checks passed" line (matches how `RubricReport` presents clean factors).
- **States:** spinner → report; inline "No context data for this session" when `curve` is empty; the whole section is omitted for a Codex selection; a fetch error renders inline (not a toast).

## Data flow

```
Inspect → Session (TranscriptViewer)
   │  [session open, agent=claude — auto-fetch]
   ▼
GET /inspect/session/hygiene?id&agent=claude
   │  resolveClaudeSession → scanWorkflow(retainSequences) → runDetectors + hygieneScore
   ▼
{ meta{cap}, curve: TurnUsage[], factors: DetectorSummary[], hygiene{score,verdict} }
   │
   ▼
HygieneReport.tsx → verdict badge + bloat-curve canvas + factor rows
```

## Testing

- **Server (in CI):** a test in `src/gem/__tests__/` (the in-CI location) that writes a small fixture Claude transcript (2–3 assistant turns carrying `usage`, a couple of `Read` steps), invokes the endpoint handler (or the extracted core function it delegates to), and asserts: `curve.length` = assistant-turn count; `curve[i].ctxTokens` equals `input+cache_read+cache_creation`; `hygiene.verdict` present; a clean short session scores `bounded`; the Codex path throws the guard error. Prefer extracting the handler body into a pure-ish `sessionHygiene(id, agent)` core function (like other `*Core.ts` modules) so it's testable without the full HTTP stack.
- **Console (local only — console tests are NOT in CI):** a `HygieneReport` test with a mocked `hygieneRoute` covering three states — report rendered (verdict + rows from a `factors`/`hygiene` payload), empty-curve "no context data", and loading. Canvas drawing is smoke-tested ("renders without throwing"); the data→rows shaping is asserted.

## Files

- **Modify** `packages/insight/src/contextHygiene.ts` — export `HYGIENE_FACTOR_IDS: ReadonlySet<string>` (keys of `WEIGHTS`); redefine `assessesHygiene` in terms of it.
- **Modify** `packages/insight/src/rubricReport.ts` — `export` the existing `summariesForSpecs` (currently module-private) for reuse.
- **Create** `src/sessionHygieneCore.ts` — `sessionHygiene(id, agent): Promise<HygieneReport>` (the scan+detect+score core), so the controller stays thin and the logic is unit-testable. Follows the existing `*Core.ts` convention (e.g. `insightsCore.ts`, `rubricCore.ts`).
- **Modify** `src/gem.controller.ts` — add the `HygieneReportSchema` + the `@get("/inspect/session/hygiene")` handler delegating to `sessionHygiene`.
- **Modify** `packages/console/src/api/routes.ts` — add `hygieneRoute` + `HygieneReport` type.
- **Create** `packages/console/src/panels/Observe/HygieneReport.tsx` — the component.
- **Modify** `packages/console/src/panels/Observe/TranscriptViewer.tsx` — render `HygieneReport` under a collapsible header (hidden for Codex).
- **Create** `src/gem/__tests__/sessionHygiene.test.ts` — server test.
- **Create** `packages/console/src/panels/Observe/HygieneReport.test.tsx` — component test (local).

## Constraints

- ESM `.js` import specifiers; 3-line copyright header on new files.
- Reuse the PR #153 engine and the `inspectDistill` scan setup verbatim — no re-implemented detector/threshold logic anywhere, least of all the browser.
- Privacy: the endpoint returns `DetectorSummary` (counts/advice) + `TurnUsage` (integers) only — no `arg`/path, consistent with the finding privacy contract.
- Server tests live in `src/gem/__tests__/` (in CI); console tests are not in CI (run locally).
- Commit identity Raymond Feng <raymond@ninemind.ai> with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

## Out of scope (later follow-ups)

- Built-in `context-hygiene` rubric + Rubrics-panel trigger (surfaces the same verdict across many sessions).
- Live Watch-SSE break nudge + EMBER game.
- Tier-2 `session-boundary-judge` (LLM "cut at turn N").
- Codex support (needs a per-turn curve model for cumulative token accounting).
