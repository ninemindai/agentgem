# Session blast radius — design

**Date:** 2026-07-15
**Status:** approved for implementation
**Inspiration:** [cosmtrek/mindwalk](https://github.com/cosmtrek/mindwalk) — repo-as-night-map
session replay. Borrowed: per-target touch depth (seen → read → edited), cool/warm bucketed
playback histogram, click-to-jump marks, pin-a-file inspector, and the "outside the repo
boundary" classification. Not borrowed: 3D/Three.js, Go server, LLM judge (we already have
rubrics/process quality).

## What

A third lens in **History → Session** (`TranscriptViewer`): an interactive map of everything
one session touched — project files, paths outside the project, skills, subagents, MCP
servers, and shell commands — replayable over the session timeline. Scrub or play the
session and watch the blast radius grow; click any target to see its visit history and jump
the playhead.

## Why

The context timeline answers "how did the window grow"; the structure map answers "what were
the phases". Neither answers "**where did this session actually land** — which files, how
deep, and did it stray outside the project?" That's the review question for any agent run.

## Approaches considered

- **A. Extend `scanWorkflow` with an uncapped touch series.** Rejected: `steps` is capped
  (`SEQ_CAP_PER_SESSION = 40`), skips `Skill`/`mcp__*` calls by design, and `scanWorkflow`
  is the trust boundary for attestation — growing it for a UI feature risks every other
  consumer (corpus-wide scans would retain uncapped arrays per session).
- **B. New standalone pure scan + new route (chosen).** Mirrors the
  `sessionHygieneCore` pattern exactly: resolve one session → parse one file → shaped
  report. Single-file parse per request is the same cost class as the hygiene route.
  Zero impact on existing scan consumers.
- **C. Client-side extraction from the existing `TranscriptView`.** Rejected: the
  transcript route stringifies+scrubs tool inputs (paths would be re-parsed out of prose),
  drops `msgIndex`/tool_use ids (no error pairing), and never carries the session cwd, so
  project-vs-outside classification is impossible.

## Data model

New `packages/insight/src/blastScan.ts` (pure, total — corrupt lines skipped):

```ts
export type BlastAction = "read" | "search" | "edit" | "exec" | "skill" | "agent" | "mcp" | "other";
export type BlastZone = "project" | "home" | "tmp" | "outside";

export interface BlastEvent {
  seq: number;              // 0..n over kept events
  msgIndex: number;         // JSONL line provenance
  tsMs: number | null;      // record timestamp when present
  tool: string;             // raw tool name (mcp__* collapsed to server token in target)
  action: BlastAction;
  target: string | null;    // project-RELATIVE path | de-homed outside path | skill/agent/server name | bash verb
  zone?: BlastZone;         // only for path targets (read/search/edit)
  sidechain?: boolean;      // subagent activity — kept, flagged (it IS blast radius)
  error?: boolean;          // paired tool_result.is_error
}

export interface BlastReport {
  meta: { sessionId: string; transcript: string; project: string | null; startMs: number; endMs: number };
  events: BlastEvent[];     // uncapped, ordered by msgIndex
}
```

**Action mapping** (superset of `toolCategory.ts`, conservative like mindwalk — unknown
stays `other`): Read→read; Grep/Glob→search; Edit/Write/NotebookEdit→edit; Bash→exec
(target = the coarse verb from `scrubStep`, e.g. `git commit`); Skill→skill (target =
skill name); Task/Agent→agent (target = subagent_type); `mcp__*`→mcp (target = server
token via `mcpServerToken`); else other (target null).

**Zone classification** happens against the RAW path and RAW session cwd (before
de-homing): under cwd → `project` with a relative target; under `$HOME` → `home`;
`/tmp`/`/private/tmp`/os tmp → `tmp`; else `outside`. Non-project targets are passed
through `scrubText` (de-home + secret redaction). `meta.project` is `scrubText(cwd)`.
Relative-or-non-path args (e.g. a bare Glob pattern) stay `project`-zoned by assumption
only when they don't start with `/`; a bare pattern keeps `zone: "project"`.

**Error pairing:** tool_result blocks (user records) matched back by `tool_use_id`,
identical approach to `scanWorkflow`. Sidechain events are kept (flagged) — a subagent's
edits are part of the blast radius; the UI renders them with a distinct ring.

## Server seam

- `src/sessionBlastCore.ts` — `sessionBlast(id, agent)`: `resolveClaudeSession` → read
  file → `scanSessionBlast(text, { cwd, transcript, sessionId })`. `BlastInputError` for
  the 400 class, mirroring `HygieneInputError`.
- `src/gem.controller.ts` — `BlastReportSchema` (zod) + `@get("/inspect/session/blast")`,
  Claude-only guard like hygiene.
- `packages/console/src/api/routes.ts` — mirrored schema + `blastRoute` (the schema must
  be mirrored in BOTH files, per the established convention).

## Client

`packages/console/src/panels/Observe/`:

- **`blastModel.ts` (pure)** — `buildBlast(report)` →
  - `targets`: deduped map key `zone|target` (or `kind|name` for skills/agents/mcp/exec),
    each with ordered visit list `{seq, tsMs, action, tool, error}` and a deepest-touch
    rank (edit > read/search > seen).
  - `groups`: deterministic ordering — project files grouped by top-level directory
    (alpha-sorted, same tree ⇒ same map, mindwalk's replay-comparability property), then
    outside zones (home/tmp/outside), then skills, subagents, MCP servers, commands.
  - `buckets`: ≤72 histogram buckets over `tsMs` when ≥90% of events carry timestamps,
    else over `msgIndex`; each bucket = `{observe, mutate, errors, firstSeq}` (cool/warm).
- **`BlastRadius.tsx`** — auto-fetches like `ContextTimeline` (Claude-only, null for
  codex). Layout: map + `useSplit` inspector rail; playback deck under the map.
  - Map cells: fill color by deepest touch **at the playhead** using the existing
    category tokens (`read`→`--blue`, search→`--slate`, `edit`→`--green`, skills
    `--purple`, agents `--pink`, mcp `--teal`, exec `--slate`); opacity steps by visit
    count (1 / 2–3 / 4+); touched-later-than-playhead → faint outline so the full extent
    is always visible. Sidechain-only targets get a dashed ring. Error anywhere on a
    target → small red corner dot.
  - Playback deck: SVG histogram (cool = read/search/exec/mcp below axis-color, warm =
    edit), red tick per bucket with errors, playhead line. Click/drag to seek. Play/pause
    at a fixed buckets-per-second. Keyboard on the focused deck: `Space` play/pause,
    `←/→` step one event (`Shift` ×10), `E` next edit, `X` next error, `Home`/`End`.
  - Inspector rail: summary chips (files touched / edited / outside / errors / skills /
    agents) + pinned target's visit history; clicking a visit jumps the playhead to its
    seq. Nothing pinned → summary + hint.
- **`TranscriptViewer.tsx`** — render `<BlastRadius/>` directly after `<ContextTimeline/>`.
- **`theme.css`** — new `.br-*` rules for every new className, same warm-paper tokens
  (single theme, no dark mode).

## Testing

- Root `src/gem/__tests__/blastScan.test.ts` (CI-gated, runs compiled dist): fixture JSONL
  covering — project/home/tmp/outside classification, relative target for project files,
  Skill/Task/mcp/Bash mapping, error pairing by tool_use_id, sidechain flagging, secret
  token never appears in any target, uncapped (>40 events), timestamps parsed.
- Console (local-only, CI skips): `blastModel.test.ts` (grouping determinism, deepest
  touch, bucketing fallback msgIndex vs tsMs, playhead state), `BlastRadius.test.tsx`
  smoke (fetch-mocked render, codex → null), following `ContextTimeline.test.tsx`.
- `grep -c "br-…" theme.css` > 0 for every new className (CLAUDE.md UI rule); verify in a
  real browser.

## Non-goals / deferred

- Codex sessions (scan reads Claude JSONL; the guard mirrors hygiene/process/distill).
- 3D terrain view, LLM session judge (rubrics already exist), cross-session comparison,
- Treemap-by-file-size layout (needs FS stat of the live repo; the map is transcript-only).
