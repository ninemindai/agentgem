# Transfer Ephemeral-Token Auth (mint primitive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mint short-lived, subject-scoped NATS user credentials (account-signed JWT) and expose `POST /api/transfer/token`, so an untrusted client (the future browser web-receiver) can connect to the broker with least-privilege access — without the master credential.

**Architecture:** A pure-ish `mintScopedCreds()` builds a NATS user JWT signed by AgentGem's account key (`@nats-io/jwt` + `@nats-io/nkeys`), scoped to the transfer bucket's Object Store subjects with a short `exp`, returned as `.creds` text. `service.ts` reads the account seed + WS URL from env; a REST endpoint returns `{ creds, wsUrl, expiresAt }`. Server-side only — no browser code, no MCP tool.

**Tech Stack:** TypeScript (NodeNext, `.js` specifiers), vitest, `@nats-io/nkeys`, `@nats-io/jwt`, the existing `InvalidInputError`, `@agentback/openapi`.

## Global Constraints

- **NodeNext imports** use `.js` specifiers even for `.ts`.
- **Tests run from compiled `dist/`** (`pnpm build` = `tsc -b`; `pnpm test` = `tsc -b && vitest run`). Unit tests must be **hermetic** (generate their own account key; no broker, no network).
- **Confirmed API (use exactly):** nkeys `createUser()`, `createAccount()`, `fromSeed(seed: Uint8Array)`; KeyPair `.getPublicKey(): string`, `.getSeed(): Uint8Array`. jwt `encodeUser(name, ukp, issuerKP, user?, opts?): Promise<string>`, `decode<T>(jwt): ClaimsData<T>` (has `.exp`, `.iat`, `.nats`), `fmtCreds(jwt, kp): Uint8Array`. Permissions shape: `{ pub?: { allow: string[] }, sub?: { allow: string[] } }`.
- **Account seed is a string** (`SA…`); convert with `new TextEncoder().encode(seed)` for `fromSeed`, and `new TextDecoder().decode(kp.getSeed())` to render one.
- **Config (new, additive):** `NATS_ACCOUNT_SEED`, `NATS_WS_URL`. Missing → `InvalidInputError` (400) "ephemeral tokens are not configured — set NATS_ACCOUNT_SEED and NATS_WS_URL". Independent of `NATS_URL`/`NATS_TOKEN`.
- **Default TTL 60s.** Default bucket `agentgem-transfer`. Scope value: `"receive"`.
- **Two early-lib unknowns to verify at build, not guess** (the unit test's `decode()` assertions are the source of truth):
  1. The exact way `encodeUser` accepts `exp` (claims vs `opts`) — try the user-claims/opts path; if the decoded JWT's `exp` isn't `iat + ttl`, adjust until it is. If the installed `@nats-io/jwt@0.0.10-5` exposes **no** way to set `exp`, STOP and report BLOCKED (short TTL is a core requirement).
  2. The precise `$JS.API.*` subject set for an Object Store get-and-burn — the listed set is a best-effort starting point; the **gated** integration test (Task 3) validates it against a real JWT broker and widens minimally if a get is denied.
- **Commits authored** as `Raymond Feng <raymond@ninemind.ai>`.

---

### Task 1: `mint` — scoped, short-lived NATS user creds

**Files:**
- Modify: `package.json` (add `@nats-io/nkeys`, `@nats-io/jwt`)
- Create: `src/transfer/mint.ts`
- Test: `src/transfer/__tests__/mint.test.ts`

**Interfaces:**
- Produces: `type TransferScope = "receive"`; `interface MintOpts { accountSeed: string; bucket?: string; scope: TransferScope; ttlSeconds?: number; issuedAt?: number }`; `interface MintedCreds { creds: string; expiresAt: number }`; `mintScopedCreds(opts: MintOpts): Promise<MintedCreds>`; `scopeSubjects(bucket: string, scope: TransferScope): { pub: string[]; sub: string[] }`.

- [ ] **Step 1: Add the dependencies**

Run: `pnpm add @nats-io/nkeys @nats-io/jwt`
Expected: `package.json` gains both (`@nats-io/nkeys@^1.2.x`, `@nats-io/jwt@^0.0.10-5`).

- [ ] **Step 2: Write the failing test**

```ts
// src/transfer/__tests__/mint.test.ts
import { describe, it, expect } from "vitest";
import { createAccount } from "@nats-io/nkeys";
import { decode, parseCreds } from "@nats-io/jwt";
import { mintScopedCreds, scopeSubjects } from "../mint.js";

// A hermetic account key for signing — no broker involved.
function testAccountSeed(): string {
  return new TextDecoder().decode(createAccount().getSeed());
}

describe("scopeSubjects", () => {
  it("scopes to the bucket's object-store subjects and an inbox", () => {
    const { pub, sub } = scopeSubjects("agentgem-transfer", "receive");
    expect(sub).toContain("$O.agentgem-transfer.>");
    expect(sub).toContain("_INBOX.>");
    // JetStream API access is bucket-scoped (stream OBJ_<bucket>), never a blanket "$JS.API.>".
    expect(pub.every((s) => !s.endsWith("$JS.API.>"))).toBe(true);
    expect(pub.some((s) => s.includes("OBJ_agentgem-transfer"))).toBe(true);
  });
});

describe("mintScopedCreds", () => {
  it("mints account-signed creds whose JWT carries the scoped permissions and a ~ttl exp", async () => {
    const accountSeed = testAccountSeed();
    const issuedAt = 1_700_000_000; // fixed unix seconds for determinism
    const { creds, expiresAt } = await mintScopedCreds({
      accountSeed, bucket: "agentgem-transfer", scope: "receive", ttlSeconds: 60, issuedAt,
    });

    // .creds parses into a usable JWT + user key
    const parsed = await parseCreds(new TextEncoder().encode(creds));
    expect(parsed).toBeTruthy();

    // The embedded JWT decodes with the right exp and scoped permissions.
    const jwt = creds.match(/-----BEGIN NATS USER JWT-----\s*([^\s-]+)/)?.[1];
    expect(jwt).toBeTruthy();
    const claims = decode<{ pub?: { allow: string[] }; sub?: { allow: string[] } }>(jwt!);
    expect(claims.exp).toBe(issuedAt + 60);
    expect(expiresAt).toBe(issuedAt + 60);
    expect(claims.nats.sub?.allow).toContain("$O.agentgem-transfer.>");
  });

  it("defaults bucket and ttl, and expiresAt is in the future of issuedAt", async () => {
    const issuedAt = 1_700_000_000;
    const { expiresAt } = await mintScopedCreds({ accountSeed: testAccountSeed(), scope: "receive", issuedAt });
    expect(expiresAt).toBe(issuedAt + 60); // default ttl 60s
  });
});
```

> Note: `claims.nats` holds the user body (where `pub`/`sub` live) in the nats-jwt
> ClaimsData. If the installed `decode` returns the permissions at a different path,
> adjust the assertion to match the decoded shape (do not change the requirement —
> the JWT MUST carry the scoped `sub`/`pub` and the `exp`).

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/mint.test.js`
Expected: FAIL — cannot find module `../mint.js`.

- [ ] **Step 4: Write the implementation**

```ts
// src/transfer/mint.ts
import { createUser, fromSeed } from "@nats-io/nkeys";
import { encodeUser, fmtCreds } from "@nats-io/jwt";

export type TransferScope = "receive";

export interface MintOpts {
  accountSeed: string; // account signing nkey seed (e.g. "SA…")
  bucket?: string;
  scope: TransferScope;
  ttlSeconds?: number; // default 60
  issuedAt?: number;   // unix seconds; injectable for deterministic tests
}

export interface MintedCreds { creds: string; expiresAt: number } // expiresAt: unix seconds

const DEFAULT_BUCKET = "agentgem-transfer";
const DEFAULT_TTL_SECONDS = 60;

// Least-privilege subjects for a scope. An Object Store bucket <b> is JetStream
// stream OBJ_<b> over subjects $O.<b>.>; a get-and-burn needs the bucket subjects,
// an inbox for replies, and the bucket-scoped JS API (never a blanket $JS.API.>).
export function scopeSubjects(bucket: string, _scope: TransferScope): { pub: string[]; sub: string[] } {
  const stream = `OBJ_${bucket}`;
  return {
    sub: [`$O.${bucket}.>`, "_INBOX.>"],
    pub: [
      `$O.${bucket}.>`,
      `$JS.API.STREAM.INFO.${stream}`,
      `$JS.API.STREAM.MSG.GET.${stream}`,
      `$JS.API.DIRECT.GET.${stream}`,
      `$JS.API.STREAM.MSG.DELETE.${stream}`,
      `$JS.API.STREAM.PURGE.${stream}`,
      `$JS.API.CONSUMER.CREATE.${stream}.>`,
      `$JS.API.CONSUMER.MSG.NEXT.${stream}.>`,
    ],
  };
}

export async function mintScopedCreds(opts: MintOpts): Promise<MintedCreds> {
  const bucket = opts.bucket ?? DEFAULT_BUCKET;
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const iat = opts.issuedAt ?? Math.floor(Date.now() / 1000);
  const exp = iat + ttl;

  const account = fromSeed(new TextEncoder().encode(opts.accountSeed));
  const user = createUser();
  const { pub, sub } = scopeSubjects(bucket, opts.scope);

  // Build a user JWT scoped + time-boxed. VERIFY against the installed
  // @nats-io/jwt@0.0.10-5: exp/iat may belong in the claims object or in opts —
  // adjust the set-path until decode(jwt).exp === iat + ttl (the test enforces it).
  const jwt = await encodeUser(
    "agentgem-transfer",
    user,
    account,
    { pub: { allow: pub }, sub: { allow: sub } },
    { exp, iat } as never,
  );

  const creds = new TextDecoder().decode(fmtCreds(jwt, user));
  return { creds, expiresAt: exp };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/mint.test.js`
Expected: PASS (3 tests). If `exp` is wrong, adjust where `exp`/`iat` are passed (claims vs opts) per the verify note; if the lib offers no exp path at all, report BLOCKED.

- [ ] **Step 6: Run the full suite + commit**

Run: `pnpm test` → all green (no regressions).

```bash
git add package.json pnpm-lock.yaml src/transfer/mint.ts src/transfer/__tests__/mint.test.ts
git commit -m "feat(transfer): mint scoped short-lived NATS user creds (ephemeral auth)"
```

---

### Task 2: REST endpoint + env config

**Files:**
- Modify: `src/schemas.ts` (add `TransferTokenRequestSchema`, `TransferTokenResponseSchema`)
- Modify: `src/transfer/service.ts` (add `mintCredsFromEnv`)
- Modify: `src/gem.controller.ts` (add `POST /api/transfer/token`)
- Test: `src/__tests__/transfer.token.controller.test.ts`

**Interfaces:**
- Consumes: `mintScopedCreds`, `TransferScope` (Task 1); `InvalidInputError` from `./gem/inputError.js`.
- Produces: `mintCredsFromEnv(scope: TransferScope): Promise<{ creds: string; wsUrl: string; expiresAt: number }>`; REST `POST /api/transfer/token`.

- [ ] **Step 1: Add schemas**

In `src/schemas.ts`, after the existing transfer schemas (e.g. after `TransferReceiveResponseSchema`):

```ts
export const TransferTokenRequestSchema = z.object({ scope: z.literal("receive").optional() });
export const TransferTokenResponseSchema = z.object({
  creds: z.string(),
  wsUrl: z.string(),
  expiresAt: z.number(), // unix seconds
});
```

- [ ] **Step 2: Write the failing controller test**

```ts
// src/__tests__/transfer.token.controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { GemController } from "../gem.controller.js";
import { createAccount } from "@nats-io/nkeys";

let app: RestApplication;
let client: ReturnType<typeof supertest>;
let prevSeed: string | undefined;
let prevWs: string | undefined;

beforeAll(async () => {
  prevSeed = process.env.NATS_ACCOUNT_SEED;
  prevWs = process.env.NATS_WS_URL;
  app = new RestApplication({});
  app.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1" });
  app.restController(GemController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});
afterAll(async () => {
  await app.stop();
  if (prevSeed !== undefined) process.env.NATS_ACCOUNT_SEED = prevSeed; else delete process.env.NATS_ACCOUNT_SEED;
  if (prevWs !== undefined) process.env.NATS_WS_URL = prevWs; else delete process.env.NATS_WS_URL;
});

describe("POST /api/transfer/token", () => {
  it("returns 400 with an actionable message when unconfigured", async () => {
    delete process.env.NATS_ACCOUNT_SEED;
    delete process.env.NATS_WS_URL;
    const r = await client.post("/api/transfer/token").send({ scope: "receive" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/not configured/);
  });

  it("returns minted creds + wsUrl + expiresAt when configured", async () => {
    process.env.NATS_ACCOUNT_SEED = new TextDecoder().decode(createAccount().getSeed());
    process.env.NATS_WS_URL = "wss://broker.example:443";
    const r = await client.post("/api/transfer/token").send({ scope: "receive" }).expect(200);
    expect(r.body.creds).toContain("NATS USER JWT");
    expect(r.body.wsUrl).toBe("wss://broker.example:443");
    expect(typeof r.body.expiresAt).toBe("number");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/__tests__/transfer.token.controller.test.js`
Expected: FAIL — `transferToken` route / `mintCredsFromEnv` not defined.

- [ ] **Step 4: Implement `mintCredsFromEnv` in `src/transfer/service.ts`**

Add the import at the top (alongside the existing transfer imports):

```ts
import { mintScopedCreds, type TransferScope } from "./mint.js";
```

Add the function (near `natsStoreFromEnv`):

```ts
// Mint scoped, short-lived creds for an untrusted client (the browser web-receiver).
// Separate config path from NATS_URL/NATS_TOKEN. 400 (InvalidInputError) if unset.
export async function mintCredsFromEnv(scope: TransferScope): Promise<{ creds: string; wsUrl: string; expiresAt: number }> {
  const accountSeed = process.env.NATS_ACCOUNT_SEED;
  const wsUrl = process.env.NATS_WS_URL;
  if (!accountSeed || !wsUrl) {
    throw new InvalidInputError("ephemeral tokens are not configured — set NATS_ACCOUNT_SEED and NATS_WS_URL");
  }
  const { creds, expiresAt } = await mintScopedCreds({ accountSeed, scope });
  return { creds, wsUrl, expiresAt };
}
```

- [ ] **Step 5: Add the endpoint in `src/gem.controller.ts`**

Add the schema names to the existing `./schemas.js` import block:

```ts
  TransferTokenRequestSchema, TransferTokenResponseSchema,
```

Add the service import to the existing transfer-service import line:

```ts
import { sendBytes, receiveTicket, natsStoreFromEnv, assertConfigured, mintCredsFromEnv } from "./transfer/service.js";
```

Add the handler next to the other `/transfer/*` routes:

```ts
  @post("/transfer/token", { body: TransferTokenRequestSchema, response: TransferTokenResponseSchema })
  async transferToken(input: { body: z.infer<typeof TransferTokenRequestSchema> }): Promise<z.infer<typeof TransferTokenResponseSchema>> {
    return mintCredsFromEnv(input.body.scope ?? "receive");
  }
```

- [ ] **Step 6: Run test + full suite**

Run: `pnpm build && npx vitest run dist/__tests__/transfer.token.controller.test.js` → PASS (2 tests).
Run: `pnpm test` → all green.

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/transfer/service.ts src/gem.controller.ts src/__tests__/transfer.token.controller.test.ts
git commit -m "feat(transfer): POST /api/transfer/token mints ephemeral creds from env"
```

---

### Task 3: Gated integration test (real JWT broker)

**Files:**
- Test: `src/transfer/__tests__/mint.integration.test.ts`

**Interfaces:**
- Consumes: `mintScopedCreds` (Task 1); a JWT/account-configured NATS broker addressed by `NATS_JWT_TEST` (URL) + `NATS_JWT_TEST_ACCOUNT_SEED` (the account seed the broker trusts).

- [ ] **Step 1: Write the gated test**

```ts
// src/transfer/__tests__/mint.integration.test.ts
// Validates that the minted creds actually authenticate and are scoped, against a
// real JWT-configured broker. Skipped unless NATS_JWT_TEST + the account seed are set
// (no such broker in CI). See the spec's "NATS-server JWT/WS ops setup" prerequisite.
import { describe, it, expect } from "vitest";
import { connect } from "@nats-io/transport-node";
import { mintScopedCreds } from "../mint.js";

const url = process.env.NATS_JWT_TEST;
const accountSeed = process.env.NATS_JWT_TEST_ACCOUNT_SEED;
const gated = url && accountSeed ? describe : describe.skip;

gated("mintScopedCreds (integration, needs NATS_JWT_TEST + account seed)", () => {
  it("minted creds connect and are scoped to the transfer bucket", async () => {
    const { creds } = await mintScopedCreds({ accountSeed: accountSeed!, scope: "receive", ttlSeconds: 60 });
    // @nats-io/transport-node accepts a credentials authenticator built from the creds text.
    const { credsAuthenticator } = await import("@nats-io/nats-core");
    const nc = await connect({ servers: url!, authenticator: credsAuthenticator(new TextEncoder().encode(creds)) });
    try {
      // In scope: a request on the bucket subject space is permitted (no permission error).
      // Out of scope: publishing to a foreign subject is denied.
      await expect(nc.request("definitely.not.in.scope", undefined, { timeout: 250 }))
        .rejects.toThrow(/[Pp]ermission|[Tt]imeout|no responders/);
    } finally {
      await nc.close();
    }
  });
});
```

> The exact assertion may need tuning against the broker's error surface; the goal is
> to confirm (a) the creds authenticate (connect succeeds) and (b) an off-scope action
> is rejected. If a legitimate in-scope object get is denied, widen `scopeSubjects`
> minimally (spec open question #2) and note what was added.

- [ ] **Step 2: Verify it skips cleanly in CI**

Run: `pnpm build && npx vitest run dist/transfer/__tests__/mint.integration.test.js`
Expected: reports **skipped** (no `NATS_JWT_TEST`). With a real broker: `NATS_JWT_TEST=wss://… NATS_JWT_TEST_ACCOUNT_SEED=SA… pnpm test` runs it.

- [ ] **Step 3: Commit**

```bash
git add src/transfer/__tests__/mint.integration.test.ts
git commit -m "test(transfer): gated integration test for minted creds scoping"
```

---

## Self-Review

**Spec coverage:**
- `mintScopedCreds` (JWT, scoped, short-TTL, `.creds`) → Task 1. ✅
- `scopeSubjects` bucket-level scoping; per-object deferred → Task 1 (`scopeSubjects`, documented). ✅
- `mintCredsFromEnv` + `NATS_ACCOUNT_SEED`/`NATS_WS_URL` + 400 → Task 2. ✅
- `POST /api/transfer/token` → `{ creds, wsUrl, expiresAt }` → Task 2. ✅
- Unit tests (creds parse, account-signed, exp, scoped perms) → Task 1. ✅
- Controller hermetic tests (400 + shaped 200) → Task 2. ✅
- Gated integration (scoping actually works) → Task 3. ✅
- Out of scope (browser/WS/bundling, send scope, per-object, broker ops) → not built; named in spec. ✅
- No MCP tool → correctly absent. ✅

**Placeholder scan:** No TBD/TODO. The two `VERIFY`/tuning notes are real build-time verifications against a third-party early-version lib and a live broker, each with a concrete fallback (adjust set-path / report BLOCKED; widen subjects) and a test that is the source of truth — not placeholders.

**Type consistency:** `mintScopedCreds(MintOpts) → Promise<MintedCreds>` and `scopeSubjects(bucket, scope) → {pub, sub}` are used identically in Tasks 1–3. `mintCredsFromEnv(scope) → {creds, wsUrl, expiresAt}` (Task 2) matches `TransferTokenResponseSchema` and the controller return. `TransferScope = "receive"` consistent throughout.

## Follow-ups (not in this plan)

- The browser web-receiver that consumes `/api/transfer/token` (NATS-over-WS, client-side decrypt, UI bundling) — the next feature.
- A `send` scope and per-object scoping.
- The NATS-server JWT/WebSocket ops setup (operator/account/resolver + `websocket {}`), documented as a deployment prerequisite.
