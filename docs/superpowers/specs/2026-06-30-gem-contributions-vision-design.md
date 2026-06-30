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

Each cut has a **signature gemstone (color)** so the type reads at a glance (color fixes the "a gemstone name alone never said *MCP*" legibility problem):

| Cut | Gemstone (color) | What it is | Auto-derive default | Contribution |
|---|---|---|---|---|
| 🏗️ Setup | Opal (iridescent) | a whole agent config, ready to adopt | spans 3+ artifact kinds / full-config snapshot | "run what I run" |
| 🧰 Kit | Amethyst (purple) | a curated bundle for a job | ≥2 artifact kinds, author-assembled | a toolset for X (e.g. `brainstorming-kit`) |
| ✨ Skill | Emerald (green) | one capability | only `skill` artifacts | "a thing my agent learned to do" |
| 🔌 Integration | Sapphire (blue) | an external tool, wired up | contains an `mcp_server` | "connect your agent to X" |
| 📜 Guide | Topaz (amber) | rules & guidance | only `instructions` artifacts | "how to behave / what to avoid" |
| 📓 Playbook | Pearl (white) | wins + lessons distilled from meaningful sessions | built via the distill flow (`source: distilled-*`, has provenance) | "what I actually learned doing the work" |

**Content** (skill/mcp/instructions) stays a **derived** cross-facet (`artifactKinds`, already in the index) — so "Skill" and "Integration" are the author's *framing*, orthogonal to "contains: skill". One explicit field + one derived field = two browse axes.

### Stone — the *rating* it has earned (computed, never self-claimed)

A gem renders as **N gems of its cut's color** — the count (1–5) is the rating, so the single icon carries both axes (color = type, multiplicity = quality). E.g. 💚💚💚💚💚 = a top-rated Skill; 🤍🤍 = a young Playbook.

The 1–5 count is derived from the scorecard's three axes, measured at **population scale** instead of one author's sessions:

| Scorecard axis | At population scale |
|---|---|
| `breadth` | **Reach** — distinct adopters |
| `battleTested` | **Proven** — real runs across sessions/machines (+ author maturity at publish) |
| `portable` | **Travels** — materializes across targets, low secret-friction, used beyond origin |

**💎 Diamond** is *not* a per-cut color — it is a rare **cross-type apex seal**: a gem that hits 5/5 *and* broad real adoption gets "certified flawless." Colors = types, count = rating, Diamond = the once-in-a-while crown.

**Honest data caveat:** only the *authoring-side* scorecard is computable today (how proven a gem's content is in the author's own sessions — available at publish), which **seeds** a starting rating for battle-tested content. The higher counts (and the Diamond seal) require **gem install/run telemetry in the aggregator**, which does not exist yet (the aggregator tracks *ingredient* usage). MVP = author-proven seed; the rating *levels up* as adoption accrues. We must not render crowd-earned ratings we cannot compute.

## Lessons are about *salience*, not recurrence

A **Lesson** (and a win) is worth capturing because the session was *meaningful* — not because the pattern *recurred*. A single gnarly session — debugging a production failure, standing up a CI/devops pipeline, a hard-won fix — is often the **richest** source; gating on recurrence throws away the best material. So the model splits the **lesson source** (what qualifies) from the **plumbing** (how a lesson reaches a gem):

- **Plumbing** is *source-agnostic*: `Lesson → instructions artifact → gem`. A `Lesson` carries provenance from *one or many* sessions; it never assumes recurrence.
- **Sources** feed the same plumbing: (a) **recurring reflections** — already computed, *free*, the weakest material; (b) **a meaningful single session** — troubleshooting / devops-automation / hard-won fix — detected by *salience* (error→resolution arc, multi-step automation, notable outcome) and **LLM-distilled** into wins + lessons (rides the existing `distill.ts`/`extract.ts` seam; "what we learned" prose wants the model, not a regex).

## Subsystem decomposition (each gets its own spec → plan)

Built in this order; each produces working, testable software on its own.

1. **Lessons-as-artifacts (plumbing)** — the missing, *source-agnostic* `Lesson → instructions artifact` leg, so a Playbook can carry wins (skills) **and** lessons (instructions). Proven end-to-end with the *free* recurring-reflection source. *Smallest; foundational; first.* (Spec: `2026-06-30-lessons-as-artifacts-design.md`.)
2. **Meaningful-session extractor** — the value source: detect a *salient* session (troubleshooting/devops/hard-fix) and LLM-distill its wins + lessons, emitted through #1's seam. The differentiated capability.
3. **`GEM_TYPES` extension point** — the extensible cut registry (`extensionPoint(GEM_TYPES)` / `@extensions.list()` / `extensionFor` / `addExtension`, the `MCP_SERVERS` pattern), the built-in cuts **with their signature gemstone colors**, the `derive(gem)` default classifier, and `type` stored on + read from the registry discovery block.
4. **Account-bound publishing** — close the M2-A gap: a publish records authorship = the signed-in account; scope ownership (only `@you/*`); list "gems by @you". Prerequisite to publishing *from* the marketplace.
5. **Faceted publish + browse UI** on `explore.agentgem.ai` — browse by Cut and by rating; render a gem as **N gems of its cut's color** + the Diamond seal; a publish/manage surface (the local-origin constraint stands: the static SPA can't read `~/.claude`, so building a gem from a setup still *originates* in the local console; the marketplace drives publish-management + discovery). Rating computation is authoring-seeded now; crowd-earned counts land when gem-adoption telemetry exists.

## Non-goals (for the program)

- Loose individual artifacts as a separate publishable unit (everything is a Gem; a "Skill" cut is a gem with one skill).
- Paid/per-call distribution, signing (`gem.lock.signature` stays reserved).
- Rendering crowd-earned ratings (or the Diamond seal) before gem-adoption telemetry exists.

## Risks

- **Rating honesty** — counts before adoption telemetry exists invite vanity ratings. Mitigation: seed from the *authoring* scorecard only; gate the higher counts + Diamond seal behind real install/run data (a subsystem after #4/#5).
- **Cut legibility** — gemstone *names* as type labels would tank discovery; resolved by the two-axis split: legible cut labels carried by gemstone **color**, rating by gem **count**.
- **Local-origin constraint** — "share my setup" can't read disk from the web; publish must originate in the console/CLI. The marketplace is publish-management, not a file reader.
