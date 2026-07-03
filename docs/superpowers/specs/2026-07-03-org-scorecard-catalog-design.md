# Org-Scoped Scorecard Catalog — Design

**Date:** 2026-07-03
**Status:** Approved design, pre-implementation
**Wedge:** Subsystem #1 of the "enterprise registry" direction (org catalog + scorecard). The
governance control-plane (#2), full IDP ownership/lifecycle (#3), and enterprise-tier
visibility/SSO/seats (#4) are **out of scope** here and layer on later.

## 1. Problem & goal

The public marketplace (`explore.agentgem.ai`, `packages/marketplace`) lists gems as a flat,
global catalog. There is no way to see **one organization's** gems as a coherent, graded
catalog — the shape enterprises recognize as a "scorecard catalog" (Cortex / Backstage
Soundcheck): the org's gems grouped in one place, each carrying a maturity grade, with a
per-gem rubric that explains *why* the grade is what it is and *what to fix*.

**Goal:** a hosted, public, read-only org page at `/orgs/:scope` that renders the org's gems
with the existing Cut × Stone badge **plus a per-gem maturity rubric**, filterable and sortable.

**Success criteria:**
- Navigating to `/orgs/acme` lists every gem whose key is scoped `@acme/*`, with grade, cut,
  owner, stars, installs, and a computed rubric score.
- Each gem row drills into a rubric checklist (pass/fail + a one-line "how to fix").
- The list is searchable and filterable by cut / grade / owner and sortable by grade / stone.
- An org with no published gems renders a friendly empty state, not an error.

## 2. Prior art we build on (this is mostly wiring, not new plumbing)

Verified against the current codebase:

- **Org identity already exists as *scope*.** Gems publish under `@scope/name`; publish enforces
  `accountOwnsScope` (`src/registry/uploadPublish.ts:50`), and scopes (GitHub login + captured
  public GitHub org memberships) live in `account_scopes` (`packages/aggregator/src/schema.ts:114`).
  **We read the org from the gem key**, not from an `account_scopes` join (decision D1, §8).
- **Grade / Cut / Stone are already computed.**
  - `Gem.grade` (1..3 floor) baked at build via `scorecardFloor` (`packages/model/src/gemGrade.ts:19`,
    applied at `src/gem.controller.ts:538`).
  - Cut (gemstone) derived at publish: `deriveCut` / `BUILTIN_CUTS` (`packages/model/src/gemTypes.ts`).
  - Stone rating computed client-side: `stoneRating(floor, stars, installs)` / `isDiamond(...)`
    (`packages/marketplace/src/gems/rating.ts`), rendered by `StoneRating.tsx` / `CutBadge.tsx`.
- **The catalog query already merges sources.** Public browse rows come from the GitHub registry
  index (`mapIndexToGems`) unioned with Postgres `catalog_gems` (`mapDbToGems`), merged by
  `mergeGems` (`src/gem/publicCatalog.ts`). Each `RegistryGem` (`src/gem/publicCatalog.ts:10`)
  already carries `key, version, author, description, tags, artifactKinds, type` (cut),
  `publishedBy`, `grade`, `installable`.
- **The pattern to copy is SP2 (the public profile page).** `buildProfile` +
  `GET /api/aggregator/profile?login=` + marketplace `Profile.tsx` at `/@login`. The org catalog
  is the same feature shape with `scope` swapped for `login`.

## 3. Architecture

Hosted, end-to-end mirroring SP2:

```
Browser  /orgs/:scope
   │
   ▼
OrgCatalog.tsx  ──getOrgCatalog(scope)──►  GET /api/aggregator/org-catalog?scope=acme
(packages/marketplace)                              │
                                                    ▼
                                    buildOrgCatalog(scope, deps)   (aggregator)
                                        │  resolve @scope/* from merged catalog
                                        │  (mapIndexToGems ∪ catalog_gems)
                                        ▼
                                    computeGemRubric(row)   (pure, orgRubric.ts)
                                        │
                                        ▼
                                    rows: {key, version, cut, grade, owner,
                                           stars, installs, rubric:{score, checks[]}}
```

- **API base:** the hosted `src/` app (served at `api.agentgem.ai`, `SERVE_CONSOLE=false`),
  alongside the existing aggregator routes. Endpoint is a **query-param GET** matching
  `profile?login=` — mind the `AgentError instance === statusCode` gotcha SP2 hit.
- **SPA:** new route `/orgs/:scope` in `packages/marketplace`.

## 4. Components (each independently understandable & testable)

### 4.1 `orgRubric.ts` — pure rubric computation
Location: `packages/aggregator/src/orgRubric.ts` (or `packages/model` if it needs to be shared;
default aggregator since inputs are catalog rows). **No I/O.**

- `ORG_RUBRIC`: an ordered array of check definitions `{ id, label, howToFix, test(row) }`.
- `computeGemRubric(row): { score, checks: Array<{id, label, pass, howToFix}> }` where
  `score = passing / total` (0..1).

**v1 checks (computed purely from the hosted catalog row):**

| id | label | pass when | howToFix |
|----|-------|-----------|----------|
| `documented` | Documented | non-empty `description` **and** ≥1 `tag` | "Add a description and tags before publishing." |
| `substance` | Has substance | `artifactKinds.length >= 1` | "Publish at least one artifact (skill, mcp_server, …)." |
| `battleTested` | Battle-tested | `grade >= 2` | "Distill from real, battle-tested sessions to raise the grade." |
| `adopted` | Adopted | `stars >= 1` **or** `installs >= 1` | "Share the gem so others star / install it." |
| `attributed` | Attributed | `publishedBy` present | "Publish under a verified account." |

Rationale for the exact set: every input is present on `RegistryGem` today, so the rubric needs
**zero new data pipelines**. Deeper checks (cross-agent verified, has evals) are deferred — see §8 D2.

### 4.2 `buildOrgCatalog(scope, deps)` — resolver
Location: `packages/aggregator/src/orgCatalog.ts`. Mirrors `buildProfile`.

- Signature: `buildOrgCatalog(scope: string, deps: { loadCatalog(): Promise<RegistryGem[]> }): Promise<OrgCatalog>`.
- `loadCatalog` is injectable (real impl reuses the existing merged-catalog loader; tests pass a fake).
- Filters rows to those whose key scope equals `@{scope}` (unscoped gems are excluded).
- Maps each through `computeGemRubric`.
- Returns `OrgCatalog { scope, gemCount, ownerCount (distinct publishedBy), gems: OrgCatalogGem[] }`
  sorted by grade desc, then stars desc (server provides a stable default; client can re-sort).

### 4.3 Route `GET /api/aggregator/org-catalog?scope=`
Location: alongside the profile route in the aggregator controller.

- Query schema: `{ scope: z.string().min(1).regex(SCOPE_RE) }`.
- Response schema: `OrgCatalogSchema` (Zod), added to the console/marketplace route contracts.
- Malformed `scope` → 400 `AgentError`. Unknown/empty org → 200 with `gemCount: 0` (empty state
  handled client-side).

### 4.4 `OrgCatalog.tsx` — list view
Location: `packages/marketplace/src/orgs/OrgCatalog.tsx`, routed at `/orgs/:scope`.

- Header: `@{scope} · {gemCount} gems · {ownerCount} owners`.
- Controls: text search (name/description); filter chips by **cut**, **grade**, **owner**; sort by
  grade / stone rating.
- Row: `CutBadge` + `StoneRating` (reuse existing; client computes stone from `grade/stars/installs`)
  + a **rubric ring** (score as a small progress ring) + owner.
- Row click → rubric detail drawer (§4.5).
- Empty state: "No gems published under @{scope} yet."

### 4.5 Rubric detail drawer
A drawer/section (reuse existing gem-detail surface if one exists; else a modal) listing
`rubric.checks` with pass/fail icon, label, and the `howToFix` line for failing checks.

## 5. Data flow (request lifecycle)
1. SPA route `/orgs/:scope` mounts `OrgCatalog.tsx`.
2. `getOrgCatalog(scope)` → `GET /api/aggregator/org-catalog?scope=`.
3. Server `buildOrgCatalog` loads the merged catalog, filters to `@scope/*`, computes rubric per gem.
4. Client renders badges + rings; drawer shows the checklist on demand.

## 6. Error handling
- Malformed scope → 400.
- Empty/unknown org → 200 + empty state.
- Catalog load failure → surface a non-silent error state in the SPA (do not render an empty org as
  if it had zero gems).

## 7. Testing
- **`computeGemRubric`** (pure): a table test per check (pass and fail rows) + composite score.
- **`buildOrgCatalog`**: with a fake `loadCatalog` dep returning mixed-scope rows — asserts scope
  filtering, `ownerCount` distinctness, and default sort. Mirror `buildProfile`'s test.
- **Route contract test**: valid scope, malformed scope (400), empty scope (200 + empty).
- **`OrgCatalog.tsx`** render test (filter/sort/empty). **Runs locally** — CI does not run the
  console/marketplace vitest suites.

## 8. Decisions made explicit

- **D1 — Org = scope-from-gem-key.** The org page reads gems by their `@scope/*` key, not by an
  `account_scopes` membership join. Simpler, needs no membership data, and matches how gems are
  actually published. Consequence: only scoped gems appear on org pages; unscoped gems have no org.
- **D2 — v1 rubric = catalog-row signals only.** "Cross-agent verified" lives solely in the
  **local** `~/.agentgem/verifications.jsonl` (`packages/run/src/evidenceLedger.ts`), which is
  intentionally never uploaded. A hosted rubric cannot read it. "Has evals" needs the full manifest
  (not in the teaser feed). Both are **fast-follows**, not v1 — the hosted equivalents would read the
  Postgres `attestations` table and/or fetch the manifest per gem (cached).
- **D3 — Public-first.** Org pages group + grade gems already public in the registry. No visibility
  enum, no member gating — those belong to enterprise-tier subsystem #4.

## 9. Explicitly out of scope (deferred)
- Visibility enum / internal / member-gating → #4.
- First-class owner/lifecycle fields (`experimental/production/deprecated`) → #3.
- Approval / audit control plane → #2.
- Per-org custom rubrics.
- Cross-agent-verified & has-evals rubric checks → fast-follow (§8 D2).

## 10. Fast-follows (post-v1, noted not planned)
- Add `crossAgentVerified` and `hasEvals` rubric checks by joining hosted `attestations` and/or
  fetching gem manifests (cached).
- Link org pages from gem detail (`publishedBy` → `/orgs/:scope`) and from `/@login` profiles.
- Org header enrichment (avatar/name) once org-level identity exists.
