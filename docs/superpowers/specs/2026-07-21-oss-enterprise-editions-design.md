# OSS + Enterprise editions sweep — design

**Date:** 2026-07-21
**Status:** Approved (brainstorm complete)
**Scope:** docs/, website/, README.md — align public content with the 0.9.0
local-first code split and introduce the dual OSS + Enterprise offering.

## Background

The 0.9.0 refactor made `@ninemind/agentgem` explicitly **local-first**: the
hosted-service surface (accounts, orgs, groups, hosted reviews, GitHub App,
OG cards), cloud deploy, and the GitHub-repo gem registry were removed from the
OSS package. Those capabilities were not killed — they moved to the private
`agentgem-enterprise` codebase and still run as the hosted service behind
app.agentgem.ai. Public content (docs, website, README) still describes much of
that surface as part of the OSS package, and the website build is **currently
broken**: `website/build.mjs` lists the deleted `docs/registry.md` in its page
allow-list, so `pnpm build:site` throws ENOENT.

An audit (2026-07-21) confirmed: all six `skills/*/SKILL.md` are clean
(`agentgem-miniapp/SKILL.md` verified byte-for-byte in sync with
`MINIAPP_BUILDER_BRIEF`), most docs were correctly realigned in commit
`1c81d94f`, and the remaining drift is concentrated in `api-reference.md`,
`architecture.md`, `index.md`, `sharing.md`, `README.md`, and both website
pages.

## Decisions (user-approved)

1. **Full dual-offering messaging** — website gets an OSS vs. Enterprise
   section, docs get an editions page, README gets an editions blurb.
2. **Two offerings, marketplace shared** — OSS and Enterprise are the
   offerings; the app.agentgem.ai marketplace is presented as the shared
   community service both use, not a tier.
3. **Early access framing** — Enterprise is "in early access"; the CTA is
   `mailto:raymond@ninemind.ai`. No pricing page, no GA claims.
4. **Groups are Enterprise** — groups and review-gated releases sit in the
   Enterprise column. The community marketplace column is: accounts,
   `/@handle` profiles, publish/star/review, the arcade.

## The story (told identically everywhere)

- **AgentGem OSS** — MIT, `npx @ninemind/agentgem` + the desktop app. The
  local-first console: mine your sessions (Analyze/Recall/insights), distill
  skills, build/merge Gems, materialize to targets and run locally, Play
  miniapps, context hygiene, chat — plus the marketplace *client*
  (`agentgem get`, publish-to-Explore, `send`/`receive`, `verify`).
- **The community marketplace** (app.agentgem.ai) — a free hosted service
  operated by ninemind, shared by both editions: accounts (GitHub, Google,
  X, passkey), `/@handle` profile hubs, publish/star/review, the arcade of
  installable offline-playable miniapp PWAs, branded link-preview cards.
  Presented as *where Gems live*, not as code in the OSS package.
- **AgentGem Enterprise** (early access) — for teams that need the platform
  under their control: groups and review-gated releases, orgs with
  scorecards / team-usage dashboards / benchmark governance, cloud miniapp
  builds, the GitHub App, AWS self-host via Terraform, support.
  CTA: `raymond@ninemind.ai`.

The re-attribution rule for docs: hosted features are described as
capabilities *of the hosted service you connect to*, never as routes or
modules of the local OSS server.

## Changes

### New: `docs/editions.md`

The canonical editions page: what's in each edition, the shared-marketplace
explanation, a compact comparison table, the early-access CTA. Registered in
`website/build.mjs` `DOC_PAGES` + `NAV_SECTIONS` so it renders on the site
(and lands in `llms.txt`/sitemap automatically), and linked from
`docs/index.md` "Start here" and README.

### Website

- **`website/build.mjs`** — remove `docs/registry.md` from `DOC_PAGES` (line
  ~56) and `NAV_SECTIONS` (line ~98) — this fixes the broken build; add
  `docs/editions.md`; fix the doc-shell footer template's dead
  `docs/registry.html` link (line ~235).
- **`website/index.html`**
  - Hero (~line 55): drop "deploy it on demand, and sell it per call" —
    local-first phrasing.
  - Flow "Deploy it" station (~146–150) → "Materialize & run it".
  - "Composable registry" card (~201–206): the GitHub-backed registry is
    gone — becomes a marketplace install/merge card.
  - "Deploy anywhere" card (~207–212): drop "managed backends / publish /
    undeploy"; keep the real code-gen targets + Materialize "Run app".
  - "Publish it, review it, ship it as a team" section (~253–282): split.
    Community-marketplace content (publish scopes/versioning, stars,
    reviews, profiles, arcade) stays as the marketplace section;
    groups/review-gating/orgs/governance content moves into a new
    **"Open source & Enterprise"** section with the comparison and the
    early-access CTA.
  - Ladder/Shopify section (~304–340): rung claims corrected (the "Publish"
    rung no longer cites the removed registry).
  - Footer (~350–351): dead registry link removed.
  - Desktop download pointer stays at `desktop-v0.8.0` (latest released
    desktop build).
- **`website/vision.html`** — rung 2 "GitHub-backed registry … Shipped"
  (~145–149) and "The registry is the network seed" (~209–213) rewritten
  around the marketplace; "This ring is shipped" team paragraph (~196) split
  community vs. Enterprise; dead registry links (~236, ~249) fixed. The
  Shopify vision framing stays — it is roadmap and honest there.

### Docs truth sweep

- **`docs/api-reference.md`** (~79–93): keep `GET /api/registry/gems` and
  `/api/memory/*` (real local routes); the hosted families (publish-status,
  install-hosted, reviews, groups, identity, benchmark, OG cards)
  re-attributed as the hosted marketplace's API, not local-server routes.
- **`docs/architecture.md`** (~48–53): the "bottom band" paragraph reframed —
  the hosted marketplace is a separate service (enterprise codebase) the
  console talks to as a pure client.
- **`docs/index.md`** (~63–72): accounts/profiles attributed to the hosted
  service; link `editions.md` from "Start here".
- **`docs/sharing.md`**: OG cards (~79–108) and "Web accounts" (~110–119)
  re-attributed to the hosted service; client flows (`get`, `send`/`receive`,
  `verify`, `bind`) untouched.
- **`README.md`** (~81–96): marketplace/identity bullets re-attributed;
  groups/orgs content folded into a short **Editions** section linking
  `docs/editions.md` and the website.

### Quick freshness wins (small, in scope)

- `docs/chat.md`: a paragraph on the type-while-busy queue + turn Interrupt.
- `docs/play.md`: a line on miniapp MCP connectors (`mcpNeeds` + consent) and
  the Repo Pulse built-in demo. Full connector docs stay out of scope — the
  miniapp spec (`docs/miniapps/spec.md`) remains the source of truth.

### Explicitly out of scope

- All six `skills/*/SKILL.md` (audit-clean; miniapp skill only ever changes
  via `MINIAPP_BUILDER_BRIEF`).
- Pricing page, GA claims, separate OSS/Enterprise doc trees.
- New endpoint documentation for the chat POST-then-stream transport or
  connector internals.
- Desktop download pointer bump (no new desktop release).

## Verification

1. `pnpm build:site` passes (it currently cannot — the registry.md removal is
   the regression test for the build fix).
2. `grep -r "registry.html" website/dist` returns nothing.
3. `docs/editions.html` and the reworked index/vision sections render
   correctly in a real browser (light + dark, mobile width).
4. `pnpm test` — the `builderBrief` drift test and the full suite stay green.
5. `llms.txt` / `sitemap.xml` include `editions`, exclude `registry`.

## Integration

Work happens on the `editions-sweep` branch in
`../agentgem-worktrees/editions-sweep`; lands via PR gated on `test (24)`,
per the repo's PR-lifecycle rules.
