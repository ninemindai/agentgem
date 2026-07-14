# Recall: search across every past session

Your best agent work is scattered across hundreds of past sessions — the time you
got a tricky migration right, the prompt that finally produced the diagram you
wanted, the debugging path that worked. **Recall** makes all of it searchable.
Open it at **`#/recall`** in the console, type what you remember, and it finds the
moments across your whole session history — instantly, and locally.

Recall never leaves your machine. The index is built over **scrubbed** transcript
turns (the same field-aware scrubber the rest of AgentGem uses — see
[Redaction](redaction.md)), so file contents, pasted prompts, and secrets are
dropped before anything is indexed.

![Recall — a search box over every past session, with project / agent / since filters and a selection bar with "Chat with these" and "Extract across these" exits.](screenshots/recall.png)

## Search

Type a query and results appear as you type (a 250 ms debounce; an empty box does
nothing and makes no request). Under the hood it's a **BM25 full-text search** over
your transcript turns, backed by SQLite FTS5 through Node's built-in `node:sqlite` —
no external database, no server round-trip to anyone else. The index lives at
`~/.agentgem/.agentgem/recall-index.db` and builds in the background; a
"indexing *N* of *M*" hint shows while it catches up.

Ranking is **proven-use aware**. On top of the text score, sessions that used an
artifact which went on to produce a *good outcome* get a boost: the insights judge
pass records per-session outcomes into a separate `artifact-outcomes.db`, and a
Wilson-shrunk outcome score (shrunk so one lucky session can't outrank a track
record) nudges the proven work up the list. It's additive — a query still matches on
text first; proven use only breaks ties toward what actually worked.

Three filters narrow the field:

- **Project** — scope to one repo.
- **Agent** — Claude, Codex, …
- **Since** — Any time · Last 24 hours · Last 7 / 30 / 90 days.

## Moments

Each result is a **moment**: the single best-matching turn in a session, rolled up
from the underlying turn hits. A moment card shows the **project**, the **git
branch**, the **agent**, how long ago it was, the matched snippet with your terms
highlighted, and a **"*N* matching turns"** count so you can tell a one-off mention
from a session that's really about the thing you searched for.

From a moment you can:

- **Open turn ↗** — jump straight to that turn in the full transcript
  (`#/sessions/<agent>/<session>?turn=<n>`), where the
  [session timeline](context-hygiene.md#the-session-timeline) and the raw messages
  live.
- **Select it** — click the card to add it to a working set, then take one of two
  **exits** over everything you've selected.

## Two exits: chat, or extract

Selecting a few moments turns Recall from a search box into a way to *ask across*
those sessions:

- **💬 Chat with these** — a running conversation grounded in the selected sessions.
  Each message you send starts a fresh fan-out across the same sessions and keeps the
  prior turns as history, so you can drill in ("which of these used a worktree?" →
  "show me the exact command").
- **⇩ Extract across these** — one question, one pass, one report you can export as
  **Markdown, JSON, HTML, or CSV**. Good for "pull every deploy command I ran this
  month" or "summarize how I set up auth in each of these."

Both exits run the same **funnel**: a capped `ask_session` fan-out that reads each
selected session for a per-session answer, then a cross-session synthesis pass. The
read runs over a local, ephemeral Claude subprocess in **read-only plan mode** — it
never edits your files — and degrades to a deterministic join if the agent is
unavailable, so an exit always returns something.

## The `agentgem-goldmine` MCP server

The same session intelligence that powers Recall is exposed as a standalone **MCP
server** so *any* coding agent can query your history, not just the console. It ships
as a separate executable, **`agentgem-goldmine`**, installed on your `PATH`
alongside `agentgem`. Point your agent's MCP config at it (it speaks MCP over stdio)
and the tools appear as `mcp__agentgem-goldmine__<tool>`:

| Tool | What it answers |
| --- | --- |
| `search_sessions` | Find past sessions by project, model, or branch (metadata only). |
| `search_session_content` | Rank moments across sessions by transcript *content* — the Recall index, over MCP. |
| `summarize_session` | An aggregate view of one session: process-quality score, stage mix, detector findings, tool/edit/verify counts — no raw content. |
| `ask_session` | Ask a question about one session; a separate agent reads the raw transcript and returns only the answer. |
| `get_artifact_detail` | Detail about one installed artifact (`skill`, `mcp_server`, `hook`, or `instructions`). |
| `get_behavior_findings` | Recurring problematic patterns in recent sessions (retry storms, thrash loops, unverified finishes) with per-pattern advice. |

The console's [Chat](chat.md) tab wires this same server into its sessions
automatically, so the agent you chat with can already see your history.

## Where it fits

Recall is the read side of your session goldmine: find the moment, then hand it off.
Once you've found what worked, **[Chat](chat.md)** about it or **[Analyze](analyze.md)**
the project to turn the recurring procedure into a draft skill and fold it into a Gem.
