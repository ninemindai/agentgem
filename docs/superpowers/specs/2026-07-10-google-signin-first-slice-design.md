# Google Sign-In: First Slice of Multi-Provider Auth

**Status:** approved, not yet planned
**Depends on:** #255 (better-auth 1a), #256 (1b cutover), #285 (identity re-key) — all merged and deployed
**Blocks:** nothing. Enables the later slices (account linking, Slack/X, passkey).

## Goal

A user can sign in to app.agentgem.ai with Google and land authenticated, the same way
GitHub works today. Google accounts are **separate** from GitHub accounts (no linking in
this slice). A Google user has no GitHub-style username, so they get a handle **lazily** —
they are prompted to claim one only when they first try to publish or open their own
profile.

## Why this is more than a config add

Three facts about the deployed code (verified) make "add Google" touch the SPA's identity
model, not just the auth config:

1. **The re-key already made non-GitHub accounts safe.** `anchorAndScopes`
   (`packages/aggregator/src/auth/betterAuth.ts`) writes an `accounts` anchor with a NULL
   `login` for any provider that is not GitHub, and authorization keys on `accounts.id`
   (a uuid), never the login string. So a Google account is a first-class, uuid-keyed
   identity the moment it signs in — no foreign-key violations, no `"" === ""` hole. This
   is what unblocked the whole slice.

2. **The session does not expose `handle`.** `makeAuth`'s
   `user.additionalFields` surfaces only `login`. The re-key made `handle` a column on
   `"user"`, but it never reaches the client. The lazy-claim gate needs the client to tell
   "has a handle" from "doesn't".

3. **The SPA treats "no login" as "not signed in."** `packages/marketplace/src/auth.ts`'s
   `getMe()` does `return login ? {...} : null`, and `Me` is `{ login, avatarUrl, orgs }`.
   The account chip renders `/@${me.login}` and shows `me.login`. A Google user has
   `login: null`, so today the SPA would show "Sign in with GitHub" *even after a
   successful Google sign-in*, and any code reading `me.login` would break. The SPA's
   identity model assumes `login` always exists; Google breaks that assumption.

## Decisions

### Separate accounts (linking deferred)

GitHub and Google for the same human are two accounts in this slice. The re-key made this
**safe** (each is a uuid-keyed identity with its own handle; no cross-account hole). The
cost is cosmetic and rare early: a person who uses both providers has two identities until
a later slice adds `linkSocial`, and merging them then is a data migration (which gems,
which handle wins). Deferring keeps this slice small and avoids the account-linking
security-policy decision (auto-link on email vs explicit link), which deserves its own
spec.

### Lazy handle claim, at first ownership act

A handle is the `/@name` profile URL and the publish scope (`raymond/my-gem`). GitHub users
get one free (the re-key copies the login into a handle). Google supplies name + email but
no username, so a Google user lands with a NULL handle. They can browse, star, and review
(all uuid-keyed) with no handle. They are prompted to claim one only when they try to
**publish** or open **their own profile** — the first acts that actually need a public name.
This matches the re-key's own stated design ("claim at first ownership act") and is the
lowest-friction first impression.

The claim endpoint already exists: `POST /api/handle`
(`src/handles/install.ts`), enforcing charset and the reserved-org-name guard, returning
200 / 400 (charset) / 409 (taken or reserved). No handle-claim **UI** exists yet — GitHub
users never needed one — so this slice builds the form.

## Components

### Backend (aggregator)

- **`makeAuth`** (`packages/aggregator/src/auth/betterAuth.ts`) gains optional
  `googleClientId?` / `googleClientSecret?`. When both are present, add
  `socialProviders.google` with scopes `["openid", "email", "profile"]` and a
  `mapProfileToUser` that maps **name + image only** — no `login`. Google is built into the
  already-installed `better-auth/social-providers`; **no new dependency**.

- **Expose `handle` in the session.** Add `handle: { type: "string", required: false }` to
  `user.additionalFields`. `handle` is a real column on `"user"`, so better-auth surfaces
  it in the get-session user object with no query change. *(Integration point to prove with
  a test first — see Testing.)*

- **`src/index.ts`** reads `AGENTGEM_GOOGLE_CLIENT_ID` / `AGENTGEM_GOOGLE_CLIENT_SECRET`
  and passes them into `makeAuth` next to the GitHub pair. Google is purely additive:
  GitHub stays the provider whose presence gates auth existence (the existing
  `if (ghClientId && ghSecret && …)` guard is unchanged); Google is added inside
  `socialProviders` only when its own creds are set.

### Marketplace SPA

- **Re-key the identity model off `login`.** `Me` becomes
  `{ id: string; name: string; handle: string | null; avatarUrl: string | null; orgs: MyOrg[] }`.
  `getMe()` returns a user whenever the session has a user id, not only when `login` exists.
  The account chip shows `name`, and renders the `/@${handle}` profile link **only when
  `handle` is non-null** (no more broken `/@` for handle-less users).

- **Parameterize sign-in.** `signIn(provider: "github" | "google", returnTo)` (currently
  hardcodes `provider: "github"`). Add a "Sign in with Google" button beside the GitHub one;
  it is the same `POST /api/auth/sign-in/social` call with `provider: "google"`.

- **Handle-claim form + lazy gate.** A small form: one input →
  `POST /api/handle` → handle 200 (success, refetch `me`) / 400 (charset message) / 409
  (taken/reserved message). It appears when a handle-less signed-in user activates
  **Publish** or opens **their own profile**. After a successful claim, refetch `me` so the
  chip's `/@handle` link appears.

## Data flow

```
Google sign-in (SPA)
  "Sign in with Google" ──▶ POST /api/auth/sign-in/social {provider:"google", callbackURL}
        │                          │
        │                          ▼  {url, redirect:true}
        └──▶ location = url ──▶ accounts.google.com ──▶ consent
                                       │
                                       ▼
        api.agentgem.ai/api/auth/callback/google
                │  better-auth: exchange code, upsert "user"(login=NULL) + "account"(google)
                │  databaseHooks.account.create.after → anchorAndScopes
                │     writes accounts anchor (login=NULL); provider!=github ⇒ NO handle auto-claim
                ▼  Set-Cookie (cross-subdomain) ──▶ back to app.agentgem.ai
GET /api/auth/get-session ──▶ { user:{ id, name, handle:null, image }, session, orgs }
  SPA getMe() ──▶ Me{ id, name, handle:null, ... }  (signed in, no handle)
  chip: [avatar] <name>   (no /@ link)
  Publish / own-profile with handle=null ──▶ claim form ──▶ POST /api/handle ──▶ refetch me
```

## Testing

- **`makeAuth`:** `socialProviders.google` present iff both Google creds supplied; absent
  otherwise. GitHub unaffected.
- **Session exposes handle (prove first):** a get-session for a user with a claimed handle
  returns `handle`; NULL before a claim. This is the load-bearing integration point — the
  plan's first task proves it before the SPA is touched.
- **`anchorAndScopes` for Google:** a `google` `account.create` anchors an `accounts` row
  with `login = NULL` and **no** handle auto-claimed (extends the re-key's existing
  fake-provider test to the concrete Google shape). A subsequent star insert succeeds
  (uuid FK satisfied).
- **SPA `getMe`:** returns a `Me` for a login-less session (id present, login null); returns
  null only when there is no session.
- **SPA chip:** renders `name` and NO `/@` link when `handle` is null; renders the `/@handle`
  link when set.
- **SPA `signIn`:** `signIn("google", returnTo)` POSTs `{provider:"google", callbackURL:returnTo}`.
- **SPA claim form:** posts to `/api/handle`; renders the right message on 200 / 400 / 409;
  refetches `me` on success.

## Manual deploy prerequisite

Like the GitHub callback-URL change, one manual step gates the deploy:

1. Register a Google OAuth 2.0 Client (Google Cloud Console → Credentials).
2. Authorized redirect URI: `https://api.agentgem.ai/api/auth/callback/google`.
3. Authorized JavaScript origin: `https://app.agentgem.ai`.
4. Set `AGENTGEM_GOOGLE_CLIENT_ID` / `AGENTGEM_GOOGLE_CLIENT_SECRET` on Fly (the api host).

Until the env vars are set, `socialProviders.google` is simply not registered and the Google
button 404s at `sign-in/social` — a clean degrade, not a crash. The button should be
hidden/disabled when Google is unconfigured (the SPA can key off a small `providers` field
on a public config response, or simply attempt and surface the failure — decided at plan
time).

## Non-goals

- **Account linking (`linkSocial`).** GitHub+Google for one person stays two accounts.
  Its own slice, with its own security-policy decision.
- **Slack, X.** Later provider slices; each may carry PKCE quirks to verify.
- **Passkey.** A different problem (a faster re-login for an existing account, not a new
  front door). better-auth 1.6.23 as installed ships no passkey plugin — adding it means new
  dependencies + a credentials table + a WebAuthn ceremony. A clean second slice once there
  is an account model worth attaching a passkey to.
- **Merging a person's two accounts.** Falls out of linking; deferred with it.
