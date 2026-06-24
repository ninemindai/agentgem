# AgentGem documentation

AgentGem is a local web UI that introspects your coding-agent config — skills, MCP
servers, and `CLAUDE.md` — redacts secrets at capture, and builds a **secret-safe,
composable Gem**. A Gem is a portable archive (manifest + lock) you can publish to a
GitHub-backed registry, merge with others, and deploy to several targets.

It's built on **[AgentBack](https://agentback.dev)**, the ninemind AI-native API/MCP framework: every operation
is defined once as a Zod contract and exposed as a REST endpoint, an MCP tool, and an
OpenAPI 3.1 document — so the web page and your local agent call exactly the same thing.

## Start here

- **[Getting started](getting-started.md)** — install, run the local server, and build
  your first Gem.
- **[Desktop app](desktop.md)** — the native macOS/Windows/Linux build, in addition to
  the `npx` CLI.
- **[Analyze](analyze.md)** — scan your agent's session history and get workflow-aware
  Gem recommendations.
- **[Concepts](concepts.md)** — what a Gem is, the archive format, the redaction trust
  boundary, and the AgentBack one-contract model.

## Architecture & internals

- **[Architecture](architecture.md)** — the system map: clients → contract surface → Gem
  core → distribution, with diagrams.
- **[The build pipeline](pipeline.md)** — introspect → redact → buildGem → archive.
- **[Archive format](archive-format.md)** — the manifest + lock spec, hashing, and
  serialization.
- **[Redaction](redaction.md)** — the trust boundary and its rules.
- **[API reference](api-reference.md)** — every REST endpoint and MCP tool.

## Distribution

- **[Targets & deploy](targets.md)** — the deploy targets (Eve, Flue, OpenAI Sandbox,
  Bedrock AgentCore) and the publish / undeploy lifecycle.
- **[A2A](a2a.md)** — export a Gem as an A2A Agent Card or a runnable agent-to-agent
  server so other agents can discover and call it.
- **[Registry](registry.md)** — the GitHub-backed Gem registry: publish, resolve, merge,
  and install composable Gems.
- **[Testbed & run](testbed-and-run.md)** — install a Gem into a local testbed; run or
  deploy a materialized target locally, to Vercel, or to Cloudflare.

## Contributing

- **[Development](development.md)** — build, test, the decorator/compiled-`dist` setup, and
  code conventions.

## Diagrams

Architecture diagrams live in [`diagrams/`](diagrams/) as `.svg` (embedded in these docs),
`.png` (raster fallback), and `.html` (interactive, with Copy / PNG / PDF export):

- [System architecture](diagrams/system-architecture.svg)
- [Gem build pipeline](diagrams/gem-pipeline.svg)
- [Distribution](diagrams/distribution.svg)
