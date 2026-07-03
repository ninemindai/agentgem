# Chat Behavior Coach — Design

**Date:** 2026-07-02
**Status:** Draft — awaiting user review
**Depends on:** session detectors (origin/main e2cac2d), goldmine chat tab (origin/main)

## Purpose

Surface the just-shipped detector findings (problematic session behaviors + advice) through the goldmine chat, so the chat agent can coach the user: "retry-storm fired 5× this week — read the full error before re-running." This is the deferred "UI/chat surfacing" slice of the detector feature.

## Decision: teaser + tool (proactive invitation, on-demand detail)

Three approaches considered:

- **A. Teaser + MCP tool (chosen)** — one line in the first-turn chat brief when findings exist ("N behavior patterns detected recently — ask me about them"), plus a `get_behavior_findings` MCP tool the agent calls for detail. Proactive enough to invite coaching; near-zero brief cost; detail only when asked.
- **B. MCP tool only** — zero brief cost but the coach is never proactive; user must know to ask. Rejected: the product motivation is proactive coaching.
- **C. Full brief injection / UI chips** — most visible, but burns brief tokens on every chat (or a much larger console-UI slice) regardless of user intent. Rejected for v1; chips can layer on later.

## Data path: fresh capped scan (not cache-coupled)

A shared helper runs the deterministic detector pipeline directly instead of reading the insights cache:

- The insights cache is keyed `(root, token)`; chat is global, so there is no single cache entry to read, and a cold cache would silently yield "no findings."
- The detector pipeline is LLM-free; cost is transcript parsing only, bounded by caps below.

## Components

### 1. `src/goldmine/behaviorFindings.ts` (new)

```ts
export interface BehaviorFindingsOptions {
  days?: number;           // look-back window, default 14, clamp 1..90
  maxTranscripts?: number; // newest-first cap, default 100, clamp 1..100
  dir?: string;            // claudeDir override (tests)
  rulesDir?: string;       // detector-rules dir override (tests)
  now?: () => number;      // clock seam (tests)
}
export interface BehaviorFindings {
  summary: DetectorSummary[];   // from summarizeFindings — title/advice/severity/count/sessions
  findings: DetectorFinding[];  // capped at 50, newest sessions first
  scanned: { transcripts: number; sessions: number; days: number };
}
export function collectBehaviorFindings(opts?: BehaviorFindingsOptions): BehaviorFindings
```

Implementation: `allClaudeTranscripts(dirs.claudeDir)` → filter mtime within `days`, sort newest-first, cap at `maxTranscripts` → `scanWorkflow(paths, inv, { retainSequences: true })` where `inv` is the same all-projects stub `computeInsights` uses for `root === "*"`: `{ project: { root: "*", name: "All projects", skills: [], mcpServers: [], hooks: [], instructions: [] } }` → `runDetectors(signal, loadRuleDetectors(rulesDir))` → `summarizeFindings(findings, [...DETECTORS, ...ruleSpecs])`. Never throws: any failure returns the empty result (`console.error`, same contract as the rest of the analysis path). Pure policy (caps, window) lives here; the detector engine is untouched.

### 2. Brief teaser (`buildBrief` in `src/index.ts` + brief builder)

`GoldmineBriefInput` (packages/insight/src/goldmineContext.ts) gains an optional field:

```ts
behavior?: { patterns: number; topTitle: string }  // omitted when no findings
```

`buildGoldmineBrief` renders, when present, one line:
`Behavior: <patterns> recurring pattern(s) in recent sessions — top: "<topTitle>". The user can ask you for coaching on these; call get_behavior_findings for detail.`

`buildBrief` in `createApp` calls `collectBehaviorFindings()` inside its existing try/catch (already best-effort) and passes `{ patterns: summary.length, topTitle: summary[0].title }` when `summary.length > 0`.

### 3. MCP tool (`src/goldmine/mcpServer.ts`)

```ts
const BehaviorInput = z.object({
  days: z.number().int().min(1).max(90).default(14),
});

@tool("get_behavior_findings", {
  input: BehaviorInput,
  description: "Recurring problematic behaviors detected in the user's recent coding sessions (retry storms, thrash loops, unverified finishes, user-defined rules), with per-pattern advice. Use when the user asks how to improve, what went wrong, or about their habits.",
})
```

Returns `collectBehaviorFindings({ days })` verbatim. Read-only, no filesystem writes, consistent with the chat's `permission:"deny"` posture.

## Privacy

Findings carry only what the detector layer already guarantees: verb/count-derived `detail`, transcript basenames, `msgIndices`. Nothing new is exposed; the data never leaves the local chat session.

## Error handling

- `collectBehaviorFindings` never throws (empty result + `console.error`).
- Empty result ⇒ no teaser line in the brief; the tool returns `{ summary: [], findings: [], scanned: {...} }` and the agent says there's nothing flagged.

## Testing

- `behaviorFindings.test.ts`: fixture claudeDir with synthetic transcripts (one containing a 3× identical Bash step → retry-storm fires; one clean), window/cap behavior (old transcript excluded by `days`), rules-dir rule picked up, never-throw on missing dir.
- Brief: `goldmineContext` test — teaser line present with `behavior` set, absent without.
- MCP tool: thin-delegation smoke test only — the tool body is one call to `collectBehaviorFindings({ days })`; assert the input clamp (days 1..90, default 14) and that the method returns the helper's result shape. All behavioral coverage lives in `behaviorFindings.test.ts` via its `dir`/`rulesDir`/`now` seams.
- Chat route: existing `buildBrief` tests extended only if they assert brief content.

## Out of scope (deferred)

- UI chips / panel rendering of detectorSummary.
- Scheduled proactive digests ("定时教练" timed coach) — separate feature on the warm daemon.
- Cross-session trend history ("5× this week vs 2× last").
- Any LLM-cost detectors.

## Open question for review

Caps default (14 days / 100 transcripts / 50 findings) are judgment calls — tune freely; they only live in `behaviorFindings.ts`.
