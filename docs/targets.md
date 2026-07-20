# Targets

A Gem is a neutral source. **Targets** turn it into something runnable — a generated
project or an editor-ready config layout. Because every target reads the same Gem, you
select where it goes without rebuilding from your raw config.

## The targets

| Target               | Kind                | What it produces                                                        |
| -------------------- | ------------------- | ---------------------------------------------------------------------- |
| [**Eve**](https://eve.dev)                       | Code-gen            | A generated agent project from the Gem — the reference target pattern. |
| [**Flue**](https://flueframework.com)            | Code-gen / materialize | Materializes the Gem via the reusable `compose` hook into a Workers-style project. |
| [**OpenAI Sandbox**](https://github.com/openai/openai-agents-js) | Code-gen | A SandboxAgent project with native stdio MCP, reusing the `compose` hook. |
| [**Bedrock AgentCore**](https://aws.amazon.com/bedrock/agentcore/) | Code-gen | An AgentCore harness project rendered from the Gem.                    |
| [**A2A**](a2a.md)                                | Code-gen / export   | An [A2A](a2a.md) Agent Card, or a runnable agent-to-agent server (AI SDK v7) other agents can discover and call. |

Editor targets — **Claude, Codex, Agents, Hermes, Cline/Roo, Gemini CLI, Continue,
Cursor** — render the Gem's artifacts into that ecosystem's config conventions.

All code-gen targets share a common `compose` step, so adding a new target mostly means
describing how it materializes a Gem — the introspection, selection, and redaction in
front of it are unchanged.

The **A2A** target is a bit different: rather than emitting a project to run, it exports
your Gem as a discoverable Agent Card or a self-contained server for the
[agent-to-agent protocol](a2a.md).

## From render to running

1. **Build** a Gem (see [Getting started](getting-started.md)).
2. **Pick a target.** Materialize renders the project or config layout locally.
3. **Run it.** A rendered Eve/Flue app can be started locally straight from the
   Materialize panel (see [Testbed & run](testbed-and-run.md)); other rendered projects
   are yours to run wherever you run Node projects.

Secrets are never written into a rendered project — they are referenced by name only
(see [Redaction](redaction.md)).
