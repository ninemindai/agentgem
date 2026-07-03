# Unified GitHub Identity — Sub-project 1: Reconcile bindings ↔ accounts + capture avatar

Date: 2026-07-03
Status: Design — pending user review
Branch: `feat/identity-reconcile-avatar` (off `origin/main`)

## Context

AgentGem already has **two disconnected GitHub-identity systems**:

- **Web sign-in** (`packages/aggregator/src/webAuth.ts` + `accounts` + `web_sessions`): a full GitHub OAuth web sign-in for app.agentgem.ai — `accounts` stores `login` **and `avatar_url`** (`upsertAccount`, keyed on `(provider, provider_account_id)`), with a 30-day session cookie and `resolveSession → {login, avatarUrl, accountId}` + `account_scopes`.
- **Console "Verify identity"** (`packages/aggregator/src/binding.ts` + `account_bindings`): links the local **producer keypair** (`pubkey`) to a verified GitHub account (`account_id` + `account_login`, **no avatar**), for verified-install ratings ("unlock 💎 Diamond"). This is what the Settings "Verified as @bob" line reads.

Both reference the **same GitHub identity** (`provider` + numeric account id) but are **not linked**. The user asked to "unify both" — one GitHub identity with an avatar and a profile, across the console and app.agentgem.ai.

**Decomposition (each its own spec → plan):**
1. **This doc** — reconcile `account_bindings` ↔ `accounts` and surface the avatar in the console Settings identity box (the foundation + the user's literal ask).
2. Profile page on app.agentgem.ai (`/@login`: avatar + published gems + ratings).
3. Avatars everywhere (explore/marketplace + console listings).

## Design decision

**Reconcile by reusing `upsertAccount` on bind; join `(provider, account_id)` for `bindStatus`.** The web OAuth already writes the canonical `accounts` row (with avatar) via `upsertAccount`, whose conflict target is `(provider, provider_account_id)`. Calling the same function on device-flow bind makes the console producer and the web session point at **one** `accounts` row — the reconciliation *is* the existing upsert key. **No new columns, no FK, no migration.**

Rejected: adding an `avatar_url` column to `account_bindings` (keeps two identity stores — doesn't unify, and sub-project 2 would still need to reconcile); a hard `account_bindings.account_id → accounts.id` FK (bigger migration + backfill for no additional value at this slice).

## Part A — reconciliation + backend flow

Data path when the user clicks **Connect GitHub** (device flow):

```
GitHubVerifier.verify(token)              // already fetches https://api.github.com/user
   also read u.avatar_url  →  VerifiedAccount { provider, accountId, login, avatarUrl? }
        │
recordBinding(db, req, verifier)
   ├─ upsertAccount({ provider, accountId, login, avatarUrl })   // existing webAuth fn; keyed (provider, provider_account_id)
   │      → the SAME accounts row the web sign-in uses (avatar canonical here); best-effort (see errors)
   └─ upsert account_bindings (pubkey → provider, account_id, account_login)   // unchanged
        │
   →  BindResult { bound, provider, login, accountId, avatarUrl? }   // avatar RIDES the /bind response
[console] completeDeviceBind → writes ~/.agentgem/binding.json { …, avatarUrl }   (console status is this LOCAL FILE)
[console] readBindingStatus  → reads binding.json → { bound, login, provider, avatarUrl }
```

**Correction found during planning:** the console's status is the local file `~/.agentgem/binding.json` (`bindCore.ts`), NOT a DB query. `completeDeviceBind` POSTs the token to the hosted aggregator's `/api/aggregator/bind` and writes the response locally — so the avatar reaches the console by riding the `/bind` **response** into that file. `upsertAccount` still runs server-side (canonical `accounts` row for reconciliation + the profile sub-project); it just isn't what the console reads.

**Changes (all in `@agentgem/aggregator` + the bind controller):**
- `accountVerifier.ts` — `VerifiedAccount` gains `avatarUrl?: string`; `verify()` reads `u.avatar_url` (typed as `avatar_url?: unknown`, coerced to `string | undefined`) from the `/user` response it already parses. `fetchOrgs`/scope path untouched.
- `binding.ts` `recordBinding` — after the existing signature/freshness/producer checks, call `upsertAccount(db, { provider, accountId, login, avatarUrl })`, then the existing `account_bindings` upsert. `BindResult` gains `avatarUrl?: string`.
- `src/aggregator.controller.ts` — `BindResultSchema` (line 44) gains optional `avatarUrl` so the `/api/aggregator/bind` response carries it to the console.
- `src/bind/bindCore.ts` — `completeDeviceBind` reads `out.avatarUrl` from the `/bind` response and writes it into `~/.agentgem/binding.json`; its return type + `readBindingStatus` gain `avatarUrl?`. **The console's status is this local file, not a DB join.**
- `src/gem.controller.ts` — `BindStatusSchema` (line 277) + `BindCompleteSchema` gain optional `avatarUrl`.
- **No new columns / FK / migration.** `upsertAccount`'s existing `(provider, provider_account_id)` conflict key *is* the reconciliation.

## Part B — console UI, edges, testing

**Console UI (`packages/console/src/panels/Settings/index.tsx`):**
- `BindStatus` type + the `bindStatusRoute` / `bindComplete` **client** response schemas (`api/routes.ts`) gain `avatarUrl?: string` — kept byte-identical to the server schema (this repo's recurring client/server-contract gotcha).
- The "Verified as @bob" line becomes a small round avatar `<img>` + `@login`, rendered only when `avatarUrl` is present; absent → the current text-only fallback (no broken image), no layout overhaul.
- GitHub avatars come from `avatars.githubusercontent.com` (cross-origin `<img>`). The console shell is not under the Watch sandbox's strict CSP, so a normal `<img src>` loads; verify against the shell CSP during implementation and, if locked down, allow that host for `img-src` (no proxy).

**Error handling / edges:**
- No `avatar_url` from GitHub → `avatarUrl` undefined → text-only fallback. Never throws.
- `upsertAccount` is **best-effort**: a failure must not fail the bind (the binding — what ratings depend on — still returns `bound: true`; avatar merely absent). Wrap it so a failure logs and continues.
- Pre-change bindings (no `accounts` row yet) → `bindStatus` join returns `null` avatar → text-only until the next bind (which upserts the row). No backfill.

**Testing:**
- `accountVerifier.verify()` surfaces `avatarUrl` from a `/user` fixture; omits it gracefully when the field is missing.
- `recordBinding` upserts the `accounts` row (with avatar) **and** the binding; a failing `upsertAccount` still returns `bound: true` (best-effort).
- Bind-status read returns `avatarUrl` via the join when an `accounts` row exists; `null`/absent otherwise.
- Settings component renders the avatar `<img>` when `avatarUrl` present; text-only fallback when absent.

## Non-goals (later sub-projects / out of scope)

- Profile page on app.agentgem.ai (sub-project 2).
- Avatars in explore/marketplace/console listings (sub-project 3).
- A hard FK `account_bindings.account_id → accounts.id` or a backfill of existing bindings.
- Changing the web OAuth sign-in flow (it already captures avatar).

## Self-review

- **Placeholders:** none — every change names a real file/function verified in the codebase (`accountVerifier.ts`, `binding.ts`, `webAuth.ts` `upsertAccount`, `aggregator.controller.ts` bind route, `Settings/index.tsx`, `api/routes.ts`).
- **Consistency:** the reconciliation key `(provider, account_id/provider_account_id)` is used identically in the upsert conflict target, the `bindStatus` join, and matches `account_bindings`'s existing columns. Avatar is optional/best-effort throughout, consistent with "binding must never fail over avatar."
- **Scope:** single implementation plan — verifier field + `recordBinding` upsert + bind-status join + two schema fields + one Settings UI change + tests. Profile/avatars-everywhere are explicit non-goals.
- **Ambiguity:** "unify" is pinned to "share one `accounts` row via `upsertAccount`'s existing conflict key," not a new FK.
