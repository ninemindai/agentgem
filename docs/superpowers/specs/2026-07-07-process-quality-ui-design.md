# Process-Quality UI — Design

_Design 2026-07-07. Surfaces the per-session process-quality signal (score, label, stage profile, detector findings) — computed in #139 and already on `main` via `summarizeSession` — in the console's session drill-down. Completes the follow-up #139 flagged: the score is computed but has no UI._

## Background & motivation

`@agentgem/insight`'s `summarizeSession(sessionId, agent)` (on `main`) computes a full per-session aggregate: `process: { score, label, stages }` (AgentLens-style: 0–100, `disciplined`/`loose`/`chaotic`, and an intent-stage profile), `findings: DetectorSummary[]` (retry-storm, thrash-loop, no-verify-finish, regression-cycle, unverified-tail — each with advice), plus metrics and an event skeleton. Today its only consumer is the goldmine MCP tool; there is no REST route and no console UI. The `#139` process-quality work explicitly deferred "surfacing the score in the console."

The console already has the exact pattern to mirror: `panels/Observe/HygieneReport.tsx` is a self-fetching per-session card (Claude-only) that renders a score+verdict badge and a factors list, backed by `GET /api/inspect/session/hygiene`. A ProcessQuality card is its near-identical sibling.

**Scope (ratified):** per-session card only. The Sessions-list score pills and the project-level `atRiskRate` rollup (`processQualityReport`, currently uncallered) are explicit follow-ups, out of scope here.

## Architecture

Three thin pieces, each mirroring an existing counterpart:

1. **REST route** `GET /api/inspect/session/process` (`src/gem.controller.ts`) — wraps the existing `summarizeSession`. Modeled verbatim on `inspectSessionHygiene` (`gem.controller.ts:445`).
2. **Client route mirror** `processRoute` (`packages/console/src/api/routes.ts`) — beside `hygieneRoute`.
3. **React card** `ProcessQualityReport.tsx` (`packages/console/src/panels/Observe/`) — cloned from `HygieneReport.tsx`, rendered as a sibling in `TranscriptViewer.tsx`.

Data flow: session drill-down opens (`#/sessions/<agent>/<id>`) → `TranscriptViewer` renders → the card auto-fetches `processRoute` on mount (Claude-only) → route calls `summarizeSession(id, agent)` → card renders `process` (score/label badge + stage bar) and `findings` (list). Raw content never involved — `summarizeSession` returns aggregates only (the secret-safe property established in #139/#167).

## Components

### 1. Backend route (`src/gem.controller.ts`)

Import `summarizeSession` from `@agentgem/insight` (add to the existing insight import in this file if one is present; otherwise a new import). Add a response schema beside the other Inspect schemas (mirrors the `SessionSummary` interface exactly; `process`/`events` nullable):

```ts
const StageProfileSchema = z.object({
  exploration: z.number(), implementation: z.number(), verification: z.number(),
  orchestration: z.number(), other: z.number(),
});
const DetectorSummarySchema = z.object({
  id: z.string(), title: z.string(), advice: z.string(),
  severity: z.enum(["info", "warn"]), count: z.number(), sessions: z.number(),
});
const SessionSummarySchema = z.object({
  sessionId: z.string(), agent: z.string(),
  project: z.string().nullable(), model: z.string().nullable(), gitBranch: z.string().nullable(),
  startMs: z.number(), endMs: z.number(), durationMs: z.number(),
  msgs: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(),
  process: z.object({ score: z.number(), label: z.enum(["disciplined", "loose", "chaotic"]), stages: StageProfileSchema }).nullable(),
  findings: z.array(DetectorSummarySchema),
  events: z.object({
    toolCalls: z.array(z.object({ name: z.string(), count: z.number() })),
    filesTouched: z.number(), edits: z.number(), verifications: z.number(),
  }).nullable(),
});
```

The handler, mirroring `inspectSessionHygiene`:

```ts
@get("/inspect/session/process", { query: InspectSessionQuerySchema, response: SessionSummarySchema })
async inspectSessionProcess(input: { query: z.infer<typeof InspectSessionQuerySchema> }): Promise<z.infer<typeof SessionSummarySchema>> {
  if (input.query.agent !== "claude") throw new InvalidInputError("Process quality is available for Claude sessions only.");
  const summary = await summarizeSession(input.query.id, input.query.agent);
  if (!summary) throw new InvalidInputError(`No Claude session '${input.query.id}' found.`);
  return summary;
}
```

Claude-only guard matches `summarizeSession`'s own scope (deep analysis is Claude-spine only; non-Claude would yield `process: null`). `summarizeSession` returns `null` on not-found → mapped to `InvalidInputError` (the same 400 contract the hygiene route uses).

### 2. Client route (`packages/console/src/api/routes.ts`)

Mirror the server schema and define the route beside `hygieneRoute`:

```ts
// Mirrors the server SessionSummarySchema (src/gem.controller.ts) exactly.
export const SessionSummarySchema = z.object({ /* … identical to §1 … */ });
export const processRoute = defineRoute("GET", "/api/inspect/session/process", {
  query: z.object({ id: z.string(), agent: z.enum(["claude", "codex"]) }),
  response: SessionSummarySchema,
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
```

### 3. React card (`packages/console/src/panels/Observe/ProcessQualityReport.tsx`)

Cloned from `HygieneReport.tsx` — same props `{ apiBase, agent, sessionId }`, same auto-fetch effect (`alive` guard, loading/error state), same Claude-only early-return (`if (agent !== "claude") return null`). Renders:

- **Score + label badge** — reuse the `hyg-verdict`/`hyg-score`/`hyg-word` markup shape under new `pq-` classes: `<div className={"pq-verdict is-" + process.label}><span className="pq-score">{process.score}</span><span className="pq-word">{process.label}</span></div>`.
- **Stage bar** — a single horizontal bar segmented by the four named intent stages (exploration/implementation/verification/orchestration; `other` omitted from the bar), each segment width = `stage / totalNamed * 100%`, mirroring the `scorecard-bar`/`scorecard-bar-fill` pattern. Zero-total → render nothing.
- **Findings list** — `findings` is `DetectorSummary[]` (identical shape to hygiene factors), rendered with the `hyg-factors` `<ul>` pattern under `pq-factors`: `<b>{title}</b> ×{count}` + advice line. Empty findings → a muted "No process issues detected." note.
- **`process === null`** (Claude session that couldn't be spine-analyzed) → a muted "No process data for this session." note, matching how HygieneReport handles `curve.length === 0`.

Header: `<div className="pq-head">Process quality</div>` (mirrors `hyg-head`). The card ignores the summary's metrics fields — duration/tokens/model are already in the `TranscriptViewer` header.

**Placement:** in `TranscriptViewer.tsx`, add `<ProcessQualityReport apiBase={apiBase} agent={agent} sessionId={sessionId} />` immediately after `<HygieneReport … />` (line 67), before `<DistillSection>`.

**Styles:** add `pq-*` classes to `packages/console/src/shell/theme.css`, reusing the hygiene/scorecard visual language (label colors keyed to disciplined=good/loose=warn/chaotic=bad via the existing `--accent`/`--muted` and severity palette).

## Error handling

- Non-Claude session: card early-returns (renders nothing) — never calls the route; the route also guards defensively.
- Not found / fetch error: card shows `obs-error` (same as HygieneReport); route throws `InvalidInputError` (400).
- `process`/`findings` empty or null: muted informational notes, never an error.
- The route is a pure wrapper over an already-reviewed, never-throwing `summarizeSession`; it adds only the Claude guard and the null→400 mapping.

## Testing

- **Controller** (`src/__tests__/gem.controller.test.ts`, hermetic home): a Claude fixture session → `c.inspectSessionProcess({ query: { id, agent: "claude" } })` returns `process.score` a number, `process.label` one of the three, `findings` an array; a non-Claude agent → throws `InvalidInputError`; an unknown id → throws `InvalidInputError`.
- **Card** (`packages/console/src/panels/Observe/ProcessQualityReport.test.tsx`, jsdom, cloned from `HygieneReport.test.tsx`): mock `processRoute.call` with a sample summary → asserts the score, the label word, and a finding title render; a summary with `process: null` → asserts the muted note; `agent="codex"` → asserts no fetch and nothing rendered.

## File structure

| File | Change |
|---|---|
| `src/gem.controller.ts` | new `SessionSummarySchema` (+ `StageProfileSchema`, `DetectorSummarySchema`) and `@get("/inspect/session/process")`; import `summarizeSession` |
| `src/__tests__/gem.controller.test.ts` | route tests |
| `packages/console/src/api/routes.ts` | `SessionSummarySchema` mirror + `processRoute` + `SessionSummary` type |
| `packages/console/src/panels/Observe/ProcessQualityReport.tsx` | new card |
| `packages/console/src/panels/Observe/ProcessQualityReport.test.tsx` | card test |
| `packages/console/src/panels/Observe/TranscriptViewer.tsx` | render the card after `<HygieneReport>` |
| `packages/console/src/shell/theme.css` | `pq-*` classes |

## Resolved design choices

- **Response shape:** return the full `SessionSummary` (reuse `summarizeSession` as-is); the card picks the `process`/`findings` fields. No projection function — least code, reuses a reviewed function.
- **Card content:** score + label badge, stage bar, and findings list (not score-only) — the stage bar and findings are what make it more than a bare number, and the data is already computed.
- **Visual:** flat score+word badge matching the adjacent `HygieneReport`, not a ring gauge — consistency over novelty.
- **Out of scope:** Sessions-list per-row pills; project `atRiskRate` rollup (`processQualityReport`).
