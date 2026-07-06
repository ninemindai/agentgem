# Goldmine Aggregates-Only Chat — Design

_Design 2026-07-05. Closes the one seam where raw transcript content enters the goldmine chat agent's context, applying the Insights Generator principle: the primary agent interacts with sessions only through tools that return processed/aggregated results; raw traces are handled by a separate processing layer and never traverse the chat agent's context window._

## Background & motivation

The `agentgem-goldmine` MCP server backs the goldmine **chat** tab: a local ACP agent (spawned with `permission: "deny"`, on the user's own login) that answers questions about the user's coding-agent sessions. It is handed the goldmine MCP server so it can call read tools while it reasons.

Today that agent's context is **almost** aggregates-only:
- The pre-injected brief (`buildGoldmineBrief`, `packages/insight/src/goldmineContext.ts`) is facts-only.
- Three of its four MCP tools — `search_sessions`, `get_artifact_detail`, `get_behavior_findings` — return metadata / aggregated detector output.
- **The exception:** `get_session_transcript` returns `TranscriptTurn[]` — scrubbed-but-**verbatim** user/assistant messages, chain-of-thought, tool inputs, and tool outputs (up to 50 KB each). When the chat agent calls it, that raw content lands directly in the chat agent's context window.

This is the single place the Insights Generator principle is violated. The research (Scale AI Insights Generator, arXiv:2605.21347) found that routing all trace access through a processing layer — agents get only aggregated/derived results, raw traces never enter the primary context — is what converts corpus analysis into measurable agent-improvement gains. This design brings the goldmine chat fully onto that model.

**Non-goals.** This does not wire the goldmine chat to the aggregator corpus DB (a separate, server-side, k-anon network-plane surface — out of scope, and a distinct future build). It does not touch the human-facing Inspect REST route (`GET /api/inspect/session`), which returns a `TranscriptView` to a person viewing their own data in a UI — that is not an LLM context and is correctly unaffected.

## Dependency / base

This work **stacks on PR #139** (`feat/atif-process-quality`). The deterministic summary reuses `sessionProcessQuality`, `stageProfile`, and the detector engine (`runDetectors`, `summarizeFindings`) that PR #139 added to `@agentgem/insight`. The branch `feat/goldmine-aggregates-only` is based on `feat/atif-process-quality`; if #139 merges to main first, rebase onto main, otherwise it ships as a stacked PR.

## The design in one paragraph

The chat agent gets two per-session tools and **no raw-dump tool**. `summarize_session` returns a deterministic structured aggregate (process-quality score, stage profile, that session's detector findings, metrics, and a counts-only event skeleton) — instant, no model call, no content. `ask_session` answers a specific natural-language question about what happened in a session by spawning an **ephemeral ACP subprocess running the session's own agent family** (a claude session → the claude ACP adapter; codex → codex), feeding it the raw *scrubbed* transcript plus the question, and returning **only that subprocess's text answer**. Raw content lives and dies inside the processing subprocess; the chat agent's window only ever sees the derived answer. `get_session_transcript` is removed from the goldmine MCP toolset.

## Components

### 1. `summarizeSession` — deterministic per-session aggregate (`@agentgem/insight`)

New module `packages/insight/src/sessionSummary.ts`. Pure-of-model (reads the one session's transcript from disk, as `behaviorFindings` already does; never throws — returns `null` on a missing/empty session).

```ts
export interface SessionSummary {
  sessionId: string;
  agent: string;
  project: string | null;
  model: string | null;
  gitBranch: string | null;
  startMs: number; endMs: number; durationMs: number;
  msgs: number; tokensIn: number; tokensOut: number; tokensCache: number;
  process: {
    score: number;                    // sessionProcessQuality
    label: "disciplined" | "loose" | "chaotic";
    stages: { exploration: number; implementation: number; verification: number; orchestration: number; other: number };
  };
  findings: DetectorSummary[];         // this session's detectors — id/title/advice/severity/count only
  events: {
    toolCalls: { name: string; count: number }[];   // low-cardinality tool names + counts
    filesTouched: number;
    edits: number;
    verifications: number;
  };
}

export function summarizeSession(
  sessionId: string,
  agent: string,
  dirs?: { claudeDir?: string; codexDir?: string },
): SessionSummary | null;
```

Composition (all existing `@agentgem/insight` functions):
1. Get the session's `SessionStat` **metadata** from the metadata scan path (`scanSessionsCached` → find by `sessionId`) — **not** `loadSessionTranscript`, which would build scrubbed content turns. The summary path therefore never constructs raw content at all.
2. Build that session's `SessionSequence` spine by scanning its single transcript file with `scanWorkflow(paths, inv, { retainSequences: true })` (the same call `behaviorFindings` uses). A Claude transcript file is one session (its filename is the sessionId); for Codex, resolve the file by scanning and matching `sessionId`. Select the `SessionSequence` whose `sessionId` matches (ignoring any subagent sidechain sequences).
3. `runDetectors(signal, ruleSpecs)` → `DetectorFinding[]` for that session.
4. `sessionProcessQuality(sequence, findings)` → score/label; `stageProfile(sequence.steps)` → stages.
5. Metrics from `meta`; `events` counted from the spine steps (tool-name counts, edit/verify counts via `isEdit`/`isVerify`, `filesTouched` = distinct edited/read file args **counted, not listed**).
6. `findings` via `summarizeFindings(findings)` — counts and canonical advice only.

**Secret-safe by construction:** every field is a number, a low-cardinality name (tool name, model, project basename, detector id/title/advice), or a score. No message text, thinking, tool input, or tool output; no file paths (only a count). This is asserted by an explicit test.

### 2. `ask_session` extraction via ACP subprocess (`@agentgem/insight`)

New module `packages/insight/src/sessionAsk.ts`. Answers a targeted question about one session by delegating to an ephemeral ACP agent.

```ts
export interface AskSessionResult {
  answered: boolean;               // false when no ACP agent maps to this source
  answer: string;                  // the subprocess's text answer, or a reason when answered=false
  agentUsed: string | null;        // the ACP agent id that processed it (e.g. "claude-code"), or null
}

export function askSession(
  sessionId: string,
  agent: string,
  question: string,
  opts?: { connectFn?: AcpConnectFn; timeoutMs?: number; maxChars?: number },
): Promise<AskSessionResult>;
```

Flow:
1. Load the raw **scrubbed** transcript via `loadSessionTranscript(sessionId, agent)` → `TranscriptView | null`. Null → `{ answered: false, answer: "session not found", agentUsed: null }`.
2. Map the session's source to an ACP agent family: `claude`/`claude-code` → the `claude-code` descriptor; `codex` → the `codex` descriptor (from `AGENTS` in `@agentgem/base`). Sources with no native ACP agent (`atif`, `cline`, `gemini`, `cursor`, `continue`) → `{ answered: false, answer: "raw interrogation isn't available for <source> sessions; use summarize_session", agentUsed: null }`.
3. Render the scrubbed transcript to a bounded text block (turns serialized role: text / tool_call name+input / tool_result output), total-capped at `maxChars` (default `60_000`); if it exceeds, keep the head and tail around the cap with an elision marker (a long session is windowed, not dropped).
4. Connect via the same plumbing the recommender uses — `connectAcpAdapter(descriptor, { clientName: "agentgem-goldmine-ask", permission: "deny" })` through the injectable `AcpConnectFn` seam — open a session, and `prompt` with a fixed extraction instruction + the transcript block + the user's question. The agent runs on the user's own login (`localAgentEnv` strips API keys).
5. Accumulate `agent_message_chunk` text (as the recommender does), return `{ answered: true, answer, agentUsed }`.
6. Never throws — connection/timeout failure degrades to `{ answered: false, answer: "raw interrogation failed: <reason>", agentUsed }`.

Testability: expose `setAskConnectFnForTests` (mirroring `setConnectFnForTests` in `acpRecommender.ts`) so unit tests inject a fake ACP connection. Tests assert (a) the raw transcript text is handed to the subprocess's prompt, (b) only the subprocess's answer is returned, (c) a source without an ACP agent returns `answered:false` without connecting, (d) an over-cap transcript is windowed.

### 3. Goldmine MCP tools (`src/goldmine/mcpServer.ts`)

- **Add** `summarize_session` — input `{ sessionId: string, agent?: string }` (default `"claude"`), returns `{ summary: SessionSummary | null }`. Thin adapter over `summarizeSession`.
- **Add** `ask_session` — input `{ sessionId: string, agent?: string, question: string }`, returns `{ result: AskSessionResult }`. Thin adapter over `askSession`.
- **Remove** `get_session_transcript` and its handler wiring from the goldmine MCP class, and drop `windowTranscript`'s use from this server (the function may remain in `tools.ts` if the human Inspect path or tests use it; if it becomes dead, delete it). The `search_sessions`, `get_artifact_detail`, and `get_behavior_findings` tools are unchanged.

House pattern (mirrors `src/distill/mcpServer.ts`): the MCP method is a transport adapter; logic lives in the unit-tested insight functions.

### 4. Brief update (`packages/insight/src/goldmineContext.ts`)

`buildGoldmineBrief` currently tells the agent it has read tools including `get_session_transcript`. Update the tool guidance to:
- `summarize_session` — per-session process quality, stage mix, findings, and metrics (call this first for any "how did session X go" question);
- `ask_session` — ask a specific question about what actually happened in a session (finds and quotes the relevant moments for you);
- and drop the mention of `get_session_transcript`.

## Data flow

```
chat agent (ACP, deny)
  │  "how did the auth refactor session go, and where did it get stuck?"
  ├─ summarize_session(sid) ──► summarizeSession() ──► { score, stages, findings, metrics, events }   [deterministic, no content]
  └─ ask_session(sid, "where did it get stuck?")
        └─► askSession()
              ├─ loadSessionTranscript(sid) ──► scrubbed TranscriptView   [raw, scrubbed]
              ├─ spawn session-family ACP agent (ephemeral subprocess) ◄── transcript + question
              └─► returns ONLY the agent's text answer  ─────────────────► chat agent context
                    (raw transcript never leaves the subprocess)
```

## Error handling

- Both insight functions are total: missing session → `null` / `answered:false`; malformed transcript lines already degrade in the existing parsers; ACP failures degrade to `answered:false` with a reason. A failing tool never crashes the MCP server.
- Source without a native ACP agent is a first-class, non-error result steering the agent back to `summarize_session`.

## Testing

- `summarizeSession`: fixture transcripts — a verification-heavy clean session (high score, disciplined, stage counts correct), a messy session (findings present, correct edit/verify/tool counts), a nonexistent id (`null`). **Explicit secret-safe test:** deep-scan the returned object for any substring of known message/tool-output fixture content → must be absent.
- `askSession`: with an injected fake `AcpConnectFn` — raw transcript reaches the fake's prompt; only the fake's answer returns; `atif`/`cline`/etc. source → `answered:false`, no connect call; over-cap transcript → windowed head+tail.
- Goldmine MCP tools: thin-adapter tests for the two new tools; a regression test that `get_session_transcript` is no longer registered and the other three tools are unchanged.
- Brief: `buildGoldmineBrief` output mentions `summarize_session`/`ask_session` and not `get_session_transcript`.
- Full-suite regression gate (baseline: the one pre-existing `consoleMount.test.js` failure).

## File structure

| File | Change |
|---|---|
| `packages/insight/src/sessionSummary.ts` | new — `summarizeSession` + `SessionSummary` |
| `packages/insight/src/sessionAsk.ts` | new — `askSession` + `AskSessionResult` + `setAskConnectFnForTests` |
| `packages/insight/src/index.ts` | export the two new modules |
| `src/goldmine/mcpServer.ts` | add two tools, remove `get_session_transcript` |
| `packages/insight/src/goldmineContext.ts` | brief tool guidance |
| `src/__tests__/*` and/or `packages/insight` tests | new tests per above |

## Open considerations (resolved)

- **Which model interprets the raw trace?** The session's own agent family via the ACP registry (claude→claude-code, codex→codex). Exact model snapshot isn't pinned (runs on the user's current CLI/login), which is acceptable — the goal is a capable same-harness reader, not bit-exact reproduction.
- **Cost gradient:** `summarize_session` is instant/deterministic and is the default; `ask_session` is a real model call (user's own quota) reserved for genuine "dig into what happened" questions. The brief encodes that preference.
- **Corpus/aggregator reach** is deliberately out of scope (network-plane surface; separate future build).
