# Watch "Dashboard" mode (Flavor B) — design

**Status:** approved design, pre-implementation
**Date:** 2026-07-03
**Depends on:** Flavor A live event feed (PR #100 — `src/watchEvents.ts`, `detectEvents` on `SourceSpec`, `SessionFeed`, `sandboxDoc`)

## Summary

Add a third Watch mode — `Feed | Dashboard | Artifact` — in which an LLM **rendering
agent** maintains a *living HTML dashboard* of a running coding session. The agent
evolves the dashboard in **debounced bursts** (prev HTML + new events → updated HTML),
and the result renders in the **existing null-origin sandbox iframe**. This is "Flavor
B" from the Watch generative-UI design: LLM-authored UI (OpenUI-style), as opposed to
Flavor A's hand-authored cards over live data.

Observe-only, opt-in (runs only while the user is on the Dashboard tab for a selected
session), and built entirely on the Flavor A spine + AgentGem's existing ACP-agent
generation pattern (`narrateInsights.ts`).

## Decisions (locked during brainstorming)

| Question | Decision | Why |
| --- | --- | --- |
| What does the agent produce? | **Free-form HTML dashboard** (full OpenUI) | Most capable / "living dashboard" feel; reuses the sandbox iframe. |
| When does it regenerate? | **Debounced bursts** (~4s quiet, or an N-event ceiling) | Cost scales with work-bursts, not events; "live enough". |
| How does a render relate to the last? | **Evolve previous HTML** (prev HTML + delta → HTML′) | Coherent living dashboard; also bounds input (no full history needed). |
| What drives the LLM call? | **Reuse the ACP agent** (plan/analysis mode) | Consistent with `narrateInsights`/`judgeSession`; no new dependency or API-key path. |

## Non-goals

- Not interactive/bidirectional (no user input flows back into the watched session —
  that would be the ACP Chat tab, not Watch).
- Not real-time per-event rendering (explicitly rejected for cost).
- Not a new LLM-call path (no direct Anthropic SDK usage; ACP only).
- No multi-agent fan-out; a single rendering agent per watched session.

## Architecture

Three independently-testable units, reusing the Flavor A spine.

```
transcript append
      │  (detectEvents delta — reused from Flavor A)
      ▼
[debounce ~4s / N-event ceiling]  ── src/watchDashboard.ts (SSE)
      │  prevHtml + unreflected events
      ▼
renderDashboard(prevHtml, deltaEvents, meta)  ── packages/insight/src/dashboardRender.ts
      │  ACP plan-mode agent → extract HTML → validate → fallback=prevHtml
      ▼
SSE `render { html, version }`
      │
      ▼
Dashboard.tsx → sandboxDoc(html) → <iframe sandbox="allow-scripts" srcDoc=…>
```

### Unit 1 — `renderDashboard` (`packages/insight/src/dashboardRender.ts`)

The rendering-agent call. Modeled directly on `narrateInsights.ts`.

- **Signature:** `renderDashboard(input: { prevHtml: string; deltaEvents: SessionEvent[]; meta: { project: string | null; agent: AgentId }; connect?: AcpConnectFn }): Promise<{ html: string; ok: boolean }>`
  - `connect` is injectable for tests (the `currentTestConnectFn` / `defaultConnectFn`
    pattern already in `acpRecommender.ts`).
- **Prompt** (single ACP plan-mode turn, like `NARRATE`): supplies the current
  dashboard HTML (empty on first render) and the new `SessionEvent`s as JSON, and asks
  for **one self-contained HTML document** that evolves the dashboard in place. Rules
  baked into the prompt:
  - Return ONLY the HTML document (no prose / code fences); a `{ "html": "…" }` wrapper
    is also accepted (extractor handles both).
  - Self-contained: inline `<style>` only, **no external resources** (no CDN, no remote
    fonts/img/scripts) — the CSP would block them anyway.
  - Evolve the existing structure rather than rebuild from scratch; keep it compact.
  - First render (`prevHtml === ""`): create the initial dashboard from the events.
- **Output handling:** extract the HTML (reuse the `extractJson`-style boundary trim,
  adapted for HTML — find the outermost `<html`/`<!doctype`/first tag … last close), and
  **validate** it looks like markup (contains a tag, non-empty, under the size cap). On
  any failure (timeout via `withTimeout`, agent unavailable, empty, non-markup) return
  `{ html: prevHtml, ok: false }`. **Never throws** — mirrors `narrateInsights`.
- **Size cap:** if the returned HTML exceeds ~80 KB, the caller (Unit 2) treats the next
  render as a **full-regenerate** (see drift controls) rather than growing further.

### Unit 2 — `GET /api/watch/dashboard` (`src/watchDashboard.ts`)

SSE endpoint, sibling of `src/watchEvents.ts`. Same SSE scaffold (`writeHead` +
`event:`/`data:` framing + heartbeat + `req.on("close")` cleanup), same security gate
(`resolveTranscriptFile` pins `?file=`, mounted behind `originGuard` in `src/index.ts`).

Per-connection state: `prevHtml: string = ""`, `reflectedCount = 0` (events already
reflected in `prevHtml`), `rendersSinceFullRegen = 0`, `inFlight = false`, a debounce
timer, and the last-seen transcript mtime.

Loop (poll on the existing ~1s tick, reusing the mtime gate):
1. On mtime change, re-run `source.detectEvents(text, file)` → the full event list.
   If `events.length > reflectedCount`, there are **unreflected** events → arm/refresh a
   **~4s debounce timer**. If unreflected count reaches an **N-event ceiling** (e.g. 40),
   fire immediately without waiting for quiet.
2. When the debounce fires (or ceiling hit) AND `!inFlight` AND there are unreflected
   events:
   - `inFlight = true`; emit `rendering`.
   - `delta = events.slice(reflectedCount)`.
   - **Full-regenerate condition:** if `rendersSinceFullRegen >= K` (e.g. 15) OR
     `prevHtml` exceeds the size cap → pass `prevHtml = ""` and `delta = events` (whole
     session) to shed accumulated drift/cruft; reset the counter. Otherwise pass
     `prevHtml` + `delta`.
   - `const { html, ok } = await renderDashboard({ prevHtml, deltaEvents, meta })`.
   - On `ok`: `prevHtml = html`; `reflectedCount = events.length`;
     `rendersSinceFullRegen++`; emit `render { html, version: ++version }`.
   - On `!ok`: emit `failed { message }` (keep `prevHtml`, do **not** advance
     `reflectedCount` — the delta retries next burst).
   - `inFlight = false`. If new events arrived while rendering, the mtime tick re-arms.
- Emits `phase { phase: "watching", agent }` on connect (before first render).

**Testability:** `renderDashboard` is injected (default import, overridable param) so the
SSE unit tests use a synchronous stub and fake timers — no real agent.

### Unit 3 — `Dashboard.tsx` (`packages/console/src/panels/Watch/`) + toggle

- New `dashboardStream.ts` client (thin `EventSource` mirror of `eventStream.ts`):
  events `phase` / `rendering` / `render { html, version }` / `failed`.
- `Dashboard.tsx`: subscribes on mount (keyed on `file`), holds the latest `html`; renders
  it via the **existing `sandboxDoc`** (export it from `index.tsx` — currently exported
  already) into the same `sandbox="allow-scripts"` iframe used by `ArtifactPane`. Shows a
  `rendering…` badge during a burst, a "waiting for the first render…" empty state before
  it, and a subtle "showing last render" note after a `failed`.
- `index.tsx`: extend the existing `Feed | Artifact` toggle to `Feed | Dashboard |
  Artifact`; `Dashboard` mounts `<Dashboard key={selected} apiBase file={selected} />`.
  Each pane already owns its stream (the ArtifactPane refactor from Flavor A), so this is
  additive.

## Data flow (end to end)

1. A watched session writes to its transcript.
2. The SSE poll sees the mtime change, re-folds events (`detectEvents`), notices
   unreflected events, arms the debounce.
3. On ~4s quiet (or ceiling), the endpoint calls `renderDashboard(prevHtml, delta)`.
4. The ACP agent returns evolved HTML; the endpoint emits `render`.
5. `Dashboard.tsx` swaps the iframe `srcDoc` (via `sandboxDoc`) → the living dashboard
   updates in place.

## Drift & cost controls

- **Only-when-dirty:** never render without unreflected events.
- **Debounce + ceiling:** coalesce a flurry into one call; cap latency-to-first-render
  with an N-event ceiling.
- **Single in-flight render:** no overlapping agent calls per connection.
- **Size cap (~80 KB) + periodic full-regenerate (every K≈15 renders):** sheds
  accumulated cruft and self-corrects evolve-drift. (Judgment call, approved: trades a
  little coherence for robustness.)
- **Opt-in:** the agent runs only while the Dashboard tab is mounted for a selected
  session — no background LLM spend. Closing the tab closes the SSE connection (cleanup).

## Error handling & fallback ladder

Mirrors `narrateInsights`' never-throw discipline:

- Render fails (timeout / agent unavailable / non-markup / empty) → keep the last good
  HTML, emit `failed`; the panel shows a subtle "showing last render" badge.
- **First** render fails → the panel shows a plain "couldn't render yet" state; Feed and
  Artifact remain one toggle-click away (unaffected).
- SSE connection lost → client shows "connection lost" (same as `eventStream.ts`).
- Unknown/out-of-scope `?file=` → `failed` + close (same as `watchEvents.ts`).

## Security

- Generated HTML is **untrusted** → contained by the reused `sandbox="allow-scripts"`
  **null-origin** iframe (no `allow-same-origin`) + strict CSP (`default-src 'none'`; see
  `sandboxDoc`). No network egress from the frame; it cannot read the console's
  cookies/DOM.
- Events are already **scrubbed** upstream by `detectEvents` (`scrubContent`), so no home
  paths or secrets reach the rendering agent *or* the iframe.
- `?file=` pinned to a watch root by `resolveTranscriptFile`; endpoint behind
  `originGuard`.

## Testing (TDD)

**`renderDashboard` (`packages/insight`, root `src/gem/__tests__/`):**
- Extracts HTML from a bare-document response and from a `{ "html": … }` wrapper.
- Falls back to `prevHtml` with `ok:false` on: empty output, non-markup prose, injected
  timeout, and a throwing connect-fn.
- First render (`prevHtml === ""`) returns the agent's HTML with `ok:true`.
- Uses an injected test connect-fn (the `currentTestConnectFn` pattern).

**`watchDashboard` SSE (`src/__tests__/`):**
- Rejects an out-of-scope file (`failed`).
- **Debounce coalescing:** 3 events within the window → exactly **one** `render`; assert
  the stub received all 3 as the delta.
- **Delta correctness:** after a render, new events pass only the *unreflected* slice.
- **Single in-flight:** a tick during a render does not start a second call.
- **Periodic full-regenerate:** on the Kth render, the stub receives `prevHtml === ""`
  and the whole event list.
- **Fallback:** a stub returning `ok:false` emits `failed` and does not advance
  `reflectedCount` (the delta retries next burst).
- Fake timers + injected stub `renderDashboard`.

**`Dashboard.tsx` (`packages/console`):**
- An emitted `render` lands its HTML in the sandboxed iframe (`sandbox="allow-scripts"`,
  `srcdoc` contains the CSP + the HTML).
- `rendering` shows the badge; first-render-absent shows the waiting state; `failed`
  after a good render shows "showing last render". FakeES pattern.

## Files

New:
- `packages/insight/src/dashboardRender.ts`
- `src/watchDashboard.ts`
- `packages/console/src/panels/Watch/dashboardStream.ts`
- `packages/console/src/panels/Watch/Dashboard.tsx`
- tests: `src/gem/__tests__/dashboardRender.test.ts`, `src/__tests__/watchDashboard.test.ts`,
  `packages/console/src/panels/Watch/__tests__/Dashboard.test.tsx`

Edited:
- `packages/insight/src/index.ts` — add `export * from "./dashboardRender.js";` to the
  barrel (matches the existing per-file `export *` pattern).
- `src/index.ts` — register `GET /api/watch/dashboard` behind `originGuard`.
- `packages/console/src/panels/Watch/index.tsx` — third toggle option + mount `Dashboard`.

## Open follow-ups (out of scope for v1)

- Wire `detectEvents`/dashboard for Gemini/Cline/Continue (one line per agent once their
  event shapes are parsed).
- Let the user pick a dashboard "lens" (progress tracker vs timeline vs diff view) via a
  prompt preset.
- Persist/share a final dashboard snapshot (ties into the existing share-card machinery).
