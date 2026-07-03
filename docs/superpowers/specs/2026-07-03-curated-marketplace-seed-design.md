# Curated content on app.agentgem.ai — design

- **Date:** 2026-07-03
- **Status:** Approved (brainstorming), pending spec review
- **Branch:** `feat/curated-marketplace`

## Goal

Give the public marketplace (`app.agentgem.ai`) real, discoverable content sourced
from the curated import sources (starting with `agency-agents` — 232 role personas,
MIT, by @msitarzewski), **without** bulk-dumping all 232 as low-signal gems or
misattributing someone else's work. Two deliverables:

1. **Browse surface (read-only)** — visitors can browse curated personas on the
   marketplace, read the full `SKILL.md`, see attribution, and copy a command to
   install locally.
2. **Attributed flagship seed** — publish a small, curated (~12) subset as real gems
   under a dedicated `@agency` scope so the catalog has honest inventory and the
   publish → discover → install loop is demonstrable.

Non-goal: turning the marketplace into a mirror of agency-agents. This is a
cold-start seed plus a discovery surface, not a bulk republish.

## Architecture overview

Two independent sub-projects, one shared attribution model. **Ship A before B:**
A is read-only (no public writes, low risk); B writes to the public registry and
needs a `GITHUB_TOKEN`, so it lands second once A is proven.

Confirmed platform facts this design relies on:

- `app.agentgem.ai` = `packages/marketplace` (Vite/React SPA), reads the public API
  (`VITE_API_BASE=https://api.agentgem.ai`).
- `/api/sources/*` (list, divisions, agents, agent, import) are mounted
  **unconditionally** in `src/index.ts` (before the `SERVE_CONSOLE` gate), so the
  API-only deploy serves them. The marketplace can call them directly.
- The registry is the GitHub repo `ninemindai/agentgem-registry`. Reads are
  token-optional (`GET /api/registry/gems` → marketplace catalog). **Publishing is
  out-of-band** with a `GITHUB_TOKEN` (repo scope) — never on the server.
- `publishGem(args)` (`packages/distribute/src/registry.ts`) is the publish
  primitive. Versions are **immutable**: same digest = no-op return; changed content
  under a published version throws. Attribution surfaces via its `publishedBy`,
  `grade`, `type`, `tags`, `description` args (→ `buildDiscovery` → the catalog
  `discovery` object, which the marketplace card reads, incl. `discovery.author`).

---

## Sub-project A — Curated browse surface

### A1. Marketplace `/sources` page

**New file:** `packages/marketplace/src/pages/Sources.tsx` + a route in `Router.tsx`
+ a nav link in `App.tsx`.

Mirrors the console Sources panel but **read-only** (no local install on the web):
source → division chips → persona list → per-persona **View skill** (full `SKILL.md`
in a scrollable block) + attribution line + a **copy-able install command**.

**Data:** new client bindings in `packages/marketplace/src/api.ts` for the existing
endpoints (the marketplace has its own `api.ts`, independent of the console's
`routes.ts`):
- `GET /api/sources` → sources list
- `GET /api/sources/divisions?source=`
- `GET /api/sources/agents?source=&division=`
- `POST /api/sources/import {source, path}` → full built `SKILL.md` (`content`),
  build-only (never writes to disk) — the "View skill" body.

**Install CTA (web):** a read-only, copy-able command per persona:
`agentgem sources install <sourceId> <path>` with a copy button. No web-side install
(there is no local machine to write to). Attribution shown inline:
`from <repo> by @<author> · <license>` with a link to the source homepage.

### A2. `agentgem sources install` CLI subcommand

**New:** a `sources` branch in `src/cli.ts` (alongside `warm`/`verify`/`learn`).
`agentgem sources install <sourceId> <path>` → resolves the curated source config →
`importAgencyAgentSkill(path, cfg)` → writes `~/.agents/skills/<name>/SKILL.md`.
This is the same logic as `SourcesController.install`; extract the shared core
(build + safe-name check + write) into a small function reused by both the
controller and the CLI so they can't drift. `--dry-run` prints the built `SKILL.md`
without writing.

Without A2 the web CTA is a dead command, so A1 and A2 ship together.

### A3. Testing

- `packages/marketplace/src/pages/Sources.test.tsx` — `vi.stubGlobal("fetch")`
  pattern (as in `PublishToExplore.test.tsx`): drill source → division → View skill,
  assert the full body renders and the install command string is present + correct.
- CLI test — `sources install <src> <path>` against a temp `HOME`, assert the skill
  file is written with the expected content; `--dry-run` writes nothing.

---

## Sub-project B — Attributed flagship seed script

**New file:** `scripts/seed-curated.mjs` (Node ESM, run locally/CI, **not** on the
server). Requires `GITHUB_TOKEN` (repo scope) for the registry repo.

### B1. Selection

A committed, reviewable list (~12) chosen for **breadth** — the strongest general
persona per major division, so the seed represents the catalog rather than one niche:

```
engineering/ai-engineer            design/ui-designer
engineering/backend-architect      marketing/growth-marketer
engineering/code-reviewer          product/product-manager
engineering/devops-automator       security/security-auditor
testing/qa-engineer                finance/financial-analyst
support/customer-support           project-management/project-manager
```

(Exact slugs verified against the source's division listings at build time; the
list lives in the script as a constant, not discovered at random. If a slug is
missing it is logged and skipped — no silent substitution.)

### B2. Per-persona pipeline

For each entry: `importAgencyAgentSkill(path, cfg)` → wrap as a single-skill `Gem`
(`buildGem`-equivalent for one skill) → `publishGem`:

```
publishGem({
  gem, scope: "agency", name: <slug>, version: "1.0.0",
  index,            // current registry.json, fetched first
  publisher,        // GitHub committer built from GITHUB_TOKEN + AGENTGEM_REGISTRY_REPO
  type: "skill",                              // Cut = Skill (Emerald)
  grade: 1,                                   // honest authoring floor → Quartz Stone
  publishedBy: "msitarzewski",                // → discovery.author on the card
  tags: ["imported", "agency-agents"],
  description: "<persona description> — imported from agency-agents by @msitarzewski (MIT).",
})
```

Attribution also carried in the skill artifact: `metadata.license = "MIT"` and
`source` retained from the import. License/author/source thus live in the published
gem, not just the card.

### B3. Idempotency, dry-run, safety

- **Idempotent:** publishGem no-ops when the digest is unchanged; re-runs are safe.
  Changing a persona's content requires a version bump (immutability is a feature —
  the script bumps the constant version when intentionally re-cutting).
- **`--dry-run`:** build every gem and print the plan (keys, grades, attribution)
  **without** calling `publisher.putCommit`. Default is dry-run; publishing requires
  an explicit `--publish` flag so a bare run can't mutate the public registry.
- **Logs** every key it publishes/skips; no silent caps or truncation.

### B4. Testing

- Unit-test the seed core against a **fake `RegistryPublisher`** (in-memory
  `putCommit`): assert it emits `@agency/<slug>` keys, `type:"skill"`, `grade:1`,
  `publishedBy:"msitarzewski"`, `license:"MIT"` in the manifest, and that `--dry-run`
  calls `putCommit` zero times. No live GitHub in tests.

---

## Attribution model (cross-cutting)

Every seeded gem, and every browse card, credits the origin:

- **Scope** `@agency/*` — structurally distinct from first-party `@ninemind/*` and
  community uploads; the scope itself reads as "curated/imported."
- **Author** via `publishedBy: "msitarzewski"` → `discovery.author` (card + detail).
- **License** `MIT` in the skill `metadata` and the description.
- **Source** repo + homepage retained and linked.
- **Tag** `imported` for filtering/labeling.

MIT permits redistribution with attribution; this makes the attribution prominent
and machine-readable rather than a buried note.

## Grade / Cut mapping (honest by construction)

- **Cut** = `skill` → the Emerald pill (a single-persona gem is a Skill).
- **Stone** = `stoneRating(floor=1, stars=0, installs=0)` ≈ 1 stone (**Quartz**).
  The rating math already tells the truth for an unvetted import — no faked grade.
  Diamond requires grade 3 + ≥21 stars + ≥50 verified installs, which these earn
  (or not) organically.

## Out of scope (YAGNI)

- Bulk-publishing all 232 personas.
- A web-based installer (there is no server-side "install to the visitor").
- Auto-grading / evals for imported personas.
- Sources beyond `agency-agents` (the surface is generic, but only agency-agents is
  seeded now).
- Any change to the Gem manifest schema (attribution rides existing publish args).

## Sequencing

1. **A** (marketplace `/sources` page + `agentgem sources install` CLI) — read-only,
   shippable and reviewable on its own.
2. **B** (`scripts/seed-curated.mjs`) — run `--dry-run` first, review the plan, then
   `--publish` the ~12 to `@agency/*`. Seeded gems then appear on `/gems`
   automatically.
