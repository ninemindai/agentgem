# Registry

The **Gem registry** distributes composable Gems over the same archive format AgentGem
builds. It's GitHub-backed: Gems live in a repository, so distribution rides on
infrastructure you already trust — no separate service to run.

## A skill is a copy. A Gem is a service.

The usual way to share agent work is to post a `SKILL.md` to a registry like skills.sh
and promote it on X. People copy it, fork it, or scroll past — and you earn nothing. **You
can't profit from a markdown file.** A Gem is a different kind of unit: not a file others
*take*, but a live service others *call*.

| | Sharing markdown | Publishing a Gem |
| --- | --- | --- |
| **What you share** | A `SKILL.md` file | A secret-safe, composable Gem |
| **What others do** | Copy / fork it | Call it as a service |
| **Secrets** | Up to you to scrub by hand | Redacted at capture |
| **Runtime** | They wire it up themselves | Deploys on demand to a target |
| **Discovery** | A link you promote on X | Agent-to-agent over A2A *(roadmap)* |
| **Revenue** | Stars, not dollars | Paid per call *(roadmap)* |

The registry is where that shift starts: it's the [marketplace v0](../vision.html) — a
catalog today, a live, callable [agent service network](../vision.html) as deploy-on-demand
and per-call payments land.

## The operations

- **Publish** — push a built Gem to the registry under a name and version. Because the Gem
  is already secret-safe, publishing never leaks credentials.
- **Resolve** — look up a Gem reference and fetch its archive (manifest + lock).
- **Merge** — combine multiple Gems into one. Manifests are reconciled and a single lock
  is re-resolved, so the result is a coherent, reproducible Gem rather than a pile of
  overlapping config.
- **Install** — pull a Gem back down into a local testbed so you can run or extend it.

## Why composition matters

The manifest/lock split (see [Concepts](concepts.md#the-archive-format-manifest-lock))
exists precisely so Gems can be assembled. A small, focused Gem — say, a research skill
set plus one MCP server — can be merged with another to build a larger agent, without
hand-editing config or re-introspecting every machine. Publish the pieces once; compose
them many times.

## A typical flow

1. Build a focused Gem and **publish** it to the registry.
2. On another machine (or in CI), **resolve** the Gems you need.
3. **Merge** them into the agent you want.
4. **Install** the merged Gem into a testbed, then run it or send it to a
   [target](targets.md).

Back to the **[documentation index](index.md)**.
