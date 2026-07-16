# TODOS

Deferred work, with enough context to pick up cold.

## Key federated membership on GitHub's numeric user id, not the login string

**What:** Add `gh_user_id` to `org_members` and match accounts on
`accounts.provider_account_id` (which already stores GitHub's numeric id) instead of
`lower(accounts.login)`.

**Why:** GitHub logins are mutable. A member who renames their GitHub account becomes
unmatchable: `accountIdForLogin('oldname')` returns null, the `member_removed` webhook
for their old login silently no-ops, and their `via_sync` grant goes stale. An
offboarded member who renamed keeps group access until their captured scopes expire.

**Pros:** Removes the last mutable-string join from the membership path.
`provider_account_id` is already stored and already unique per provider.

**Cons:** `org_members` is populated from GitHub's roster API; changing it means a
backfill and a webhook payload change. Same debt the `account_identities` split will
confront anyway.

**Context:** Two call sites — `accountIdForLogin` in
`packages/aggregator/src/groupsFederation.ts`, and the `member_added` / `member_removed`
branches in `src/githubApp/sync.ts:95-102`. Target key is `accounts.provider_account_id`
(`packages/aggregator/src/schema.ts:81`). Surfaced by the Codex outside voice during the
2026-07-08 eng review of the groups plan. Mitigating factor: it self-heals on the
member's next sign-in, because `captureOrgMemberships` re-materializes their grant under
the new login.

**Depends on / blocked by:** Nothing blocking. Naturally belongs with the
`account_identities` sequel, which re-keys identity anyway.

## Fix the catalog cookie-only Bearer gap

**What:** `catalog/install.ts` resolves the session from the cookie only, while every
sibling public route (`orgsApi`, `usage`, `groups`, etc.) accepts either a session
cookie or `Authorization: Bearer` via `resolveSession`. So the CLI cannot call
`DELETE /api/catalog/gem` (or the catalog reads) with a Bearer token.

**Why:** A real inconsistency bug on an auth path — the CLI can publish/unpublish
everywhere except catalog. The fix is one line: route catalog's session lookup through
`resolveSession(auth, req.headers)` like the others (add a regression test:
`DELETE /api/catalog/gem` with a Bearer token → 200).

**Pros:** Closes a documented bug; makes the catalog auth surface uniform with its
siblings; ~one-line change plus a test.

**Cons:** Widens catalog's accepted auth (cookie → cookie|Bearer). Intended, but must be
tested so it's owned, not accidental.

**Context:** The CORS/`preflight`/type-shim dedup half of this (originally "shared
routeKit") shipped as Fix 1 — `src/publicCors.ts`, PR #371. The *controller migration*
that would have folded this in (Fix 3) was reviewed and SHELVED on 2026-07-12
(`docs/superpowers/specs/2026-07-12-public-api-framework-migration-design.md` — the
framework-native path breaks the flat `{error:"..."}` envelope). So this Bearer bug is
now a standalone fix, not blocked on any migration.

**Depends on / blocked by:** Nothing. Its own small PR.

## Author a console DESIGN.md (design-system doc)

**What:** Write DESIGN.md for `packages/console` documenting the theme.css token
system (`--ink`/`--paper`/`--accent`/`--line`), the `play-*` component vocabulary,
and surface rules (e.g. one terracotta primary per surface; segmented control for
single-choice groups; visible labels, placeholder is a format hint only).
`/design-consultation` can drive it.

**Why:** The 2026-07-15 Studio toolbar design review had to reverse-engineer the
design system from theme.css. A DESIGN.md lets future design reviews calibrate
against stated rules instead of inference.

**Pros:** Faster, more consistent design reviews; "one primary per surface" becomes
written law instead of oral tradition; onboarding aid.

**Cons:** ~an hour of documentation; risks staleness if not maintained.

**Context:** Flagged during /plan-design-review of
`docs/superpowers/specs/2026-07-15-studio-toolbar-declutter-design.md`. The token
system already behaves like a design system; it's just undocumented.

**Depends on / blocked by:** Nothing.

## Multi-instance connectors (connector type vs installed gem instance)

**What:** Let a miniapp declare a connector TYPE and let the viewer bind which installed
`mcp_server` gem instance satisfies it (alias/binding UI + a `selection_required`-style
pending state), instead of the manifest hard-naming one gem.

**Why:** Real users run two Slack workspaces or work+personal GitHub. v1 mcpNeeds
name-address a single installed gem, so a second instance needs a differently-named gem
the miniapp can't reach without editing its manifest.

**Pros:** Unlocks multi-account reality; the mirrored claude.ai contract already sketches
the UX (`selection_required`, per-view name binding via an additive options hint — never
per-call resolution).

**Cons:** A binding layer, per-viewer state, and selection UI — real scope for a need no
user has voiced yet.

**Context:** From the Codex outside voice during the 2026-07-15 eng review of the miniapp
MCP connectors design (finding #10). v1 ships name-addressed manifests with hash-pinned
consent (D9); `server_not_connected` copy should hint at the install/rename workaround.
Evolution path: additive options hint narrowing the single per-view name binding, exactly
as the claude contract documents its own future.

**Depends on / blocked by:** MCP connectors v1 (model + console consent). Nothing else.

## Marketplace install-time connector disclosure (read/action badges)

**What:** Persist tool annotation hints (readOnlyHint/destructiveHint) alongside mcpNeeds
at publish so game cards can show "GitHub — 3 read tools" vs "Slack — posts messages"
before install, not just the connector-name chip.

**Why:** Install-time is when users weigh risk (Codex outside-voice finding #14); the v1
chip names connectors but not whether the app only reads or can act.

**Pros:** Honest risk signal at the decision moment; the watch-gate work (D11) already
plumbs annotations at runtime — this persists them at publish.

**Cons:** Annotations are UNVERIFIED connector self-description captured at author time;
they can drift from the viewer's actual gem. Must be framed advisory, never authoritative.
Publish wire schema grows.

**Context:** From the 2026-07-15 eng review of the miniapp MCP connectors design. v1
covers the security moment with the run-time consent card (lists declared tools); this is
the v1.1 install-time enrichment. Beware treating author-time hints as verified data.

**Depends on / blocked by:** MCP connectors PR-1 (publish wire schema) + D11 annotation
handling.
