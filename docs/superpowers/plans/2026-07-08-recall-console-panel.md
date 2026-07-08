# Recall Console Panel (Plan 3 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the `#/recall` console panel — the user-facing surface for the Recall backend: instant cross-session search → select moments → **Chat with** or **Extract across** the selection.

**Architecture:** A new React panel (`packages/console/src/panels/Recall/`) that consumes the merged `/api/recall/*` backend (Plan 2). Instant search via a typed client route + a `useRecallSearch` hook; the two exits run the capped funnel via `POST /api/recall/run` → a hand-written `recallStream.ts` SSE consumer (mirroring `chatStream.ts`). Reuses the report/export infra for Extract. The visual spec is the **approved mockup** at `/private/tmp/claude-501/-Users-rfeng-Projects-ninemind-agentgem/b7e2270d-b596-4971-9e27-d34abd8c0430/scratchpad/recall-mockup.html` — implementers Read it for the exact `.rc-*` markup + CSS to port.

**Tech Stack:** React (esbuild bundle), `@agentback/client` (`defineRoute`), native `EventSource`, the Lapidary-Ledger `theme.css`, vitest + `@testing-library/react` (local-only, not CI).

**Depends on:** #210 + #214 (merged) — the `/api/recall/*` routes are live on `main`.

## Scope decisions (mockup vs. buildable console-only — flagged for confirmation)

1. **Exit A = funnel-run per question, NOT a continuing ChatManager chat.** `POST /api/chat` today takes only `{agentId}` (no session-scope/brief param), so a true multi-turn chat scoped to the selection would require a Plan-2 backend change. Instead, Exit A runs `POST /api/recall/run {mode:"chat"}` per question over the selected sessions: session chips come from `session_started`/`session_done` events, the answer from `synthesis_delta`, and a follow-up question = a new run over the same selection. Faithful to the mockup (chips + synthesis + follow-up box). A persistent agent-driven chat (using the `search_session_content` tool) is a deferred enhancement needing `/api/chat` session-scope.
2. **Exit D export = Copy / .md / .json / PDF** (the existing `ReportActions`). The infra has **no `.csv`** and **Save-as-Gem from a report** has no backend path (draft-gem is chat-scoped). So v1 drops the mockup's ".csv" and "Save as Gem" from Extract; both are noted follow-ups.
3. **"Open turn ↗" = turn-level deep-link** (`#/sessions/<agent>/<sessionId>?turn=<n>`) — **confirmed in scope.** Task 5 (required) adds the cross-cutting receiving side (`turnTree`, `TranscriptViewer`, `StructureView`, `Sessions` route parse). `MomentHit.turn` is a numeric index that aligns with the viewer's `view.turns[]` (same `loadSessionTranscript` source), so the link carries `?turn=<moment.turn>` and Task 5 resolves `view.turns[n]` → scrolls to its `id` anchor.

## Global Constraints

- ESM, `.js` relative imports. No new color literals — use Lapidary-Ledger tokens (`--accent`, `--emerald`, `--paper`, etc.). 2-line SPDX header on new files.
- `apiBase` is passed to the panel component (`({ apiBase }) => ReactNode`); pass it to `makeClient(apiBase)` and prefix the SSE URL.
- Console tests are **local-only** (not CI); colocate `*.test.tsx`. Run `pnpm --filter @agentgem/console test`. The backend routes are already CI-covered.
- Snippet highlight markers from the backend are `⌈`/`⌉` — render them as `<mark>` (never `dangerouslySetInnerHTML` raw; split on the markers and wrap).
- Commit bodies end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `packages/console/src/api/routes.ts` (modify) | Add `recallSearchRoute` (GET), `recallStatusRoute` (GET), `recallRunRoute` (POST), `recallCancelRoute` (DELETE) + client Zod schemas (`MomentHitSchema`). |
| `packages/console/src/panels/Recall/recallStream.ts` (new) | `openRecallStream(apiBase, jobId, onEvent): () => void` — EventSource consumer for the funnel SSE (mirror `chatStream.ts`). |
| `packages/console/src/panels/Recall/useRecall.ts` (new) | `useRecallSearch(apiBase)` (debounced search + filters + status) hook (mirror `useObserveData`). |
| `packages/console/src/panels/Recall/index.tsx` (new) | The panel: search bar + filters + moment cards + selection + sticky action bar + the exit drawer; `defineConsolePage` at the bottom. |
| `packages/console/src/panels/Recall/MomentCard.tsx` + `ExitDrawer.tsx` (new) | Sub-components (card with highlighted snippet + checkbox; the Chat/Extract drawer). |
| `packages/console/src/pages.tsx` (modify) | Import `recallPage` + add to the `pages` array. |
| `packages/console/src/shell/theme.css` (modify) | Append the `.rc-*` block (port from the mockup). |
| `*.test.tsx` colocated | Panel + card + stream-parse tests. |

---

### Task 1: API routes + SSE stream client

**Files:** Modify `packages/console/src/api/routes.ts`; Create `packages/console/src/panels/Recall/recallStream.ts`; Test `packages/console/src/panels/Recall/recallStream.test.ts`.

**Interfaces — Produces:**
- `MomentHitSchema` (zod) → `{ sessionId, agent, turn:number, project:string().nullable(), branch:string().nullable(), startMs:number, snippet:string, score:number, turnsMatched:number }`; `type MomentHit = z.infer<...>`.
- `recallSearchRoute = defineRoute("GET","/api/recall/search",{ query: z.object({ q:z.string(), project:z.string().optional(), agent:z.string().optional(), since:z.number().optional(), limit:z.number().optional() }), response: z.object({ moments: z.array(MomentHitSchema) }) })`
- `recallStatusRoute = defineRoute("GET","/api/recall/status",{ response: z.object({ ready:z.boolean(), indexed:z.number(), total:z.number() }) })`
- `recallRunRoute = defineRoute("POST","/api/recall/run",{ body: z.object({ sessionIds: z.array(z.object({ sessionId:z.string(), agent:z.string() })), prompt:z.string(), mode:z.enum(["chat","extract"]) }), response: z.object({ jobId:z.string() }) })`
- `recallCancelRoute = defineRoute("DELETE","/api/recall/{jobId}",{ path: z.object({ jobId:z.string() }), response: z.object({ ok:z.boolean() }) })`
- `type RecallFunnelEvent = { type:"session_started"; sessionId:string } | { type:"session_done"; sessionId:string; answered:boolean } | { type:"capped"; scanned:number; requested:number; cap:number } | { type:"synthesis_delta"; text:string } | { type:"done"; answers:{sessionId:string;agent:string;answered:boolean;answer:string}[]; synthesis:string } | { type:"cancelled" } | { type:"failed"; error:string }`
- `function openRecallStream(apiBase: string, jobId: string, onEvent: (e: RecallFunnelEvent) => void): () => void`

- [ ] **Step 1: Read the mirror + write the failing stream-parse test.** Read `packages/console/src/panels/Chat/chatStream.ts` and `panels/Chat/index.tsx:21` (the plain-fetch helper). Because native `EventSource` is awkward in jsdom, factor the frame handling into a testable pure function `parseRecallFrame(eventName: string, data: string): RecallFunnelEvent | null` and test IT:
```ts
// recallStream.test.ts
import { describe, it, expect } from "vitest";
import { parseRecallFrame } from "./recallStream.js";
describe("parseRecallFrame", () => {
  it("parses a session_done frame", () => {
    expect(parseRecallFrame("session_done", JSON.stringify({ type:"session_done", sessionId:"s1", answered:true })))
      .toEqual({ type:"session_done", sessionId:"s1", answered:true });
  });
  it("maps the server 'failed' frame to a failed event", () => {
    expect(parseRecallFrame("failed", JSON.stringify({ error:"boom" }))).toEqual({ type:"failed", error:"boom" });
  });
  it("returns null for unknown/garbage", () => {
    expect(parseRecallFrame("weird", "{}")).toBeNull();
    expect(parseRecallFrame("done", "not json")).toBeNull();
  });
});
```
- [ ] **Step 2: Run → FAIL** (`pnpm --filter @agentgem/console test recallStream` — module missing).
- [ ] **Step 3: Add the routes** to `routes.ts` (per the Interfaces block; place near the other observe/session routes). Then implement `recallStream.ts`: `parseRecallFrame` (JSON.parse in a try/catch → null on throw; for `"failed"` wrap `{error}` into `{type:"failed",error}`; for the known `type` names return the parsed object; else null), and `openRecallStream(apiBase, jobId, onEvent)` that opens `new EventSource(\`${apiBase}/api/recall/stream?jobId=${encodeURIComponent(jobId)}\`)`, registers listeners for `session_started|session_done|capped|synthesis_delta|done|cancelled|failed` (each → `parseRecallFrame` → `onEvent`), closes on `done`/`cancelled`/`failed`, and on native `"error"` emits `{type:"failed",error:"connection lost"}` + closes. Returns `() => es.close()`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `feat(console): recall api routes + funnel SSE client`.

---

### Task 2: Recall panel — search, moment cards, selection, registration

**Files:** Create `panels/Recall/useRecall.ts`, `panels/Recall/MomentCard.tsx`, `panels/Recall/index.tsx`; Modify `pages.tsx`, `shell/theme.css`; Test `panels/Recall/MomentCard.test.tsx`, `panels/Recall/Recall.test.tsx`.

**Interfaces — Consumes:** `recallSearchRoute`/`recallStatusRoute`/`MomentHit` (Task 1); `makeClient` (`api/routes.ts`). **Produces:** `recallPage` (`ConsolePage`).

- [ ] **Step 1: Read the mockup + mirrors.** Read the mockup HTML (path in the header) for the exact `.rc-*` markup/CSS and layout. Read `panels/Sessions/index.tsx:98-107` (page registration), `panels/Observe/useObserveData.ts` (hook idiom), `shell/theme.css:4-40` (tokens).
- [ ] **Step 2: Write the failing MomentCard test.**
```tsx
// MomentCard.test.tsx — renders project/branch/when, highlights ⌈…⌉ as <mark>, toggles selection
import { render, screen, fireEvent } from "@testing-library/react";
import { MomentCard } from "./MomentCard.js";
const hit = { sessionId:"s1", agent:"claude", turn:0, project:"agentgem", branch:"main", startMs:1, snippet:"the ⌈prod⌉ db", score:-1, turnsMatched:2 };
it("highlights snippet markers and reports selection toggles", () => {
  const onToggle = vi.fn();
  render(<MomentCard hit={hit} picked={false} onToggle={onToggle} />);
  expect(screen.getByText("prod").tagName).toBe("MARK");
  expect(screen.getByText(/2 matching turns/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /prod db|moment/i }));
  expect(onToggle).toHaveBeenCalledWith("claude:s1");
});
```
(Import `vi` from vitest; wrap markers by splitting `snippet` on `⌈`/`⌉` and mapping alternating segments to `<mark>`.)
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement.**
  - `MomentCard.tsx`: renders one moment (checkbox, `project · branch · agent · when`, highlighted snippet via a `renderSnippet(snippet)` helper that splits on `⌈`/`⌉`, "N matching turns", an "Open turn ↗" link to `#/sessions/${agent}/${encodeURIComponent(sessionId)}?turn=${turn}` (turn-level; the receiving side is Task 5)). Keys/selection use `\`${agent}:${sessionId}\``.
  - `useRecall.ts`: `useRecallSearch(apiBase)` — holds `{query, filters, moments, pending, error, status}`; debounces (~250ms) `recallSearchRoute.call(makeClient(apiBase), {query:{q, ...filters}})`; empty `q` → `moments:[]`; also loads `recallStatusRoute` once (for the "indexing N/M" hint). Mirror `useObserveData`'s alive-guard/refresh shape.
  - `index.tsx`: the panel — search input + filter pills (project/agent/since) + the `Moments across N · M matched` header + the moment list (`MomentCard`) + selection `Set<string>` + the sticky action bar (`selected count` + `💬 Chat with these` / `⇩ Extract across these`, disabled at 0) + a slot that renders `<ExitDrawer>` (Task 3) when an exit is chosen. Port classnames from the mockup. `defineConsolePage({ id:"recall", title:"Recall", icon:"✦", order:6, phase:"observe", category:"sessions", route:"#/recall", component: Recall })` at the bottom.
  - `pages.tsx`: import `recallPage`, add to the `pages` array.
  - `theme.css`: append the `.rc-*` block from the mockup (search bar, filter pills, moment cards, sticky action bar, drawer). Reuse tokens; no new literals.
- [ ] **Step 5: Write + run the panel registration/render test** (`Recall.test.tsx`): mounting with a stubbed client (mock `makeClient`/route `.call`) renders moments and the disabled action bar; selecting a card enables the buttons and updates the count. Run → PASS (+ the card test).
- [ ] **Step 6: Verify registration** — `pnpm --filter @agentgem/console test registry` (the page registers without a duplicate-id/phase-category throw). `pnpm --filter @agentgem/console build` (or the root `pnpm build`) clean.
- [ ] **Step 7: Commit** — `feat(console): recall panel — search + moment cards + selection`.

---

### Task 3: The two exits — Chat + Extract drawer (funnel)

**Files:** Create `panels/Recall/ExitDrawer.tsx`; Modify `panels/Recall/index.tsx` (wire the drawer); Test `panels/Recall/ExitDrawer.test.tsx`.

**Interfaces — Consumes:** `recallRunRoute`/`recallCancelRoute` (Task 1); `openRecallStream` (Task 1); `report/serialize.ts` (`blocksToMarkdown`/`blocksToHtml`, a new `momentsReportToBlocks`) + `report/ReportActions.tsx` (Exit D). **Produces:** `<ExitDrawer mode="chat"|"extract" sessions={SessionRef[]} onClose={} apiBase={} />`.

- [ ] **Step 1: Read the report infra.** Read `report/ReportActions.tsx` (props `{title,filename,markdown,json,html}`) + `report/serialize.ts` (`ReportBlock`, `blocksToMarkdown`, `blocksToHtml`, an example `*ToBlocks`).
- [ ] **Step 2: Write the failing drawer test.** With `openRecallStream` mocked (module mock) to synchronously emit a scripted sequence (`session_started`×2, `session_done`×2, `synthesis_delta`, `done`), and `recallRunRoute.call` mocked to return `{jobId:"j1"}`: assert the Chat drawer shows 2 session chips then the synthesis text; assert the Extract drawer renders the synthesis + per-session answers and a `ReportActions` (Copy button present).
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement `ExitDrawer.tsx`.**
  - On mount (or on submit for chat), `recallRunRoute.call(makeClient(apiBase), { body: { sessionIds: sessions, prompt, mode } })` → `{jobId}`, then `openRecallStream(apiBase, jobId, onEvent)`. Accumulate: a `Map<sessionId, {started,answered}>` for chips, a `synthesis` string buffer (append `synthesis_delta.text`), a `capped` banner, and `answers` from `done`. Store the teardown; on `onClose`/unmount call it + `recallCancelRoute.call(... {path:{jobId}})` if still running.
  - **Chat mode:** header "Chatting with N sessions"; a funnel line ("interrogated X of Y" from chips + a "capped" note); the session chips (`.rc-tool` — ok/failed by `answered`); the streamed synthesis as an assistant bubble; a composer input ("Ask a follow-up across these N sessions") that re-runs a fresh funnel with the new prompt over the same `sessions`.
  - **Extract mode:** a query box + Extract button; on run, render the funnel progress, then a report: build `momentsReportToBlocks(prompt, answers, synthesis)` → `blocksToMarkdown`/`blocksToHtml`, and render `<ReportActions title="Recall extract" filename="recall-extract" markdown={md} json={JSON.stringify({prompt,answers,synthesis})} html={html} />`. (No .csv / Save-as-Gem — scope decision 2.)
  - Port the drawer markup/classes from the mockup (`.rc-work`, `.rc-funnel`, `.rc-chat`, `.rc-report`, etc.).
- [ ] **Step 5: Wire into `index.tsx`** — the exit buttons set `{mode, sessions}` state that renders `<ExitDrawer>`; closing clears it. Selecting the exit passes the current selection as `SessionRef[]` (`{sessionId, agent}` from the picked keys).
- [ ] **Step 6: Run → PASS.** Then `pnpm --filter @agentgem/console build` clean.
- [ ] **Step 7: Commit** — `feat(console): recall Chat + Extract exits over the funnel`.

---

### Task 4: Manual verification (browser)

**Files:** none (verification only).

- [ ] **Step 1:** Build the app (`pnpm build`) and run it (project run skill / `node dist/index.js`). Warm the index (`agentgem warm` or trigger a warm pass) so the on-disk index has content.
- [ ] **Step 2:** Open `#/recall`; confirm: search returns cross-session moments with highlighted snippets + "N matching turns"; the status hint shows when the index is cold; selection toggles + the sticky bar count; "Open turn ↗" opens the session transcript.
- [ ] **Step 3:** Select 2–3 sessions → **Chat with these**: confirm session chips stream, a synthesis appears, a follow-up question re-runs. → **Extract across these**: confirm the report renders and Copy/.md/.json/PDF work; cancel a run mid-stream and confirm it stops.
- [ ] **Step 4:** Note any visual/behavior gaps against the mockup in the PR description.

---

### Task 5: turn-level deep-link (required)

**Files:** Modify `panels/Sessions/index.tsx` (parse `?turn=<n>`), `panels/Observe/TranscriptViewer.tsx` + `StructureView.tsx` (force `tx` mode + expand + scroll to target when `?turn=` present), `panels/Observe/turnTree.tsx:15` (add `id={"turn-"+turn.id}` DOM anchor); Test `panels/Observe/TranscriptViewer.test.tsx` (extend).

**Interfaces — Consumes:** the `?turn=<n>` param emitted by Task 2's MomentCard (numeric index).

- [ ] **Step 1: Read the receiving components.** `panels/Sessions/index.tsx:20-29` (`parseSelection`), `panels/Observe/StructureView.tsx:16,30-32` (mode default/gating), `panels/Observe/TranscriptViewer.tsx:25,38-42` (collapsed Set), `panels/Observe/turnTree.tsx:15` (the turn `<li>`).
- [ ] **Step 2: Write the failing test.** Extend `TranscriptViewer.test.tsx`: render with a `?turn=1` selection + a 3-turn view; assert (a) the viewer is in transcript (`tx`) mode (not the default map), (b) `view.turns[1]` is expanded (not collapsed), (c) `scrollIntoView` was called on the `#turn-<id>` element (the test-setup already stubs `scrollIntoView`). Run → FAIL.
- [ ] **Step 3: Implement.**
  - `turnTree.tsx:15`: add `id={"turn-" + turn.id}` to the turn `<li>`.
  - `Sessions/index.tsx`: extend `parseSelection` to also capture `?turn=<n>` (numeric) alongside the existing `?vs=` handling; thread it to `TranscriptViewer`.
  - `TranscriptViewer.tsx` (+ `StructureView.tsx`): when a `turn` index is present, force `mode:"tx"`, resolve `view.turns[turn]?.id`, remove it from the `collapsed` Set (expand it), and on mount `document.getElementById("turn-"+id)?.scrollIntoView({ block: "center" })`. Guard against out-of-range `turn`.
- [ ] **Step 4: Run → PASS.** `pnpm --filter @agentgem/console build` clean. Re-run the Task 4 manual check's "Open turn ↗" step to confirm it lands on the exact turn.
- [ ] **Step 5: Commit** — `feat(console): turn-level deep-link for recall moment cards`.

---

## Self-Review

**Spec/mockup coverage:** search + cross-session moment cards + highlight + selection + sticky bar → Task 2; Chat + Extract exits over the funnel → Task 3; registration/nav (Observe→Sessions, order 6) → Task 2; CSS from the mockup → Task 2; deep-link → Task 2 (session-level) + Task 5 (turn-level, optional). Backend already merged (Plans 1–2).

**Placeholder scan:** none — route defs, hook/stream shapes, and test skeletons are concrete; the mockup file is the CSS/markup source (implementers Read it).

**Type consistency:** `MomentHit`/`RecallFunnelEvent` (Task 1) consumed in Tasks 2–3; `recall*Route` names stable; `openRecallStream`/`parseRecallFrame` (Task 1) used in Task 3; selection key format `\`${agent}:${sessionId}\`` consistent across MomentCard/index/ExitDrawer.

**Scope calls (CONFIRMED with the human):** (1) Exit A = per-question funnel run, not a persistent scoped ChatManager chat [deferred]; (2) Extract export = Copy/.md/.json/PDF, no .csv, no Save-as-Gem [deferred]; (3) turn-level "Open turn" IS in scope → Task 5 required.
