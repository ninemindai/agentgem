# Transfer ephemeral-token auth (mint primitive) — design

**Date:** 2026-06-27
**Status:** Approved design, pending implementation plan
**Branch (impl):** `feat/transfer-ephemeral-auth` (worktree off `main`)

## Summary

Add an **ephemeral, subject-scoped NATS credential mint** so an *untrusted* client can
connect to the transfer broker with least-privilege, short-lived access — without
ever holding the master credential. The driver is the future **browser web-receiver**
(a separate follow-up): a browser fetching ciphertext over NATS-WebSocket and
decrypting client-side cannot embed a long-lived broker token in JS.

This deliverable is the **server-side primitive only**: a `mintScopedCreds()`
function (a NATS user JWT signed by AgentGem's account key, scoped + short-TTL) and
a `POST /api/transfer/token` endpoint that returns `{ creds, wsUrl, expiresAt }`.
The browser that consumes it — WebSocket connection, client-side decrypt, UI,
bundling — is **out of scope here** and is the next follow-up.

## Motivation

- Today the transfer flow authenticates with a static `NATS_TOKEN` used by the
  AgentGem process itself (server-side MCP/REST/CLI). That is fine while the only
  party connecting is the trusted server.
- The browser web-receiver introduces an **untrusted connecting party**. It needs a
  credential that (a) can't be the master token, (b) is scoped to the transfer
  bucket, and (c) expires in seconds. NATS decentralized **JWT** auth provides
  exactly this: an account key signs short-lived, permission-scoped user JWTs.
- Building the mint primitive first (this spec) gives the web-receiver a tested
  foundation to consume.

## Decisions (locked during brainstorming)

1. **Driver = browser web-receiver.** The mint exists to let an untrusted browser
   connect; had the driver been "harden the trusted server," this would be
   near-pointless.
2. **Decompose:** mint primitive now (server-side, tested); browser page next.
3. **NATS JWT/account mode**, signed by an account seed in env. Separate, additive
   config path from the existing static-token path.
4. **Scope = bucket-level + short TTL** (default 60s), `scope: "receive"`.
   **Per-object scoping is deferred** — JetStream object-get traverses broad
   `$JS.API.*` subjects that can't be practically narrowed to one object.
5. **Server-side only**: `mintScopedCreds` + `/api/transfer/token`. No MCP tool
   (only the browser needs it). No browser code this round.
6. **Mint logic is unit-tested; scoping-actually-works is gated** behind an
   integration test against a JWT-configured broker (CI stays green without one).

## Architecture

| Unit | File | Responsibility | Depends on |
|---|---|---|---|
| `mint` | `src/transfer/mint.ts` | `mintScopedCreds(opts) → { creds, expiresAt }` — build + account-sign a scoped, short-TTL NATS user JWT; emit `.creds` text | `@nats-io/nkeys`, `@nats-io/jwt` |
| config | `src/transfer/service.ts` | `mintCredsFromEnv(scope) → { creds, wsUrl, expiresAt }` — read `NATS_ACCOUNT_SEED` + `NATS_WS_URL`; `InvalidInputError` (400) if unset | `mint`, `inputError` |
| REST | `src/gem.controller.ts` | `POST /api/transfer/token` → `{ creds, wsUrl, expiresAt }` | schemas, `service` |
| schemas | `src/schemas.ts` | `TransferTokenRequestSchema` (`{ scope?: "receive" }`), `TransferTokenResponseSchema` (`{ creds, wsUrl, expiresAt }`) | — |

### `mintScopedCreds`

```ts
export type TransferScope = "receive";
export interface MintOpts {
  accountSeed: string;   // account signing nkey seed (env NATS_ACCOUNT_SEED)
  bucket: string;        // transfer bucket; default "agentgem-transfer"
  scope: TransferScope;
  ttlSeconds?: number;   // default 60
  issuedAt?: number;     // unix seconds; injectable for deterministic tests (default: now)
}
export interface MintedCreds { creds: string; expiresAt: number } // expiresAt = unix seconds
```

- Generates a fresh **user nkey**.
- Builds a user JWT: issuer = account public key, subject = user public key,
  `iat = issuedAt`, `exp = issuedAt + ttlSeconds`, and **permissions** scoping
  `sub`/`pub` to `$O.<bucket>.>` plus the minimal `$JS.API.*` subjects required for
  object get-and-burn under `scope: "receive"`.
- Signs the JWT with the account seed.
- Returns the standard NATS **`.creds`** text (JWT + user seed) and `expiresAt`.

### Data flow

```
browser (#3)  --POST /api/transfer/token {scope:"receive"}-->  AgentGem
AgentGem: mintCredsFromEnv -> mintScopedCreds(accountSeed, bucket, "receive", 60s)
          <-- { creds, wsUrl, expiresAt } --
browser (#3)  --connect NATS/WS with creds-->  broker  (get + burn on the bucket only; expires in 60s)
```

## Configuration

- `NATS_ACCOUNT_SEED` — account signing nkey seed; **required** for the mint.
- `NATS_WS_URL` — the broker's WebSocket URL handed to the client; **required**.
- If either is unset, `/api/transfer/token` returns `InvalidInputError` (400):
  "ephemeral tokens are not configured — set NATS_ACCOUNT_SEED and NATS_WS_URL".
- Independent of the existing `NATS_URL`/`NATS_TOKEN` (server-side) path.

## Error handling

- Missing config → 400 with the actionable message (surfaced via `InvalidInputError`,
  matching the rest of transfer).
- A malformed `NATS_ACCOUNT_SEED` (not a valid account nkey) → fail fast with a
  clear error (not a masked 500 where avoidable).

## Testing

- **Unit** (`src/transfer/__tests__/mint.test.ts`, hermetic):
  - minted `.creds` text parses into a JWT + a valid user seed;
  - the JWT is signed by / issued from the configured account key;
  - `exp === issuedAt + ttlSeconds` (inject `issuedAt`); a tiny ttl yields an
    already-expired token relative to a later `issuedAt`;
  - the permission subjects include exactly the scoped set for `"receive"`
    (`$O.<bucket>.>` + the named `$JS.API.*` subjects) and nothing broader.
- **Controller** (hermetic): `POST /api/transfer/token` returns 400 when
  `NATS_ACCOUNT_SEED`/`NATS_WS_URL` are unset; returns `{ creds, wsUrl, expiresAt }`
  shaped correctly when a test account seed + ws url are set.
- **Gated integration** (`NATS_JWT_TEST` env → real JWT-configured broker, else
  `describe.skip`): connect with minted creds; a get on `$O.<bucket>` succeeds; a
  publish to an off-scope subject is denied.

## Alternatives considered

- **Static shared token to the browser** — rejected: a long-lived broker credential
  in client JS is extractable and unscoped.
- **NATS auth callout** (server authorizes each connection live) — heavier moving
  part (an always-on callout service); JWT minting is simpler and stateless.
- **Server-proxied receive (no client-side decrypt)** — simplest, but the server
  would see the key + plaintext, abandoning the zero-knowledge-from-server property;
  rejected per the chosen driver.

## Out of scope (named)

- The browser web-receiver page, NATS-over-WebSocket client, client-side decrypt,
  and UI bundling — the next follow-up (#3), which consumes this endpoint.
- A `send` scope (browser sender) and **per-object** scoping.
- The **NATS-server JWT/WebSocket ops setup** itself (operator/account/resolver +
  `websocket {}` block) — a deployment prerequisite, documented but not code here.

## Open questions (resolve at planning time)

1. Exact `@nats-io/jwt@0.0.10-x` claims API (it is very early) — verify the
   encode/sign surface against the installed types; adjust if the shape differs.
2. The precise `$JS.API.*` subject set required for an Object Store get-and-burn
   under a scoped user — confirm against the gated broker; widen minimally if a get
   is denied.
3. Default TTL (60s) — confirm it's enough for a browser fetch round-trip.
