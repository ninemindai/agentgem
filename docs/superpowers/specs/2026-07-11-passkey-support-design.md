# Passkey support — design

**Date:** 2026-07-11
**Status:** Approved (design), pending implementation plan
**Scope:** Add passkey (WebAuthn) passwordless sign-in for returning users to the
marketplace SPA, on top of the existing social-only better-auth stack.

## Goal

Today authentication is social-only: GitHub + Google via better-auth on the
aggregator (`api.agentgem.ai`), with `emailAndPassword` disabled. Passkeys add a
**passwordless sign-in path for returning users**:

1. A user signs in once with GitHub or Google.
2. In Account settings they register a passkey (Face ID / Touch ID / security key).
3. On later visits they sign in directly with the passkey — no OAuth round trip.

This is better-auth's native passkey model. A passkey cannot be a *first-time*
registration on its own here (there is no account to attach it to until a social
sign-in creates one), and we are **not** building a passkey-first onboarding flow.

Out of scope: step-up / re-auth as a second factor; a native passkey prompt inside
the Electron console (the console delegates interactive sign-in to the marketplace
web app via the existing signed session handoff, so a web-registered passkey
carries over automatically); browser conditional-UI autofill.

## Key constraint: WebAuthn RP ID across subdomains

The passkey plugin defaults `rpID` to the hostname of `baseURL`, which is
`api.agentgem.ai`. But the WebAuthn ceremony runs in the browser on
`app.agentgem.ai`, and a credential's RP ID must be a **registrable suffix of the
page origin's domain**. `api.agentgem.ai` is not a suffix of `app.agentgem.ai`, so
the default would make every passkey created on the web app fail verification.

Fix: set

- `rpID = agentgem.ai` (the registrable parent — a suffix of both `app.` and `api.`),
  mirroring the existing `crossSubDomainCookies` domain, and
- `origin = webOrigins` (the allowed page origins, e.g. `https://app.agentgem.ai`).

In local dev the page origin is `http://localhost:<port>`, so `rpID` must be
`localhost` and `origin` the localhost origin.

## Approach

Server: register `@better-auth/passkey` (a separate package — **not** bundled in the
installed better-auth 1.6.23; `@simplewebauthn` is also absent, so both are genuine
new dependencies) in `makeAuth`. The existing `/api/auth/*splat` catch-all in
`src/auth/mount.ts` forwards every request to `auth.handler`, so the new
`/api/auth/passkey/*` endpoints route for free — **no new server routes**.

Client: **Approach A** — use better-auth's official client plugin
(`createAuthClient` + `passkeyClient()` from `@better-auth/passkey/client`), scoped
to *only* the passkey flows. The existing `fetch`-based `packages/marketplace/src/auth.ts`
stays unchanged for social sign-in and session reads. Rationale: the ceremony
(base64url ↔ ArrayBuffer, `navigator.credentials.create/get`) is fiddly and
error-prone to hand-roll; the official plugin does it correctly. Cost: one new
external client dependency in the marketplace SPA (which currently hand-rolls all
auth via `fetch`). Rejected alternative B (hand-roll with `@simplewebauthn/browser`):
more code and more encoding-bug surface for no real benefit.

## Components

### 1. Server — `packages/aggregator`

- **Dependency:** add `@better-auth/passkey`.
- **`src/auth/betterAuth.ts` (`makeAuth`):** add three optional opts —
  `passkeyRpId?: string`, `passkeyOrigins?: string[]` (default `webOrigins`),
  `rpName?: string` (default `"AgentGem"`) — and add
  `passkey({ rpID: passkeyRpId, rpName, origin: passkeyOrigins })` to the `plugins`
  array. `requireSession` stays at its default (`true`): registration always
  attaches to the caller's current session, matching the "sign in socially first"
  model. Keep the existing `BetterAuthOptions` widening so the added plugin's types
  don't re-trip the `.d.ts` nameability issue documented in that file.
- **`src/schema.ts`:**
  - Add a `passkey` `pgTable` whose **JS property names exactly match** better-auth's
    passkey model field names (`id`, `name`, `publicKey`, `userId`, `credentialID`,
    `counter`, `deviceType`, `backedUp`, `transports`, `aaguid`, `createdAt`) so the
    drizzle adapter resolves the model; column names are snake_case per house style
    (`public_key`, `user_id`, `credential_id`, `device_type`, `backed_up`, ...).
    `userId` is a text FK → `user.id` `on delete cascade` (a deleted user's passkeys
    go with them). The exact field set must be verified against the installed
    `@better-auth/passkey` schema at implementation time.
  - Add `passkey` to the exported `schema` object.
  - In `ensureSchema`, add an idempotent
    `create table if not exists "passkey" (...)` with matching columns, alongside the
    existing hand-written `"session"` / `"account"` / `"verification"` DDL. Follow the
    `ensureSchema` column-drift rule: any later-added column needs a paired
    `alter table ... add column if not exists`.

### 2. Server wiring — `src/index.ts`

Thread env into the `makeAuth({...})` call (inside the existing
`if (ghClientId && ghSecret && webOrigins.length > 0 && aggDb)` block):

- `passkeyRpId: process.env.AGENTGEM_PASSKEY_RP_ID ?? deriveRpId(cookieDomain, webOrigins)`
  where `deriveRpId` strips a leading dot from `AGENTGEM_SESSION_COOKIE_DOMAIN`
  when set, else falls back to `localhost` (dev). A dedicated
  `AGENTGEM_PASSKEY_RP_ID` var is the explicit source of truth; the cookie-domain
  default means production (`agentgem.ai`) needs no new required config.
- `passkeyOrigins: webOrigins`, `rpName: "AgentGem"`.

### 3. Sign-in UI — marketplace SPA

Replace the flat row of provider buttons with **one "Sign in" button that opens the
existing `Modal` (`packages/marketplace/src/Modal.tsx`)** listing the options:
GitHub, Google, and "Use a passkey". This scales as providers grow and lets passkey
read as a peer option rather than competing visually with the OAuth buttons.

- New thin passkey client module (e.g. `passkeyClient.ts`) exporting a memoized
  `createAuthClient({ baseURL, plugins: [passkeyClient()] })` pointed at the same
  API base as `auth.ts`, with `fetchOptions: { credentials: "include" }` so the
  cross-subdomain cookie travels.
- "Use a passkey" → `authClient.signIn.passkey()` (discoverable-credential /
  resident-key flow — no email/identifier prompt). On success, re-run the existing
  session fetch (`getMe`) so the app updates to the signed-in state, same as the
  post-OAuth redirect path does.
- Hide the "Use a passkey" option when `window.PublicKeyCredential` is `undefined`
  (unsupported browser).

### 4. Passkey management — `packages/marketplace/src/pages/Account.tsx`

A "Passkeys" section (visible only when signed in — this is the bootstrap point):

- List registered passkeys (name + created date) via `authClient.passkey.listUserPasskeys()`.
- "Add a passkey" → prompt for a name → `authClient.passkey.addPasskey({ name })`
  (uses the current session). Refresh the list on success.
- Per-row delete → `authClient.passkey.deletePasskey({ id })` → refresh.

### 5. Error handling

WebAuthn ceremonies fail routinely — the user dismisses the OS prompt
(`NotAllowedError`), there is no authenticator, or the browser is unsupported. Every
flow (`signIn.passkey`, `addPasskey`, `deletePasskey`) catches its rejection and
surfaces a readable inline message rather than a silent no-op. No fallback that
masks the failure; the user is told what happened.

## Data flow

**Registration (bootstrap):** signed-in user clicks Add → `addPasskey` →
`generatePasskeyRegistrationOptions` (server, session-scoped) → browser
`navigator.credentials.create` → `verifyPasskeyRegistration` (server) inserts a
`passkey` row for `session.userId`.

**Sign-in:** returning user clicks "Use a passkey" → `signIn.passkey` →
`generatePasskeyAuthenticationOptions` (server) → browser
`navigator.credentials.get` → `verifyPasskeyAuthentication` (server) matches the
credential to its `passkey` row, resolves the owning user, and issues a normal
better-auth session cookie (same cookie the social path issues, so all existing
session consumers, `orgs` enrichment, and the console handoff work unchanged).

## Testing

- **Server:** unit-test that `makeAuth` registers a plugin with `id: "passkey"`
  (and endpoints), and that `ensureSchema` creates the `passkey` table — matching the
  style of the existing schema / auth tests. Verify `deriveRpId` (dotted cookie
  domain → bare domain; unset → `localhost`).
- **Client:** the ceremony can't execute in jsdom, so mock `authClient.passkey.*`
  and `authClient.signIn.passkey`. Assert: the "Use a passkey" option is hidden when
  `PublicKeyCredential` is absent; a rejected ceremony surfaces an error and does not
  change auth state; a resolved `signIn.passkey` triggers the session refetch; the
  Account section lists / adds / deletes via the mocked client.

## Rollout / config summary

New env (all optional; sensible defaults):

- `AGENTGEM_PASSKEY_RP_ID` — WebAuthn RP ID. Default: `AGENTGEM_SESSION_COOKIE_DOMAIN`
  with any leading dot stripped, else `localhost`.

No schema migration tooling beyond the existing idempotent `ensureSchema` (runs at
boot). No changes to the social sign-in or session-handoff paths.
