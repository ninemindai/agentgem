# Verify-Identity (bind-on-install) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — the follow-up that makes VERIFIED adoption actually accrue, so 💎 Diamond (gated on verified installs by the sybil-hardening work) becomes honestly reachable. Surfaces the EXISTING device-flow bind as a one-time console "Verify identity" control.

## Goal

Let a console user **bind their local producer identity to their GitHub account** in one click from Settings. Once bound, the `verifiedInstalls` aggregate (a query-time JOIN of `gem_adoptions.producer_pubkey → account_bindings.pubkey`) counts **all** that pubkey's adoptions — past and future — as verified. No emit change, no event-schema change, no self-reported account.

## Decisions (settled with the user)

- **Settings "Verify identity" control** (one-time, opt-in, out of the install path). Not an install-time nudge.
- **Reuse the existing device flow + `/api/aggregator/bind`** — the `agentgem bind` CLI already does this end-to-end; we surface the same flow in the console UI and share the core logic.
- **Binding creates a real `account_bindings` row via `recordBinding` + `GitHubVerifier`** (OAuth-proven). We do NOT put a self-reported `account` on the adoption event — that would reopen the sybil vector the hardening just closed. Verification stays server-side; the pubkey→account JOIN is retroactive.
- **Console-only** — the identity (`~/.agentgem/identity.json`) and installs (`registryInstall`) are local; the hosted marketplace has neither the keypair nor a way to materialize, so it can't bind or install.

## Context (ground-truth verified)

- **Device flow** (`src/bind/deviceFlow.ts`): `requestDeviceCode(clientId, fetch?) → { deviceCode, userCode, verificationUri, interval }` (GitHub `/login/device/code`, scope `read:user`); `pollForToken(clientId, deviceCode, { intervalSec, maxAttempts, sleep?, fetchImpl? }) → access_token` (polls `/login/oauth/access_token`, handles `authorization_pending`/`slow_down`).
- **The bind post** (`src/bind/cli.ts` `main`): `id = loadOrCreateIdentity()`; `signature = id.sign(bindSigningPayload(id.publicKey, token, signedAt))`; POST `{ pubkey, token, signedAt, signature }` to `<AGENTGEM_AGGREGATOR_URL>/api/aggregator/bind`; on `{bound:true}` writes `~/.agentgem/binding.json` `{ provider, login, accountId, boundAt }`. Env: `AGENTGEM_GITHUB_CLIENT_ID` + `AGENTGEM_AGGREGATOR_URL`.
- **Server bind** (`src/aggregator.controller.ts:136` `POST /api/aggregator/bind` → `recordBinding(db, body, new GitHubVerifier())`): verifies the ed25519 signature over `bindSigningPayload(pubkey, token, signedAt)` (`tokenHash = sha256(token)`, raw token never signed/logged), a 300s freshness window, producer-exists, and `GitHubVerifier.verify(token)` (GitHub `/user`); upserts `account_bindings(pubkey → provider:accountId:login)`.
- **The verified count** (`packages/aggregator/src/aggregates.ts` `gemAdoption`, from the sybil work): `verifiedInstalls = count(distinct account_bindings.provider||':'||account_id)` via `left join account_bindings b on b.pubkey = g.producer_pubkey` — so binding a pubkey retroactively verifies every adoption it ever posted. **No change needed here.**
- **Console** (`packages/console`): `panels/Settings/index.tsx` renders `<section className="ledger-group">` blocks and calls the local server via `api/routes.ts` (`@agentback/client` `defineRoute(...).call(makeClient(apiBase), {body})`). `originGuard` allows the same-origin loopback SPA. `defineConsolePage` registers panels.
- **`registryInstall`** (`src/gem.controller.ts`) already opt-in-emits adoptions signed by `loadOrCreateIdentity()` — the SAME pubkey binding verifies. **No change needed here.**

## Components (files)

### Shared bind core (backend)
- **`src/bind/bindCore.ts`** (new) — extract the reusable pieces from `cli.ts` so the CLI and the console endpoints share ONE implementation (DRY):
  - `bindConfig(): { clientId?: string; base?: string }` (reads the two env vars).
  - `startDeviceBind(cfg, deps?) → { userCode; verificationUri; deviceCode; interval }` (wraps `requestDeviceCode`).
  - `completeDeviceBind(cfg, { deviceCode, interval }, deps?) → { bound: true; provider; login; accountId } | { bound: false; rejected: string }` — `pollForToken` → sign `bindSigningPayload` with `loadOrCreateIdentity()` → POST `<base>/api/aggregator/bind` → on success write `~/.agentgem/binding.json`. `deps` (fetch/identity/sleep) injectable for tests.
  - `readBindingStatus(): { bound: boolean; login?: string; provider?: string }` — read `~/.agentgem/binding.json` (absent/unparseable → `{ bound: false }`).
- **`src/bind/cli.ts`** — refactor `main` to call `startDeviceBind`/`completeDeviceBind` (unchanged behavior; the CLI keeps printing the code + polling).

### Console bind endpoints (backend, local console API)
- **`src/gem.controller.ts`** (or a small `bind.controller.ts`) — three routes behind `originGuard` (same-origin loopback), each returning a clear "not configured" when `bindConfig()` lacks the env:
  - `@post("/bind/start") → startDeviceBind(...)` → `{ userCode, verificationUri, deviceCode, interval }` (or `{ configured: false }`).
  - `@post("/bind/complete", { body: { deviceCode, interval } }) → completeDeviceBind(...)` → `{ bound, login? , rejected? }`.
  - `@get("/bind/status") → readBindingStatus()` → `{ bound, login? }`.
  (Stateless: the short-lived device code round-trips through the client — acceptable for a single-user loopback server.)

### Console Settings UI
- **`packages/console/src/api/routes.ts`** — add `bindStartRoute`/`bindCompleteRoute`/`bindStatusRoute` (`defineRoute` mirroring the server response schemas).
- **`packages/console/src/panels/Settings/index.tsx`** — a new `<section className="ledger-group">` "Verify identity":
  - On mount, `bindStatusRoute` → show **"Verified as @login"** (bound) or **"Not verified — installs won't count toward verified ratings"** (unbound), or **"Verification unavailable (not configured)"** when the server reports not-configured.
  - A **"Connect GitHub"** button → `bindStartRoute` → show the `userCode` + a link to `verificationUri` ("open GitHub, enter this code") → call `bindCompleteRoute({ deviceCode, interval })` (which blocks until the user authorizes or it times out) → on `{bound}` flip to "Verified as @login"; on reject show the reason.
  - Copy explains the point: "Verify your GitHub identity so your gem installs count toward each gem's verified rating (and unlock 💎 Diamond)."

## Testing

- **`bindCore`** (`src/bind/__tests__/bindCore.test.ts`): `startDeviceBind` returns the device code (stub `requestDeviceCode`/fetch); `completeDeviceBind` signs `bindSigningPayload` + posts to `/api/aggregator/bind` + writes `binding.json` on `{bound:true}` (stub `pollForToken`→token, a fake identity, a fake fetch capturing the POST body → assert `pubkey`/`signedAt`/`signature` present and `token` matches); a `{bound:false}` server response → no `binding.json` write + returns the rejection; `readBindingStatus` reads the file (use a hermetic home / temp dir). `bindConfig` missing env → `{}`.
- **Console endpoints** (`src/gem/__tests__/bindEndpoints.test.ts` or extend a controller test): `/bind/start` with config → returns the code; without config → `{ configured: false }`; `/bind/complete` threads to `completeDeviceBind` (inject a stub); `/bind/status` returns the status. (Construct the controller like other GemController tests; inject `bindCore` deps or stub the env.)
- **Console UI** (`packages/console/src/panels/Settings/Settings.test.tsx`, extend): unbound status renders "Not verified"; clicking "Connect GitHub" (stub `bindStartRoute`→code, `bindCompleteRoute`→`{bound, login}`) shows the code then flips to "Verified as @login"; not-configured renders the unavailable copy.
- Gates: server `pnpm exec tsc -b` + full `pnpm test` (build console first); `pnpm --filter @agentgem/console test|typecheck` (+ the console build the CI runs).

## Out of scope (deferred / noted)

- **Install-time nudge** — deferred (user chose Settings-only); the Settings control is the home a nudge would deep-link to later.
- **Unbind / re-bind UI** — `recordBinding` already upserts (rebind replaces); a dedicated unbind is future.
- **A loopback browser OAuth** (vs device flow) — device flow reuses the existing code and needs no callback URL; not revisiting.
- **Marketplace-side binding** — impossible (no local identity); out of scope by construction.
- **The `shareAdoption` opt-in toggle UI** — #D shipped its endpoints; if the Settings panel lacks the toggle, that's a separate small follow-up (this spec adds the Verify-identity section beside where it would live).

## Risks

- **Long-held `/bind/complete` request** — `pollForToken` blocks until authorize/timeout (bounded by `maxAttempts`). Fine on a loopback single-user server (no proxy); set a sane `maxAttempts` so it can't hang indefinitely, and surface a "timed out — try again" on reject.
- **Not configured in most local installs** — `AGENTGEM_GITHUB_CLIENT_ID`/`AGENTGEM_AGGREGATOR_URL` are often unset locally; the UI must degrade to "Verification unavailable (not configured)" (never error), so the panel is safe everywhere. Verified adoption only accrues where the hosted aggregator + a device-flow OAuth app are configured — accepted (this is the on-ramp, wired where deployed).
- **Device code exposure** — returning the short-lived device code to the same-origin loopback SPA is acceptable (single-user, the user's own code, `originGuard`-protected); it is NOT the access token (that stays server-side in `/bind/complete`).
- **Hot files** — `src/gem.controller.ts`, `packages/console/src/panels/Settings/index.tsx`, `routes.ts` are concurrently active; additive diffs, branch off latest `origin/main` (a9ac9f0), integrate promptly.
