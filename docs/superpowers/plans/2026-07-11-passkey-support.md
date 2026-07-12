# Passkey Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add passkey (WebAuthn) passwordless sign-in for returning users to the marketplace SPA, layered on the existing social-only better-auth stack.

**Architecture:** Register better-auth's `@better-auth/passkey` server plugin in the aggregator's `makeAuth`; the existing `/api/auth/*splat` catch-all forwards its new `/api/auth/passkey/*` endpoints for free. On the client, use better-auth's official passkey client (`createAuthClient` + `passkeyClient`) *only* for the WebAuthn ceremony; the hand-rolled `fetch` client in `auth.ts` stays for social sign-in and session reads. Users sign in socially once, register a passkey in Account settings, then sign in with the passkey.

**Tech Stack:** TypeScript (ESM), better-auth 1.6.23, `@better-auth/passkey`, Drizzle + PGlite (tests), React (marketplace SPA), Vitest.

## Global Constraints

- **Node floor:** `>= 24`. ESM only (no CommonJS).
- **New-file header:** every new `.ts`/`.tsx` file starts with the two-line copyright header used across the repo: `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT`.
- **DB style:** Drizzle `pgTable` uses **camelCase JS property names** mapped to **snake_case column names**; `ensureSchema` is the DDL authority (hand-written idempotent `create table if not exists` / `alter table ... add column if not exists`). Any new column added later needs a paired `add column if not exists`.
- **better-auth drizzle mapping:** the passkey `pgTable`'s JS property names MUST exactly equal better-auth's passkey model field names (`id`, `name`, `publicKey`, `userId`, `credentialID`, `counter`, `deviceType`, `backedUp`, `transports`, `aaguid`, `createdAt`) or the adapter can't resolve the model.
- **WebAuthn RP ID:** production `rpID = agentgem.ai` (a registrable suffix of `app.agentgem.ai`); never the `api.agentgem.ai` baseURL default. Allowed `origin = webOrigins`. Dev `rpID = localhost`.
- **Test harness:** the root package's `test` script is `tsc -b && vitest run` and Vitest runs **compiled `dist/**/__tests__/**/*.test.js`** — so server tests live in `src/aggregator/__tests__/` or `src/auth/__tests__/` and only pass after a build. CI gates only this root `dist/__tests__` suite. The marketplace's own `vitest run` (on `src`) is **not** in CI — run it locally.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Branch/worktree:** all work happens on branch `feat/passkey` in worktree `../agentgem-worktrees/passkey`. Never commit to `main`.

---

## File Structure

- `packages/aggregator/package.json` — add `@better-auth/passkey` dependency.
- `packages/aggregator/src/auth/betterAuth.ts` — register the passkey plugin; add `passkeyRpId`/`passkeyOrigins`/`rpName` opts.
- `packages/aggregator/src/schema.ts` — add `passkey` `pgTable`, add it to the `schema` object, add its DDL to `ensureSchema`.
- `src/aggregator/__tests__/betterAuthPasskey.test.ts` — **new** server tests (plugin registered + table created).
- `src/auth/passkeyRpId.ts` — **new** `deriveRpId` helper (root server).
- `src/auth/__tests__/passkeyRpId.test.ts` — **new** unit tests for `deriveRpId`.
- `src/index.ts` — pass `passkeyRpId` into the `makeAuth({...})` call.
- `packages/marketplace/package.json` — add `better-auth` + `@better-auth/passkey` deps.
- `packages/marketplace/src/passkeyAuth.ts` — **new** passkey-only auth client + `passkeySupported()` guard.
- `packages/marketplace/src/passkeyAuth.test.ts` — **new** guard test.
- `packages/marketplace/src/SignInDialog.tsx` — **new** provider-list dialog (GitHub / Google / passkey).
- `packages/marketplace/src/SignInDialog.test.tsx` — **new** dialog tests.
- `packages/marketplace/src/App.tsx` — replace the two social sign-in links with one "Sign in" button opening `SignInDialog`; add the passkey sign-in handler.
- `packages/marketplace/src/pages/PasskeysSection.tsx` — **new** list/add/delete passkeys (injected client, DI for testability).
- `packages/marketplace/src/pages/PasskeysSection.test.tsx` — **new** section tests.
- `packages/marketplace/src/pages/Account.tsx` — mount `PasskeysSection` when signed in.

---

## Task 1: Aggregator — passkey plugin + schema + DDL

**Files:**
- Modify: `packages/aggregator/package.json`
- Modify: `packages/aggregator/src/auth/betterAuth.ts`
- Modify: `packages/aggregator/src/schema.ts`
- Test: `src/aggregator/__tests__/betterAuthPasskey.test.ts` (new)

**Interfaces:**
- Consumes: existing `makeAuth(opts)`, `makeTestDb()`, `ensureSchema(db)`, `schema` from `@agentgem/aggregator`.
- Produces: `makeAuth` now accepts `passkeyRpId?: string; passkeyOrigins?: string[]; rpName?: string`; the constructed `auth.options.plugins` includes a plugin with `id === "passkey"`; the DB has a `passkey` table.

- [ ] **Step 1: Add the dependency**

Run (in the worktree root):
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/aggregator add @better-auth/passkey
```
Expected: `@better-auth/passkey` appears under `dependencies` in `packages/aggregator/package.json` and installs cleanly.

- [ ] **Step 2: Write the failing server test**

Create `src/aggregator/__tests__/betterAuthPasskey.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb, makeAuth } from "@agentgem/aggregator";

const opts = {
  secret: "test-secret",
  baseURL: "http://localhost:4000",
  githubClientId: "gid",
  githubClientSecret: "gsecret",
  webOrigins: ["http://localhost:3000"],
};

describe("betterAuth passkey plugin", () => {
  it("registers the passkey plugin", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts, passkeyRpId: "agentgem.ai" });
    const ids = (auth.options.plugins ?? []).map((p: { id: string }) => p.id);
    expect(ids).toContain("passkey");
  });

  it("ensureSchema creates the passkey table keyed to a user", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts, passkeyRpId: "agentgem.ai" });
    const ctx = await auth.$context;
    const user = await ctx.internalAdapter.createUser(
      { email: "pk@example.com", name: "PK", emailVerified: false } as never,
    );
    // A missing table, missing column, or broken FK throws here.
    await db.execute(sql`insert into "passkey"
      (id, name, public_key, user_id, credential_id, counter, device_type, backed_up, transports, aaguid)
      values ('pk1', 'Primary', 'PUB', ${user.id}, 'CRED1', 0, 'singleDevice', true, 'internal', 'aaguid1')`);
    const rows = await db.execute(sql`select credential_id, user_id from "passkey" where id = 'pk1'`);
    expect((rows.rows[0] as { credential_id: string }).credential_id).toBe("CRED1");
    expect((rows.rows[0] as { user_id: string }).user_id).toBe(user.id);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm -w run build && pnpm -w exec vitest run dist/aggregator/__tests__/betterAuthPasskey.test.js
```
Expected: FAIL — either the build errors on the unknown `passkeyRpId` opt / missing plugin, or the table insert throws `relation "passkey" does not exist`.

- [ ] **Step 4: Register the plugin in `makeAuth`**

In `packages/aggregator/src/auth/betterAuth.ts`:

Add the import near the other plugin imports (after line 8):
```ts
import { passkey } from "@better-auth/passkey";
```

Extend the `opts` type in the `makeAuth` signature (the object after `webOrigins: string[]; cookieDomain?: string;`) to include:
```ts
  passkeyRpId?: string; passkeyOrigins?: string[]; rpName?: string;
```

In the `plugins: [...]` array, append the passkey plugin after `oneTimeToken({...})`:
```ts
    oneTimeToken({ expiresIn: 1, storeToken: "hashed" }),
    // Passkey (WebAuthn) passwordless sign-in. rpID MUST be a registrable suffix of the page origin
    // (app.agentgem.ai) — the api.agentgem.ai baseURL default would fail verification — so the caller
    // (src/index.ts) passes agentgem.ai, mirroring crossSubDomainCookies. `origin` is the allowed page
    // origin(s); it defaults to webOrigins. requireSession stays default (true): a passkey always
    // attaches to the caller's existing social session (there is no passkey-first onboarding).
    passkey({ rpID: opts.passkeyRpId, rpName: opts.rpName ?? "AgentGem", origin: opts.passkeyOrigins ?? opts.webOrigins })],
```
(The existing `plugins` array literal closes with `]` on the `oneTimeToken` line — move that `]` to after the new `passkey(...)` entry as shown.)

- [ ] **Step 5: Add the `passkey` table and DDL**

In `packages/aggregator/src/schema.ts`:

After the `verification` table definition (around line 408), add:
```ts
// better-auth passkey plugin (@better-auth/passkey). JS property names MUST match the plugin's model
// field names exactly (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp,
// transports, aaguid, createdAt) so the drizzle adapter resolves the model; columns are snake_case
// per house style. DDL authority is ensureSchema below.
export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull().default(0),
    deviceType: text("device_type"),
    backedUp: boolean("backed_up"),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("passkey_user_idx").on(t.userId)],
);
```

Add `passkey` to the exported `schema` object (the `export const schema = { ... }` line ~424) — append `, passkey` before the closing `}`.

In `ensureSchema`, right after the `"verification"` `create table if not exists` block (~line 693), add:
```ts
  await db.execute(sql`create table if not exists "passkey" (
    id text primary key,
    name text,
    public_key text not null,
    user_id text not null references "user"(id) on delete cascade,
    credential_id text not null,
    counter integer not null default 0,
    device_type text,
    backed_up boolean,
    transports text,
    aaguid text,
    created_at timestamptz not null default now())`);
  await db.execute(sql`create index if not exists passkey_user_idx on "passkey"(user_id)`);
```

- [ ] **Step 6: Run the test to verify it passes**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm -w run build && pnpm -w exec vitest run dist/aggregator/__tests__/betterAuthPasskey.test.js
```
Expected: PASS (2 tests).

- [ ] **Step 7: Run the existing betterAuth suite to check for regressions**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm -w exec vitest run dist/aggregator/__tests__/betterAuth.test.js
```
Expected: PASS (all existing tests unchanged).

- [ ] **Step 8: Commit**

```bash
cd ../agentgem-worktrees/passkey
git add packages/aggregator/package.json pnpm-lock.yaml packages/aggregator/src/auth/betterAuth.ts packages/aggregator/src/schema.ts src/aggregator/__tests__/betterAuthPasskey.test.ts
git commit -m "feat(auth): register better-auth passkey plugin + passkey table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Root server — RP ID derivation + env wiring

**Files:**
- Create: `src/auth/passkeyRpId.ts`
- Test: `src/auth/__tests__/passkeyRpId.test.ts` (new)
- Modify: `src/index.ts` (the `makeAuth({...})` call, ~line 228-238)

**Interfaces:**
- Consumes: `makeAuth`'s new `passkeyRpId` opt (Task 1).
- Produces: `deriveRpId(explicit: string | undefined, cookieDomain: string | undefined): string`.

- [ ] **Step 1: Write the failing test**

Create `src/auth/__tests__/passkeyRpId.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { deriveRpId } from "../passkeyRpId.js";

describe("deriveRpId", () => {
  it("prefers an explicit RP ID", () => {
    expect(deriveRpId("passkeys.agentgem.ai", ".agentgem.ai")).toBe("passkeys.agentgem.ai");
  });
  it("derives from the cookie domain, stripping a leading dot", () => {
    expect(deriveRpId(undefined, ".agentgem.ai")).toBe("agentgem.ai");
    expect(deriveRpId(undefined, "agentgem.ai")).toBe("agentgem.ai");
  });
  it("falls back to localhost when nothing is configured", () => {
    expect(deriveRpId(undefined, undefined)).toBe("localhost");
    expect(deriveRpId(undefined, "")).toBe("localhost");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm -w run build && pnpm -w exec vitest run dist/auth/__tests__/passkeyRpId.test.js
```
Expected: FAIL — build error, `Cannot find module '../passkeyRpId.js'`.

- [ ] **Step 3: Write the helper**

Create `src/auth/passkeyRpId.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT

/** The WebAuthn Relying Party ID for the passkey plugin. A passkey created on app.agentgem.ai must
 *  use an RP ID that is a registrable suffix of that origin, so the api.agentgem.ai baseURL default
 *  would fail verification. We derive it from the cross-subdomain cookie domain already configured
 *  (agentgem.ai), or fall back to localhost in dev. An explicit AGENTGEM_PASSKEY_RP_ID always wins. */
export function deriveRpId(explicit: string | undefined, cookieDomain: string | undefined): string {
  if (explicit) return explicit;
  if (cookieDomain) return cookieDomain.replace(/^\./, "");
  return "localhost";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm -w run build && pnpm -w exec vitest run dist/auth/__tests__/passkeyRpId.test.js
```
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the env into `makeAuth`**

In `src/index.ts`, add the import alongside the other `./auth/*` imports (near line 68 where `makeAuth` is imported, or with the local auth imports):
```ts
import { deriveRpId } from "./auth/passkeyRpId.js";
```

In the `makeAuth({ ... })` call (the block starting ~line 228), add one line after `cookieDomain: process.env.AGENTGEM_SESSION_COOKIE_DOMAIN,`:
```ts
      passkeyRpId: deriveRpId(process.env.AGENTGEM_PASSKEY_RP_ID, process.env.AGENTGEM_SESSION_COOKIE_DOMAIN),
```
(`passkeyOrigins` and `rpName` are left to their `makeAuth` defaults — `webOrigins` and `"AgentGem"`.)

- [ ] **Step 6: Rebuild and run the full auth suite for regressions**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm -w run build && pnpm -w exec vitest run dist/auth/__tests__ dist/aggregator/__tests__/betterAuth.test.js dist/aggregator/__tests__/betterAuthPasskey.test.js
```
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
cd ../agentgem-worktrees/passkey
git add src/auth/passkeyRpId.ts src/auth/__tests__/passkeyRpId.test.ts src/index.ts
git commit -m "feat(auth): derive passkey RP ID from cookie domain and wire into makeAuth

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Marketplace — passkey auth client + capability guard

**Files:**
- Modify: `packages/marketplace/package.json`
- Create: `packages/marketplace/src/passkeyAuth.ts`
- Test: `packages/marketplace/src/passkeyAuth.test.ts` (new)

**Interfaces:**
- Consumes: `defaultApiBase()` from `./api` (callers use it).
- Produces: `makePasskeyAuth(base: string)` → a better-auth client whose surface used downstream is `.signIn.passkey(opts?)`, `.passkey.addPasskey({ name })`, `.passkey.listUserPasskeys()`, `.passkey.deletePasskey({ id })`, each returning `{ data, error }`; and `passkeySupported(): boolean`.

- [ ] **Step 1: Add the dependencies**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/marketplace add better-auth @better-auth/passkey
```
Expected: both appear under `dependencies` in `packages/marketplace/package.json`.

- [ ] **Step 2: Write the failing guard test**

Create `packages/marketplace/src/passkeyAuth.test.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { passkeySupported, makePasskeyAuth } from "./passkeyAuth";

describe("passkeyAuth", () => {
  const orig = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  afterEach(() => {
    if (orig === undefined) delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    else (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = orig;
  });

  it("passkeySupported reflects PublicKeyCredential availability", () => {
    (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = function () {};
    expect(passkeySupported()).toBe(true);
    delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    expect(passkeySupported()).toBe(false);
  });

  it("makePasskeyAuth exposes the passkey ceremony surface", () => {
    const client = makePasskeyAuth("https://api.example.test");
    expect(typeof client.signIn.passkey).toBe("function");
    expect(typeof client.passkey.addPasskey).toBe("function");
    expect(typeof client.passkey.listUserPasskeys).toBe("function");
    expect(typeof client.passkey.deletePasskey).toBe("function");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/marketplace exec vitest run src/passkeyAuth.test.ts
```
Expected: FAIL — `Cannot find module './passkeyAuth'`.

- [ ] **Step 4: Write the client module**

Create `packages/marketplace/src/passkeyAuth.ts`:
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { createAuthClient } from "better-auth/client";
import { passkeyClient } from "@better-auth/passkey/client";

/** Passkey-only better-auth client. Social sign-in and session reads stay on the hand-rolled fetch
 *  client in auth.ts; this exists solely to run the WebAuthn ceremony correctly (base64url<->
 *  ArrayBuffer, navigator.credentials), which is error-prone to hand-roll. baseURL is the API origin;
 *  better-auth appends its default "/api/auth" base path. credentials:"include" so the cross-subdomain
 *  session cookie travels, matching auth.ts. */
export function makePasskeyAuth(base: string) {
  return createAuthClient({
    baseURL: base,
    plugins: [passkeyClient()],
    fetchOptions: { credentials: "include" },
  });
}

/** True when the browser can do WebAuthn at all. Gates every "Use a passkey" affordance. */
export function passkeySupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/marketplace exec vitest run src/passkeyAuth.test.ts
```
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck the marketplace**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/marketplace run typecheck
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd ../agentgem-worktrees/passkey
git add packages/marketplace/package.json pnpm-lock.yaml packages/marketplace/src/passkeyAuth.ts packages/marketplace/src/passkeyAuth.test.ts
git commit -m "feat(marketplace): passkey auth client + capability guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Marketplace — sign-in provider dialog

**Files:**
- Create: `packages/marketplace/src/SignInDialog.tsx`
- Test: `packages/marketplace/src/SignInDialog.test.tsx` (new)
- Modify: `packages/marketplace/src/App.tsx`

**Interfaces:**
- Consumes: `Modal` from `./Modal`; `passkeySupported`, `makePasskeyAuth` from `./passkeyAuth` (Task 3); existing `auth.getMe()`, `auth.signIn(provider, returnTo)`.
- Produces: `SignInDialog({ onClose, onSocial, onPasskey, passkeyAvailable, error }: { onClose: () => void; onSocial: (p: "github" | "google") => void; onPasskey: () => void; passkeyAvailable: boolean; error: string | null })`.

- [ ] **Step 1: Write the failing dialog test**

Create `packages/marketplace/src/SignInDialog.test.tsx`:
```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SignInDialog } from "./SignInDialog";

const base = { onClose: () => {}, onSocial: () => {}, onPasskey: () => {}, error: null };

afterEach(() => cleanup());

describe("SignInDialog", () => {
  it("offers passkey when available and routes each choice", () => {
    const onSocial = vi.fn();
    const onPasskey = vi.fn();
    render(<SignInDialog {...base} onSocial={onSocial} onPasskey={onPasskey} passkeyAvailable={true} />);
    fireEvent.click(screen.getByRole("button", { name: /github/i }));
    fireEvent.click(screen.getByRole("button", { name: /google/i }));
    fireEvent.click(screen.getByRole("button", { name: /passkey/i }));
    expect(onSocial).toHaveBeenNthCalledWith(1, "github");
    expect(onSocial).toHaveBeenNthCalledWith(2, "google");
    expect(onPasskey).toHaveBeenCalledOnce();
  });

  it("hides the passkey option when unavailable", () => {
    render(<SignInDialog {...base} passkeyAvailable={false} />);
    expect(screen.queryByRole("button", { name: /passkey/i })).toBeNull();
  });

  it("surfaces an error message", () => {
    render(<SignInDialog {...base} passkeyAvailable={true} error="no authenticator" />);
    expect(screen.getByRole("alert").textContent).toContain("no authenticator");
  });
});
```
Note: `@testing-library/react` and `jsdom` are already marketplace deps, and there is **no** `@testing-library/jest-dom` — so use jest-dom-free assertions (`.textContent`, `getAttribute`, `toBeTruthy`), and `afterEach(() => cleanup())`, exactly as `Modal.test.tsx` does.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/marketplace exec vitest run src/SignInDialog.test.tsx
```
Expected: FAIL — `Cannot find module './SignInDialog'`.

- [ ] **Step 3: Write the dialog component**

Create `packages/marketplace/src/SignInDialog.tsx`:
```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { Modal } from "./Modal";

/** The sign-in chooser: one entry per provider plus an optional passkey entry. Presentational —
 *  all effects (OAuth redirect, WebAuthn ceremony) live in the parent so this stays testable. */
export function SignInDialog({ onClose, onSocial, onPasskey, passkeyAvailable, error }: {
  onClose: () => void;
  onSocial: (p: "github" | "google") => void;
  onPasskey: () => void;
  passkeyAvailable: boolean;
  error: string | null;
}) {
  return (
    <Modal title="Sign in" onClose={onClose}>
      <div className="ex-signin-choices">
        <button type="button" className="ex-signin-choice" onClick={() => onSocial("github")}>Sign in with GitHub</button>
        <button type="button" className="ex-signin-choice" onClick={() => onSocial("google")}>Sign in with Google</button>
        {passkeyAvailable && (
          <button type="button" className="ex-signin-choice" onClick={onPasskey}>Use a passkey</button>
        )}
      </div>
      {error && <p className="ex-error" role="alert">{error}</p>}
    </Modal>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/marketplace exec vitest run src/SignInDialog.test.tsx
```
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the dialog into `App.tsx`**

In `packages/marketplace/src/App.tsx`:

Add imports:
```ts
import { SignInDialog } from "./SignInDialog";
import { makePasskeyAuth, passkeySupported } from "./passkeyAuth";
```

Add the passkey client next to the other module-level clients (after line 13 `const reviewsApi = ...`):
```ts
const passkeyAuth = makePasskeyAuth(defaultApiBase());
```

Add dialog state next to the other `useState`s (after `signInError`, line 19):
```ts
  const [showSignIn, setShowSignIn] = useState(false);
```

Add the passkey sign-in handler next to `signIn` (after line 52):
```ts
  const signInPasskey = async () => {
    setSignInError(null);
    try {
      const res = await passkeyAuth.signIn.passkey();
      if (res?.error) { setSignInError(res.error.message ?? "Passkey sign-in failed"); return; }
      setShowSignIn(false);
      setMe(await auth.getMe());
    } catch (err) {
      // The WebAuthn ceremony rejects on cancel / no authenticator / unsupported — surface it.
      setSignInError(err instanceof Error ? err.message : String(err));
    }
  };
```

Replace the two signed-out links (lines 93-96, the `<>...</>` with the two `ex-signin` anchors) with a single button that opens the dialog:
```tsx
          ) : (
            <a className="ex-signin" href="#" onClick={(e) => { e.preventDefault(); setSignInError(null); setShowSignIn(true); }}>Sign in</a>
          )}
```

Render the dialog. Add it right after the header's closing `</header>` (before the `{signInError && ...}` line at 100), so a social failure still shows inline after the dialog closes on redirect:
```tsx
      {showSignIn && (
        <SignInDialog
          onClose={() => setShowSignIn(false)}
          onSocial={(p) => { setShowSignIn(false); signIn(p); }}
          onPasskey={signInPasskey}
          passkeyAvailable={passkeySupported()}
          error={signInError}
        />
      )}
```

- [ ] **Step 6: Typecheck + run the marketplace suite**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/marketplace run typecheck && pnpm --filter @agentgem/marketplace exec vitest run src/SignInDialog.test.tsx src/App.test.tsx
```
Expected: typecheck clean; `SignInDialog` tests PASS; `App.test.tsx` PASS (update `App.test.tsx` only if it asserted on the removed "Sign in with GitHub"/"Sign in with Google" header links — if so, change those assertions to the new single "Sign in" button, matching the existing test's style).

- [ ] **Step 7: Commit**

```bash
cd ../agentgem-worktrees/passkey
git add packages/marketplace/src/SignInDialog.tsx packages/marketplace/src/SignInDialog.test.tsx packages/marketplace/src/App.tsx
# include packages/marketplace/src/App.test.tsx and package.json/pnpm-lock.yaml if they changed
git commit -m "feat(marketplace): single sign-in button with provider dialog incl. passkey

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Marketplace — passkey management in Account

**Files:**
- Create: `packages/marketplace/src/pages/PasskeysSection.tsx`
- Test: `packages/marketplace/src/pages/PasskeysSection.test.tsx` (new)
- Modify: `packages/marketplace/src/pages/Account.tsx`

**Interfaces:**
- Consumes: the passkey client shape from Task 3 (`.passkey.listUserPasskeys()`, `.passkey.addPasskey({ name })`, `.passkey.deletePasskey({ id })`), `passkeySupported()`.
- Produces: `PasskeysSection({ client, supported }: { client: PasskeyClient; supported: boolean })` where `PasskeyClient` is the structural type `{ passkey: { listUserPasskeys(): Promise<{ data: PasskeyRow[] | null; error: unknown }>; addPasskey(a: { name: string }): Promise<{ error: unknown }>; deletePasskey(a: { id: string }): Promise<{ error: unknown }> } }` and `PasskeyRow = { id: string; name?: string | null; createdAt?: string | Date }`.

- [ ] **Step 1: Write the failing section test**

Create `packages/marketplace/src/pages/PasskeysSection.test.tsx`:
```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { PasskeysSection } from "./PasskeysSection";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function makeClient(rows: { id: string; name?: string }[]) {
  return {
    passkey: {
      listUserPasskeys: vi.fn().mockResolvedValue({ data: rows, error: null }),
      addPasskey: vi.fn().mockResolvedValue({ error: null }),
      deletePasskey: vi.fn().mockResolvedValue({ error: null }),
    },
  };
}

describe("PasskeysSection", () => {
  it("lists the user's passkeys", async () => {
    const client = makeClient([{ id: "a", name: "Laptop" }]);
    render(<PasskeysSection client={client as never} supported={true} />);
    expect(await screen.findByText("Laptop")).toBeTruthy();
  });

  it("adds a passkey then reloads the list", async () => {
    const client = makeClient([]);
    vi.spyOn(window, "prompt").mockReturnValue("Phone");
    render(<PasskeysSection client={client as never} supported={true} />);
    fireEvent.click(await screen.findByRole("button", { name: /add a passkey/i }));
    await waitFor(() => expect(client.passkey.addPasskey).toHaveBeenCalledWith({ name: "Phone" }));
    expect(client.passkey.listUserPasskeys).toHaveBeenCalledTimes(2); // initial + reload
  });

  it("deletes a passkey", async () => {
    const client = makeClient([{ id: "a", name: "Laptop" }]);
    render(<PasskeysSection client={client as never} supported={true} />);
    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));
    await waitFor(() => expect(client.passkey.deletePasskey).toHaveBeenCalledWith({ id: "a" }));
  });

  it("surfaces an add error", async () => {
    const client = makeClient([]);
    client.passkey.addPasskey.mockResolvedValue({ error: { message: "cancelled" } });
    vi.spyOn(window, "prompt").mockReturnValue("Phone");
    render(<PasskeysSection client={client as never} supported={true} />);
    fireEvent.click(await screen.findByRole("button", { name: /add a passkey/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cancelled/i);
  });

  it("hides the add button when unsupported", () => {
    const client = makeClient([]);
    render(<PasskeysSection client={client as never} supported={false} />);
    expect(screen.queryByRole("button", { name: /add a passkey/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/marketplace exec vitest run src/pages/PasskeysSection.test.tsx
```
Expected: FAIL — `Cannot find module './PasskeysSection'`.

- [ ] **Step 3: Write the section component**

Create `packages/marketplace/src/pages/PasskeysSection.tsx`:
```tsx
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useState } from "react";

type PasskeyRow = { id: string; name?: string | null; createdAt?: string | Date };
type PasskeyClient = {
  passkey: {
    listUserPasskeys(): Promise<{ data: PasskeyRow[] | null; error: unknown }>;
    addPasskey(a: { name: string }): Promise<{ error: unknown }>;
    deletePasskey(a: { id: string }): Promise<{ error: unknown }>;
  };
};

function errMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return "Something went wrong";
}

/** Manage passkeys for the signed-in user: list, add (WebAuthn registration against the current
 *  session), delete. The client is injected so this is testable without the browser ceremony. */
export function PasskeysSection({ client, supported }: { client: PasskeyClient; supported: boolean }) {
  const [rows, setRows] = useState<PasskeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await client.passkey.listUserPasskeys();
    if (res.error) { setError(errMessage(res.error)); return; }
    setRows(res.data ?? []);
  }, [client]);

  useEffect(() => { void reload(); }, [reload]);

  const add = async () => {
    setError(null);
    const name = window.prompt("Name this passkey (e.g. \"MacBook\")");
    if (!name) return;
    const res = await client.passkey.addPasskey({ name });
    if (res.error) { setError(errMessage(res.error)); return; }
    await reload();
  };

  const remove = async (id: string) => {
    setError(null);
    const res = await client.passkey.deletePasskey({ id });
    if (res.error) { setError(errMessage(res.error)); return; }
    await reload();
  };

  return (
    <section className="ex-passkeys">
      <h2>Passkeys</h2>
      <p className="ex-muted">Sign in without GitHub or Google using Face ID, Touch ID, or a security key.</p>
      {rows.length === 0 ? (
        <p className="ex-muted">No passkeys yet.</p>
      ) : (
        <ul className="ex-passkey-list">
          {rows.map((r) => (
            <li key={r.id} className="ex-passkey-row">
              <span>{r.name || "Unnamed passkey"}</span>
              <button type="button" className="ex-passkey-del" onClick={() => remove(r.id)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
      {supported && <button type="button" className="ex-passkey-add" onClick={add}>Add a passkey</button>}
      {error && <p className="ex-error" role="alert">{error}</p>}
    </section>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/marketplace exec vitest run src/pages/PasskeysSection.test.tsx
```
Expected: PASS (5 tests).

- [ ] **Step 5: Mount the section in `Account.tsx`**

In `packages/marketplace/src/pages/Account.tsx`:

Add imports at the top:
```ts
import { useMemo } from "react";
import { makePasskeyAuth, passkeySupported } from "../passkeyAuth";
import { PasskeysSection } from "./PasskeysSection";
```
(Merge `useMemo` into the existing `import { useEffect, useState } from "react";` line rather than duplicating the import.)

Inside the `Account` component body, build the client from the existing `base` prop:
```ts
  const passkeyAuth = useMemo(() => makePasskeyAuth(base), [base]);
```

Render the section where the signed-in account content lives — only when signed in (`me` is truthy). Add, near the end of the signed-in branch of the returned JSX:
```tsx
      {me && <PasskeysSection client={passkeyAuth} supported={passkeySupported()} />}
```
(Place it after the existing connected-providers block. Read the current JSX return to find the exact insertion point inside the `status === "ok"` render; match the surrounding element nesting.)

- [ ] **Step 6: Typecheck + run Account/section suites**

Run:
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/marketplace run typecheck && pnpm --filter @agentgem/marketplace exec vitest run src/pages/PasskeysSection.test.tsx src/pages/Account.test.tsx
```
Expected: typecheck clean; both suites PASS (adjust `Account.test.tsx` only if mounting the section broke an assertion — e.g. an unexpected extra `listUserPasskeys` fetch; if so, the test may need to stub or ignore it. Keep changes minimal and in the existing style).

- [ ] **Step 7: Commit**

```bash
cd ../agentgem-worktrees/passkey
git add packages/marketplace/src/pages/PasskeysSection.tsx packages/marketplace/src/pages/PasskeysSection.test.tsx packages/marketplace/src/pages/Account.tsx
git commit -m "feat(marketplace): manage passkeys in Account settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] **Full root suite (CI-gated):**
```bash
cd ../agentgem-worktrees/passkey && pnpm -w run test
```
Expected: PASS (this is the `test (24)` gate; `tsc -b` then all `dist/**/__tests__`).

- [ ] **Full marketplace suite (local-only, not in CI):**
```bash
cd ../agentgem-worktrees/passkey && pnpm --filter @agentgem/marketplace run typecheck && pnpm --filter @agentgem/marketplace exec vitest run
```
Expected: PASS.

- [ ] **Manual smoke (optional, real browser):** set `AGENTGEM_PASSKEY_RP_ID=localhost` in dev, sign in with GitHub, open Account → Add a passkey, sign out, then use the "Sign in" dialog → "Use a passkey" to sign back in. Verify the session is restored.

- [ ] **Integration:** push `feat/passkey` and open a PR; let CI (`test (24)`) gate it; merge with `--rebase` once green (per repo PR-lifecycle rules — verify each commit landed on `origin/main` after merge).

---

## Notes for the implementer

- The passkey plugin's `/api/auth/passkey/*` endpoints need **no** new server routes — the existing `mountAuth` catch-all in `src/auth/mount.ts` forwards everything to `auth.handler`. Do not add routes.
- If Step 6 of Task 1 fails with a column/field mismatch (e.g. the installed `@better-auth/passkey` expects a different field name than the plan lists), inspect the plugin's shipped schema: `packages/aggregator/node_modules/@better-auth/passkey/dist/*` and reconcile the `pgTable` property names + DDL columns to match it exactly. The field list here is from the plugin docs; the installed package is the source of truth.
- The marketplace currently has **zero** internal `@agentgem/*` deps and hand-rolls `fetch`. Adding `better-auth`/`@better-auth/passkey` (external) is intentional and scoped to the passkey ceremony only — do not migrate the existing `auth.ts` fetch calls onto the client.
