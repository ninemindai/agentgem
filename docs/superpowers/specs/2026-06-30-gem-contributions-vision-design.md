# Gem Contributions — Cut × Stone / Playbook (Vision)

**Date:** 2026-06-30
**Status:** Vision / north-star — decomposes into per-subsystem specs (this doc is not directly implementable)

## Goal

Turn `explore.agentgem.ai` from a read-only discovery surface into a **publishing destination** where a signed-in user shares their agent contributions — gems, whole setups, curated skills/MCP/instructions, and (the differentiated case) the **wins and lessons distilled from their real session transcripts** — so other people's coding/coworking agents can adopt them.

## Context (what exists today)

- **Everything publishable is a Gem.** A `Gem` already bundles arbitrary artifacts: `skill | mcp_server | instructions | hook | channel` (+ checks, required secrets). One skill, a curated set, or a whole `.claude/` setup are all "a gem with N artifacts." No new container is needed.
- **Distribution plumbing is shipped:** the GitHub-backed **registry** (publish/resolve/merge, digest-immutable), `.gem` export, encrypted transfer tickets, and hosted share-links (`/share/:id`). The registry is now **populated + live** (`@ninemind/brainstorming-kit@1.2.0`).
- **The session goldmine is already mined:** `POST /api/workflow/analyze` scans transcripts and emits **distilled skills** (recurring procedures) + **reflections** (`recurring-pattern | recurring-decision | unresolved-task`, importance high/medium), with **coordinates-only** provenance (never raw message content). The **scorecard** rolls projects up into three axes: `breadth`, `battleTested`, `portable`.
- **Gaps:** the marketplace has **no publish/share UI**; registry publish is **account-agnostic** (`scope` is caller-supplied, unbound to the signed-in account); **reflections (lessons) have no artifact path** (they become `gaps`, never instructions); and there is **no gem `type`** to distinguish a curated kit from a whole setup from a session-distilled playbook.

## The model: two orthogonal axes (Cut × Stone)

A gem is described by two independent axes — the jeweler's own vocabulary, and the same shape as the data model.

### Cut — the *shape* of the contribution (author-set intent)

An explicit `type` on the gem, set at publish (smart default from contents, author can override). Stored additively on the registry index's discovery block (older readers ignore it, like `tags` — no format-version bump). **Implemented as an AgentBack extension point** (`GEM_TYPES`), so the built-in set ships in the box and third parties/plugins register more without core changes. Built-in cuts:

| Cut | What it is | Auto-derive default | Contribution |
|---|---|---|---|
| 🏗️ Setup | a whole agent config, ready to adopt | spans 3+ artifact kinds / full-config snapshot | "run what I run" |
| 🧰 Kit | a curated bundle for a job | ≥2 artifact kinds, author-assembled | a toolset for X (e.g. `brainstorming-kit`) |
| ✨ Skill | one capability | only `skill` artifacts | "a thing my agent learned to do" |
| 🔌 Integration | an external tool, wired up | contains an `mcp_server` | "connect your agent to X" |
| 📜 Guide | rules & guidance | only `instructions` artifacts | "how to behave / what to avoid" |
| 📓 Playbook | wins + lessons distilled from real sessions | built via the distill flow (`source: distilled-*`, has provenance) | "what I actually learned doing the work" |

**Content** (skill/mcp/instructions) stays a **derived** cross-facet (`artifactKinds`, already in the index) — so "Skill" and "Integration" are the author's *framing*, orthogonal to "contains: skill". One explicit field + one derived field = two browse axes.

### Stone — the *grade* it has earned (computed, never self-claimed)

The scorecard's three axes, measured at **population scale** instead of one author's sessions:

| Scorecard axis | At population scale |
|---|---|
| `breadth` | **Reach** — distinct adopters |
| `battleTested` | **Proven** — real runs across sessions/machines (+ author maturity at publish) |
| `portable` | **Travels** — materializes across targets, low secret-friction, used beyond origin |

Ladder: 🪨 **Quartz** (just published) → 💚 **Emerald** (adopted) → 💙 **Sapphire** (proven) → ❤️ **Ruby** (proven + portable) → 💎 **Diamond** (maxes all three). 🤍 **Pearl** is *not a grade* — it is the emblem of the **Playbook** cut (formed slowly from session friction).

**Honest data caveat:** only the *authoring-side* scorecard is computable today (how proven a gem's content is in the author's own sessions — available at publish), which **seeds** a starting grade above Quartz for battle-tested content. The crowd-earned tiers (Emerald→Diamond) require **gem install/run telemetry in the aggregator**, which does not exist yet (the aggregator tracks *ingredient* usage). MVP = author-proven seed; the stone *levels up* as adoption accrues. We must not render crowd-grades we cannot compute.

## Subsystem decomposition (each gets its own spec → plan)

Built in this order; each produces working, testable software on its own.

1. **Lessons-as-artifacts** — the missing `reflection → instructions artifact` leg, so a Playbook can carry wins (skills) **and** lessons (instructions). *Smallest; unlocks the differentiated content; proves the win/lesson → gem → share loop. First.* (Spec: `2026-06-30-lessons-as-artifacts-design.md`.)
2. **`GEM_TYPES` extension point** — the extensible cut registry (`extensionPoint(GEM_TYPES)` / `@extensions.list()` / `extensionFor` / `addExtension`, the `MCP_SERVERS` pattern), the built-in cuts, the `derive(gem)` default classifier, and `type` stored on + read from the registry discovery block.
3. **Account-bound publishing** — close the M2-A gap: a publish records authorship = the signed-in account; scope ownership (only `@you/*`); list "gems by @you". Prerequisite to publishing *from* the marketplace.
4. **Faceted publish + browse UI** on `explore.agentgem.ai` — browse by Cut and by Stone (and derived content); a publish/manage surface (the local-origin constraint stands: the static SPA can't read `~/.claude`, so building a gem from a setup still *originates* in the local console; the marketplace drives publish-management + discovery).

## Non-goals (for the program)

- Loose individual artifacts as a separate publishable unit (everything is a Gem; a "Skill" cut is a gem with one skill).
- Paid/per-call distribution, signing (`gem.lock.signature` stays reserved).
- Rendering crowd-earned stone grades before gem-adoption telemetry exists.

## Risks

- **Stone honesty** — grading before adoption telemetry exists invites vanity grades. Mitigation: seed from the *authoring* scorecard only; gate crowd tiers behind real install/run data (subsystem after #3/#4).
- **Cut legibility** — gemstone names as *type* labels would tank discovery; resolved by splitting axes (legible cuts × gemstone *grades*).
- **Local-origin constraint** — "share my setup" can't read disk from the web; publish must originate in the console/CLI. The marketplace is publish-management, not a file reader.
