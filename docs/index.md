# AgentGem documentation

AgentGem is a local web UI that introspects your coding-agent config — skills, MCP
servers, and `CLAUDE.md` — redacts secrets at capture, and builds a **secret-safe,
composable Gem**. A Gem is a portable archive (manifest + lock) you can publish to a
GitHub-backed registry, merge with others, and deploy to several targets.

It's built on **AgentBack**, the ninemind AI-native API/MCP framework: every operation
is defined once as a Zod contract and exposed as a REST endpoint, an MCP tool, and an
OpenAPI 3.1 document — so the web page and your local agent call exactly the same thing.

## Start here

- **[Getting started](getting-started.md)** — install, run the local server, and build
  your first Gem.
- **[Concepts](concepts.md)** — what a Gem is, the archive format, the redaction trust
  boundary, and the AgentBack one-contract model.
- **[Targets & deploy](targets.md)** — the deploy targets (Eve, Flue, OpenAI Sandbox,
  Bedrock AgentCore) and the publish / undeploy lifecycle.
- **[Registry](registry.md)** — the GitHub-backed Gem registry: publish, resolve, merge,
  and install composable Gems.
