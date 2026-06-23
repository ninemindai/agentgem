# Registry

The **Gem registry** distributes composable Gems over the same archive format AgentGem
builds. It's GitHub-backed: Gems live in a repository, so distribution rides on
infrastructure you already trust — no separate service to run.

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
