# AgentGem documentation

AgentGem is a local web UI that reads what you've already built with your coding
agent — your **agent setup** (skills, MCP servers, `CLAUDE.md`) and your **session
transcripts** — redacts secrets at capture, and distills it into a **secret-safe,
composable Gem**. [Analyze](analyze.md) turns the procedures you repeat across
sessions into draft skills; the builder packages it all into a portable archive
(manifest + lock) you can install locally, merge with others, materialize for many
agent targets, and publish to the AgentGem marketplace.

It's built on **[AgentBack](https://agentback.dev)**, the ninemind AI-native API/MCP framework: every operation
is defined once as a Zod contract and exposed as a REST endpoint, an MCP tool, and an
OpenAPI 3.1 document — so the web page and your local agent call exactly the same thing.

## Start here

- **[Getting started](getting-started.md)** — install, run the local server, and build
  your first Gem.
- **[Desktop app](desktop.md)** — the native macOS/Windows/Linux build, in addition to
  the `npx` CLI.
- **[Analyze](analyze.md)** — scan your agent's session history for workflow-aware Gem
  recommendations, and **distill new draft skills** from the procedures you repeat by hand.
- **[Concepts](concepts.md)** — what a Gem is, the archive format, the redaction trust
  boundary, and the AgentBack one-contract model.

## Working with your sessions

The console is more than a Gem builder — it reads, searches, and grades your session
history, and turns it into things you can play and share.

- **[Recall](recall.md)** — search across every past session by what happened inside
  it, then chat with or extract across the ones that matter. Ranking is **proven-use
  aware** (artifacts with good outcomes are boosted). Its intelligence is also the
  **`agentgem-goldmine`** MCP server, so any coding agent can query your history.
- **[Memory sync](recall.md)** — the **Memory panel** bridges recall to external AI
  memory providers (**mem0**, **supermemory**): pull their memories in, and push
  scrubbed, consent-gated candidates out through a review outbox.
- **[Chat](chat.md)** — drive a local coding agent (Claude, Codex) from inside the
  console, grounded in your transcripts, and distill the conversation into a Gem.
- **[Context hygiene](context-hygiene.md)** — LLM-free detection of context bloat: a
  per-session score, a "cut here at turn N" boundary, a session timeline, a
  leaderboard, and live OS nudges from the `agentgem warm` daemon.
- **[Play](play.md)** — AI-generated mini-games, built by chatting, sealed to run
  anywhere, and versioned as first-class `game` Gems.

## Architecture & internals

- **[Architecture](architecture.md)** — the system map: clients → contract surface → Gem
  core → distribution, with diagrams.
- **[The build pipeline](pipeline.md)** — introspect → redact → buildGem → archive.
- **[Archive format](archive-format.md)** — the manifest + lock spec, hashing, and
  serialization.
- **[Redaction](redaction.md)** — the trust boundary and its rules.
- **[Input containment](input-containment.md)** — how outward-facing POST routes confine
  filesystem/network inputs (workspace-name, run-dir, and SSRF guards).
- **[API reference](api-reference.md)** — every REST endpoint and MCP tool.

## Distribution

- **[Targets](targets.md)** — the materialize targets (Eve, Flue, OpenAI Sandbox,
  Bedrock AgentCore, and the editor formats) and how a Gem renders to each.
- **[A2A](a2a.md)** — export a Gem as an A2A Agent Card or a runnable agent-to-agent
  server so other agents can discover and call it.
- **The public marketplace at [app.agentgem.ai](https://app.agentgem.ai)** — publish
  composable Gems (Public / Unlisted / Private, versioned, optionally group-reviewed),
  then browse, star, review, install, and play installable/offline mini-apps (early
  testbed: hosted data may be reset).
- **[Sharing & identity](sharing.md)** — install a published Gem with one command
  (`agentgem get`), pass one directly over an encrypted one-time hand-off
  (`agentgem send` / `receive`), and verify a Gem runs across agents (`agentgem verify`).
  Web accounts use **better-auth** (sign in with GitHub, Google, or a passkey) with a
  **`/@handle`** profile hub; the CLI `agentgem bind` ties this machine's signing key to a
  GitHub account for anti-sybil producer identity.
- **[Testbed & run](testbed-and-run.md)** — install a Gem into a local testbed, and run
  a materialized target locally.

## Contributing

- **[Development](development.md)** — build, test, the decorator/compiled-`dist` setup, and
  code conventions.

## Diagrams

Architecture diagrams live in [`diagrams/`](diagrams/) as `.svg` (embedded in these docs),
`.png` (raster fallback), and `.html` (interactive, with Copy / PNG / PDF export):

- [System architecture](diagrams/system-architecture.svg)
- [Gem build pipeline](diagrams/gem-pipeline.svg)
- [Distribution](diagrams/distribution.svg)
