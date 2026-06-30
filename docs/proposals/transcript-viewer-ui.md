# Proposal: Session transcript viewer for the Inspect panel

- **Status:** Phases 1–4 implemented (PR #43)
- **Date:** 2026-06-30
- **Area:** Console Inspect panel (`packages/console/src/panels/Observe`), insight transcript
  parsing (`packages/insight/src/observeScan.ts`), redaction (`packages/insight/src/scrub.ts`)
- **Depends on:** the shipped Inspect aggregate (`observeScan` → `aggregateObserve` →
  `Observe`/`Dashboard`), the secret-safe scrubber, the distillation path (`distill.ts`)

## Summary

Add a **per-session transcript viewer** as a drill-down from the Inspect panel. Today
Inspect shows an *aggregate* over local Claude/Codex sessions — a sortable table of
sessions (project · agent · model · duration · msgs · tokens · recency) plus a heatmap and
charts. There is no way to open a single session and read what actually happened.

This proposal adds that missing surface: click a session row → open a **hierarchical
turn → tool-call tree** that replays the whole session, with verbatim inputs/outputs,
per-turn tokens/cost, a side-by-side diff mode, and lightweight annotation that feeds
distillation. It deliberately reuses the interaction patterns the LLM-tracing ecosystem
has already converged on (trace-tree explorers, session replay, diff views), re-skinned
for a *personal session you own and curate* rather than a production ops dashboard.

## Motivation

The aggregate answers *"how much / how often / how expensive"*. It cannot answer the
question users actually have once they're hooked: **"what did I do in that session, and
which part is worth keeping?"**

Three concrete gaps:

1. **No legibility.** A long agent session is hundreds of turns and tool calls in a JSONL
   file. The metadata row tells you it was 412 messages and 1.2M tokens; it can't show you
   the five tool calls that mattered.
2. **No on-ramp to distillation.** The "distill this" action is the core conversion from
   *I have sessions* to *I have a Gem*. Right now there's no place to stand inside a
   session and say "package **this** part." The viewer is where that gesture lives.
3. **No comparison.** Users iterate — same task, different prompt, v1 vs v2. There's no
   way to put two runs (or a run vs. a Gem's reference run) next to each other.

## Design

### Where it lives

A new drill-down view owned by the existing **Inspect** page (`observePage`, id `observe`,
route `#/inspect`). The session table already tracks an expandable row (`openId` in
`Dashboard.tsx`); promote that from a metadata expand into a full-height **transcript
view** (route `#/inspect/:sessionId`), with a back affordance to the aggregate.

### The data path (the real work)

The current scan is **metadata-only by design**. `observeScan.ts` is explicit: it reads
"usage, timestamps, model, type, cwd/id ONLY — never message text" (mirroring
`workflowScan.ts`). The viewer needs message **content**, so it cannot reuse the aggregate
payload — it needs a second, on-demand read path:

- **New route** `inspectSessionRoute(sessionId)` → returns the parsed, **scrubbed**
  transcript for one session. Read lazily (only when a session is opened), never as part of
  the aggregate scan, so the privacy/perf properties of Inspect's one-shot scan are
  preserved.
- **New parser** alongside `parseClaudeTranscript`: instead of folding records into a
  `SessionStat`, emit an ordered tree of **turns** and **spans**. The record shapes are
  already understood by `observeScan` — `type: user | assistant`, `message.content` items
  (including `tool_use` / `tool_result`), `message.usage`, `timestamp`, `model`. Reuse
  `jsonLines()` and the same Claude + Codex store discovery.
- **Redaction is mandatory and on the read path.** Every content string passes through
  `scrub.ts` before it leaves the server / reaches the renderer. The viewer must never be
  the hole in the secret-safe boundary. (Open question below on cache vs. scrub-on-read.)

Proposed view model (illustrative, not final):

```ts
type TranscriptSpan =
  | { kind: "message"; role: "user" | "assistant"; text: string; tokens?: TokenBreakdown }
  | { kind: "tool_call"; name: string; input: unknown; output?: unknown; ms?: number; error?: string };

type TranscriptTurn = { id: string; tsMs: number; spans: TranscriptSpan[]; tokens: TokenBreakdown };
type TranscriptView = { sessionId: string; meta: SessionStat; turns: TranscriptTurn[] };
```

### The five interaction patterns

Each maps to a real seam; none requires new infra beyond the read path above.

1. **Hierarchical trace-tree, drill-down spans.** Collapsible turn → span tree. A turn
   collapses to one line (role, first line, token/cost chip); expand to see verbatim
   input/output and, for tool calls, name + args + result + duration + error. This is the
   primary surface — make a long session scannable in seconds.
2. **Session replay.** The turns are already time-ordered; render them as a vertical
   timeline with relative timestamps. (No new data — `tsMs` per turn.)
3. **Diff / side-by-side.** Open two sessions (or a session vs. a Gem's reference run) in a
   two-column view with aligned turns and changed-region highlighting. Reuses the same
   `TranscriptView`; the diff is a pure client-side alignment over two of them.
4. **Light annotation for distillation.** Let the user select a span or a contiguous range
   and tag it ("worth packaging"). Selected ranges become the seed input to `distill.ts`
   — the viewer is the natural launch point for the **"distill this"** CTA. Keep it light:
   tagging + a distill button, **not** a scoring/eval rig.
5. **Per-turn cost/token surfacing.** Inspect already aggregates `tokensIn/out/cache`;
   surface the same breakdown per turn and per span as an inline chip. Frames a session as
   "the concrete, costed way I got the agent to deliver this."

### Visual register (explicit divergence)

The trace-tree *skeleton* is borrowed; the *register* is not. This should read like a
**personal library / notebook you can curate and package** — calm, archival, asset-shaped
— not a monitoring dashboard (no alert reds, error-rate gauges, latency percentiles).
Reuse the existing console tokens (`--accent`, `--emerald`, the `obs-*` class family) so it
sits inside the current Inspect styling rather than introducing a new look.

## Implementation sketch (phased)

1. **Read path + parser.** `inspectSessionRoute` + the turn/span parser + scrub-on-read;
   unit-tested against the same Claude/Codex fixtures `observeScan` uses. (No UI yet.)
2. **Tree viewer (pattern 1, 2, 5).** Drill-down from the session row; collapsible tree,
   timeline order, token/cost chips. This alone closes the legibility gap.
3. **Distill hook (pattern 4).** Span selection + tag + wire the "distill this" CTA into
   `distill.ts`.
4. **Diff (pattern 3).** Two-column aligned comparison. Lowest priority; ships last.

Each step is independently shippable and testable; (2) is the high-value core.

## Non-goals

- **Not** an eval/scoring platform — no LLM-as-judge, no metrics over many sessions, no
  CI gates. Annotation here exists only to seed distillation.
- **Not** a telemetry stream or remote ingestion. This reads the **local** session store
  on demand; nothing is sent anywhere.
- **Not** a new top-level panel — it's a drill-down inside Inspect.

## Open questions

- **Scrub-on-read vs. cached scrubbed transcripts.** Re-scrubbing a large transcript on
  every open is simple and keeps no extra copy on disk, but may be slow for very long
  sessions. A cache (à la `analysisCache.ts`) is faster but stores scrubbed content —
  decide the trade-off and where the cache, if any, lives.
- **Codex/other-harness record shape.** `observeScan` already handles Claude + Codex for
  metadata; confirm the content/tool-call shape for each harness the parser must cover, and
  how gracefully it degrades on unknown shapes (degrade-to-text, never throw — match the
  existing scan's robustness contract).
- **Diff alignment heuristic.** ~~Turn-by-turn alignment is naive when two runs diverge
  early.~~ _Resolved (phase 4):_ alignment uses an LCS over coarse turn *signatures*
  (role + tool-name sequence + first message line), so a shared tail stays aligned after an
  early divergence instead of smearing into false "changed" rows. Within an aligned pair,
  full content decides same-vs-changed. See `packages/console/src/panels/Observe/diff.ts`.
- **Large-session rendering.** Hundreds of turns × verbose tool output needs virtualization
  / lazy expansion so the tree stays responsive.
