# AgentGem GitHub App — Design

**Date**: 2026-07-05
**Status**: Approved (brainstorm complete)
**Scope**: P1 (App foundation + membership truth) + P2 (private org sources), shipped as one track. P3 (bot-identity registry publish) is explicitly out of scope.

## Context & motivation

AgentGem is heading enterprise-first for GTM. Today's GitHub integration is a minimal OAuth app (`read:user` device flow + web code flow) whose org awareness is limited to *public* org memberships captured at sign-in (`accountVerifier.ts` — "v1 is PUBLIC orgs only"). GitHub org memberships are private by default, so real enterprises are invisible to Team Pulse gating (`/api/usage/org`), publish-ownership scoping, and the org catalog's membership checks.

An **installable GitHub App** fixes this with one org-admin action: installing the App grants AgentGem authoritative, private-inclusive membership data server-to-server — no per-user scope escalation — and read access to selected internal repos, which become members-only skill sources. "Install AgentGem on your org" becomes the enterprise onboarding motion.

The API runs always-on at `api.agentgem.ai` on Fly.io, so webhook delivery is reliable (GitHub webhooks time out at 10s and are not auto-retried).

## Decisions (settled during brainstorm)

1. **Identity stays on the OAuth app.** The GitHub App is server-to-server only: no user-to-server OAuth, no change to device flow, `/bind`, or the session bridge.
2. **Metadata-only data custody.** Private skill *metadata* (name, description, path, division) is indexed into AgentGem's DB, gated by membership. Skill *bodies* stay in the customer's GitHub and are proxied on demand with installation tokens. Nothing private is stored beyond metadata; uninstall deletes it.
3. **Install selection = source list.** GitHub's install screen ("all repos / selected repos") *is* the admin's source-curation UI. Every accessible repo containing SKILL.md files is a source. No separate admin settings surface for v1.
4. **Architecture: in-server module + webhooks, reconcile backstop** (Approach A). New `src/githubApp/` module in the existing API app; webhooks are the primary sync path, a daily reconcile loop heals missed deliveries. No new service, no Octokit dependency (hand-rolled `fetch` + `node:crypto` RS256, matching `registryGithub.ts` / `accountVerifier.ts` style).

## 1. App registration & configuration

One GitHub App owned by the `ninemindai` org, named **AgentGem**.

- **Permissions** (minimal — additions require re-approval by every installed org):
  - Organization members: read
  - Contents: read
  - Metadata: read (mandatory)
- **Webhook events**: `installation`, `installation_repositories`, `organization` (member added/removed), `push`.
- **Webhook URL**: `https://api.agentgem.ai/api/github/webhook`.
- **Setup URL** (post-install redirect): `https://app.agentgem.ai/orgs/:scope?installed=1` so the admin lands on their org catalog.
- **Server config** (Fly secrets): `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (PEM), `GITHUB_APP_WEBHOOK_SECRET`.
- **Dormant when unconfigured**: with any secret missing (local dev, self-hosters), the webhook returns 503, no reconcile loop runs, and all gates fall back to today's captured-scope behavior. Zero new behavior without the secrets.

## 2. Data model

Raw-SQL `create table if not exists` in `packages/aggregator/src/schema.ts`, plus the `schema.test` table-list update (known gotcha).

```sql
create table if not exists app_installations (
  installation_id bigint primary key,
  org_scope text not null,          -- GitHub org login, lowercased
  repo_selection text not null,     -- 'all' | 'selected'
  suspended boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists org_members (
  org_scope text not null,
  gh_login text not null,           -- lowercased
  role text not null,               -- 'admin' | 'member'
  synced_at timestamptz not null default now(),
  primary key (org_scope, gh_login)
);
```

`curated_skills` gains a nullable `org_scope text` column. `NULL` = public curated source (all existing rows, unchanged). Non-null = private org row, keyed `source_id = 'org:<org>/<repo>'`, and **excluded from every existing public query** (`where org_scope is null` added to public read paths).

## 3. Membership sync

- `installation.created` → upsert `app_installations`; page through `GET /orgs/{org}/members?role=admin` then `?role=member`; replace that org's `org_members` rows atomically.
- `organization.member_added` / `member_removed` → single-row upsert/delete. Offboarding propagates in seconds.
- `installation.suspend` / `unsuspend` → flip `suspended` (gates treat suspended as uninstalled).
- `installation.deleted` → delete the installation row, its `org_members`, and its private `curated_skills` rows. Uninstall means we forget.
- **Daily reconcile** (warm-daemon scheduling pattern, like the usage reporter): list all installations via the App JWT, re-sync members and re-index repos for each. Heals any missed webhook.

**Installation tokens**: minted on demand — RS256 JWT (`node:crypto`, `iss` = App ID, 10-min expiry) → `POST /app/installations/{id}/access_tokens`. Cached in-memory per installation for ~55 minutes. Never persisted, never logged.

## 4. Gating changes

`accountOwnsScope(db, accountId, scope)` gains a companion check; the effective gate for `/api/usage/org`, publish-ownership (`uploadPublish`), and org-settings admin writes becomes:

> captured scope (today's behavior) **OR** App-synced membership (session login ∈ `org_members[scope]` with a non-suspended installation)

- Orgs without the App: behavior is byte-for-byte today's.
- Orgs with the App: private members now pass; the synced `role` column becomes the authoritative source for admin-gated writes (org_settings, PR #132 precedent), with the existing role capture as fallback.
- Login matching is case-insensitive (logins lowercased at write time).

## 5. Private source indexing

One function, `indexOrgRepo(installationId, orgScope, repo)`, invoked from three triggers:

1. `installation` / `installation_repositories` webhooks → index newly selected repos; delete `curated_skills` rows for deselected repos.
2. `push` webhook on a source repo's **default branch** → reindex that repo.
3. Daily reconcile → re-walk all repos of all installations.

Mechanics: mint installation token → reuse the generic skills-layout adapter (`@agentgem/distribute` ghTree walk, PR #107) authenticated with that token → upsert metadata rows (`name`, `description`/frontmatter, `path`, `division`, `repo`, `org_scope`). Repos with no SKILL.md files simply produce zero rows. Bodies are never stored.

## 6. Serving & marketplace surface

Three member-gated endpoints cloning the `src/usage/install.ts` raw-express pattern (Bearer ≡ session-cookie `whoami`, credentialed CORS, originGuard-exempt prefix):

- `GET /api/orgs/app?scope=` → `{ installed, isMember, role }`. Drives conditional UI. (Non-members get `installed` + `isMember:false` only — no member list leakage.)
- `GET /api/orgs/skills?scope=` → private skill metadata list; 401 unsigned, 403 non-member.
- `GET /api/orgs/skill-body?scope=&source=&path=` → on-demand body proxy: validates membership, validates `source` belongs to `scope`, fetches via cached installation token, returns markdown. Read path for both the marketplace preview and `agentgem sources install` (the CLI already carries a session Bearer from `~/.agentgem/session.json`).

**Marketplace (`OrgCatalog` page)**:
- **Internal skills** section, rendered only when `/api/orgs/app` reports `isMember`.
- **Install the AgentGem GitHub App** CTA (→ `https://github.com/apps/agentgem/installations/new`) when not installed — the enterprise funnel front door.

## 7. Security & error handling

- **Webhook verification**: HMAC-SHA256 over the *raw* request body vs `X-Hub-Signature-256`, compared with `timingSafeEqual`. 401 on mismatch; 503 when unconfigured. The raw body must be captured before JSON parsing (express raw-body handling on this route).
- **Idempotency**: all handlers are upserts/deletes keyed by natural ids; GitHub redeliveries and reconcile overlap are harmless.
- **Fast ack**: respond 200 immediately after verification; run event processing in a per-event `try/catch` with log-and-continue (the `accountVerifier` failure-tolerance style). A failed handler never 500s the webhook.
- **originGuard**: `/api/github/webhook` and `/api/orgs/*` must be exempt/registered correctly — explicit test, since a missing originGuard path once shipped `/sources` DOA (PR #102 lesson).
- **Secrets hygiene**: PEM parsed once at boot; keys and tokens never logged (use existing maskSecret conventions); installation tokens only in the in-memory cache.
- **Rate limits**: per-installation quota is 5k+/hr; reconcile paginates politely and the indexer batches per repo. Star-count style "default on error" tolerance throughout.

## 8. Testing

- **JWT/token unit tests**: fake-`fetch` (the `deviceFlow.test.ts` pattern) asserting JWT claim shape, token-exchange request, and cache expiry behavior.
- **Webhook tests**: HMAC pass/fail/unconfigured; event dispatch; member add/remove deltas; uninstall cascade (installation + members + skills rows all gone); suspended handling.
- **Gate tests**: member passes, non-member 403s, suspended installation 403s, no-App org falls back to captured scopes; case-insensitivity.
- **Indexer tests**: fake `Http` walk fixtures (reuse distribute test fixtures); deselect-repo cleanup; push-triggered reindex.
- **Endpoint tests**: 401/403/200 matrix per endpoint; `skill-body` source∈scope validation; originGuard exemption test.
- **Schema test**: table-list update.
- **Marketplace page tests**: `api` stub for `/api/orgs/app` + section render matrix — run locally (`pnpm --filter @agentgem/marketplace test`); CI skips console/marketplace tests (known gap).
- **Local webhook dev**: reconcile path covers most manual testing; a smee.io channel proxies real webhooks when needed. Automated tests never touch the network.

## Acceptance criteria

1. An org admin installs the App on a test org with a private SKILL.md repo → within seconds, private members see the org's Team Pulse and an Internal-skills section on `/orgs/:scope`; non-members get 403s.
2. Removing a member on GitHub revokes their access within seconds (webhook) and, at worst, within 24h (reconcile).
3. Uninstalling the App removes all installation, membership, and private-skill rows.
4. With App secrets unset, the server behaves exactly as before this change (all existing tests green, no new routes active beyond 503).
5. Public marketplace queries never return `org_scope`-tagged rows.

## Out of scope

- P3: bot-identity registry publish (move off the personal PAT) — follow-up spec.
- Migrating user identity to GitHub App user-to-server tokens.
- Billing / GitHub Marketplace listing.
- Per-repo admin settings UI beyond GitHub's own repo-selection screen.
- Private *gem* (as opposed to skill-source) publishing/catalogs.
