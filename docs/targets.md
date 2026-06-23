# Targets & deploy

A Gem is a neutral source. **Targets** turn it into something runnable — either generated
code you can run yourself or a managed backend AgentGem publishes to. Because every target
reads the same Gem, you select where it goes without rebuilding from your raw config.

## The targets

| Target               | Kind                | What it produces                                                        |
| -------------------- | ------------------- | ---------------------------------------------------------------------- |
| [**Eve**](https://eve.dev)                       | Code-gen            | A generated agent project from the Gem — the reference target pattern. |
| [**Flue**](https://flueframework.com)            | Code-gen / materialize | Materializes the Gem via the reusable `compose` hook; deployable to Cloudflare. |
| [**OpenAI Sandbox**](https://github.com/openai/openai-agents-js) | Code-gen | A SandboxAgent project with native stdio MCP, reusing the `compose` hook. |
| [**Bedrock AgentCore**](https://aws.amazon.com/bedrock/agentcore/) | Managed backend | Publishes the Gem to AWS Bedrock AgentCore.                            |
| [**Claude Managed Agents**](https://platform.claude.com/docs/en/managed-agents/overview) | Managed backend | Publishes the Gem as a Claude Managed Agent via the Anthropic API (agent + skills + managed sandbox). |

All code-gen targets share a common `compose` step, so adding a new target mostly means
describing how it materializes a Gem — the introspection, selection, and redaction in
front of it are unchanged.

## The deploy lifecycle

1. **Build** a Gem (see [Getting started](getting-started.md)).
2. **Pick a target.** Code-gen targets emit a project; managed targets publish to a backend.
3. **Publish / deploy.** For managed backends this calls the provider's API and records a
   deploy record describing what went out and where.
4. **Undeploy** when you're done. AgentGem exposes an undeploy path that tears down the
   deployment and reconciles the deploy record, surfacing provider API errors rather than
   silently succeeding.

The deploy record is what drives the UI's Undeploy buttons across every backend, so the
state you see reflects what's actually deployed.

See **[Registry](registry.md)** for distributing and composing Gems before you deploy them.
