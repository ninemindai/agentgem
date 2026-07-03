# Unified Identity — Sub-project 1: Reconcile + Avatar (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the GitHub avatar during console device-flow binding, reconcile the console binding with the web `accounts` identity (via `upsertAccount`), and show the avatar in the Settings "Verified as @bob" box.

**Architecture:** The device-flow bind POSTs to the hosted aggregator's `/api/aggregator/bind` → `recordBinding`. Enhance the aggregator side to (a) read `avatar_url` in the verifier, (b) `upsertAccount` best-effort (the reconciliation — shared `accounts` row keyed on `(provider, provider_account_id)`), (c) return `avatarUrl` in the response. The console's `completeDeviceBind` writes that avatar into `~/.agentgem/binding.json`; `readBindingStatus` reads it; Settings renders it. No new columns/FK/migration.

**Tech Stack:** TypeScript, Zod, Drizzle (pglite for tests), Vitest (+ jsdom for the console), pnpm workspaces (`@agentgem/aggregator`, root `src/`, `@agentgem/console`).

**Spec:** `docs/superpowers/specs/2026-07-03-identity-reconcile-avatar-design.md`.

## Global Constraints

- Node floor `>=24` (repo-wide).
- **Avatar is best-effort / never-throw:** a missing `avatar_url`, or an `upsertAccount` failure, must NOT fail the binding — the `account_bindings` write (what ratings depend on) still succeeds and `bound: true` is still returned; the avatar is simply absent.
- **Additive & backward-compatible:** every `avatarUrl` field/param is optional; a bind with no avatar behaves exactly as today (text-only "Verified as @bob").
- **Reconciliation = reuse `upsertAccount`**, whose existing conflict target `(accounts.provider, accounts.providerAccountId)` is the join key. No new columns, no FK, no migration.
- **Client/server schema parity:** the console `routes.ts` bind schemas must match the server `gem.controller.ts` schemas exactly (this repo silently drops mismatched body/response fields).
- Test command: `pnpm test` (`tsc -b && vitest run`) for `src/**/__tests__/` (aggregator + bind + gem endpoints). Console: `pnpm --filter @agentgem/console test` + `pnpm --filter @agentgem/console typecheck` (console tests are NOT in root CI). Ignore any pre-existing unrelated flake.

## Non-goals

Profile page (sub-project 2), avatars in listings (sub-project 3), a hard FK / backfill, changes to the web OAuth flow.

---

### Task 1: `GitHubVerifier.verify` captures `avatar_url`

**Files:**
- Modify: `packages/aggregator/src/accountVerifier.ts` (`VerifiedAccount` line 5; `verify` lines 15-18)
- Test: `src/aggregator/__tests__/accountVerifier.test.ts` (extend)

**Interfaces:**
- Produces: `interface VerifiedAccount { provider: string; accountId: string; login: string; avatarUrl?: string }` — `verify()` sets `avatarUrl` when the `/user` response has a string `avatar_url`, omits it otherwise.

- [ ] **Step 1: Write the failing test**

Add to `src/aggregator/__tests__/accountVerifier.test.ts` (the file already has `fakeFetch(status, body)`):

```ts
it("captures avatar_url when present", async () => {
  const v = new GitHubVerifier(fakeFetch(200, { id: 42, login: "octocat", avatar_url: "https://avatars.githubusercontent.com/u/42" }));
  expect(await v.verify("tok")).toEqual({ provider: "github", accountId: "42", login: "octocat", avatarUrl: "https://avatars.githubusercontent.com/u/42" });
});
it("omits avatarUrl when /user has no avatar_url", async () => {
  const v = new GitHubVerifier(fakeFetch(200, { id: 42, login: "octocat" }));
  expect((await v.verify("tok")).avatarUrl).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `avatarUrl` missing from the result.

- [ ] **Step 3: Implement**

In `packages/aggregator/src/accountVerifier.ts`, change the interface (line 5) and `verify` (lines 15-18):

```ts
export interface VerifiedAccount { provider: string; accountId: string; login: string; avatarUrl?: string; }
```
```ts
    const u = (await res.json()) as { id?: unknown; login?: unknown; avatar_url?: unknown };
    if (typeof u.id !== "number" || typeof u.login !== "string") throw new Error("github /user: unexpected shape");
    // accountId is the numeric id as text (stable across login renames); login is for display only.
    return { provider: "github", accountId: String(u.id), login: u.login, ...(typeof u.avatar_url === "string" ? { avatarUrl: u.avatar_url } : {}) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS (both new cases; existing verifier cases still green).

- [ ] **Step 5: Commit**

```bash
git add packages/aggregator/src/accountVerifier.ts src/aggregator/__tests__/accountVerifier.test.ts
git commit -m "feat(aggregator): capture avatar_url in GitHubVerifier"
```

---

### Task 2: `recordBinding` reconciles the account (best-effort) + returns avatar

**Files:**
- Modify: `packages/aggregator/src/binding.ts` (import `upsertAccount`; `BindResult` line 16-18; `recordBinding` lines 43-54)
- Modify: `src/aggregator.controller.ts` (`BindResultSchema` line 44 — add `avatarUrl` to the bound branch)
- Test: `src/aggregator/__tests__/binding.test.ts` (extend)

**Interfaces:**
- Consumes: `VerifiedAccount.avatarUrl` (Task 1); `upsertAccount(db, { provider, accountId, login, avatarUrl? })` from `./webAuth.js` (already exists).
- Produces: `BindResult` bound branch gains `avatarUrl?: string`; `recordBinding` upserts the `accounts` row (best-effort) and returns `avatarUrl`. `BindResultSchema` accepts `avatarUrl`.

- [ ] **Step 1: Write the failing test**

In `src/aggregator/__tests__/binding.test.ts`, follow the file's existing `recordBinding` test setup (a real `makeTestDb`, a seeded `producers` row for the pubkey, a valid signature via the test identity, and a fake `AccountVerifier`). Add a fake verifier that returns an avatar, and assert both the returned avatar and the reconciled `accounts` row:

```ts
import { accounts } from "@agentgem/aggregator"; // if not already imported; else read the row via db.execute
// … reuse the existing db/producer/identity/signedReq setup from the neighbouring recordBinding test …

it("reconciles the accounts row with avatar and returns avatarUrl", async () => {
  const verifier = { verify: async () => ({ provider: "github", accountId: "42", login: "octocat", avatarUrl: "https://a/42.png" }) };
  const res = await recordBinding(db, signedReq, verifier, NOW);
  expect(res).toMatchObject({ bound: true, login: "octocat", avatarUrl: "https://a/42.png" });
  const rows = await db.select().from(accounts).where(sql`provider = 'github' and provider_account_id = '42'`);
  expect(rows[0]?.avatarUrl).toBe("https://a/42.png");
});
```

(Reuse the existing test's `db`, `signedReq`, `NOW`/`now`, and `sql` import — read the file first and match its exact names; do not invent a new harness.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `res.avatarUrl` undefined and no `accounts` row written.

- [ ] **Step 3: Implement `binding.ts`**

Add the import (with the other `./` imports near line 12-13):

```ts
import { upsertAccount } from "./webAuth.js";
```

Change `BindResult` (lines 16-18) — add `avatarUrl` to the bound branch:

```ts
export type BindResult =
  | { bound: true; provider: string; login: string; accountId: string; avatarUrl?: string }
  | { bound: false; rejected: "bad-signature" | "stale" | "unknown-producer" | "provider-error" };
```

In `recordBinding`, after step 4 (verify) and before the `account_bindings` upsert (line 48), add the best-effort reconciliation; and add `avatarUrl` to the return (line 54):

```ts
  // 4b. reconcile with the web `accounts` identity + capture avatar. Best-effort: NEVER fail
  // the bind over it — the account_bindings write below is what ratings depend on.
  try {
    await upsertAccount(db, { provider: acct.provider, accountId: acct.accountId, login: acct.login, avatarUrl: acct.avatarUrl ?? null });
  } catch { /* avatar/profile is best-effort */ }
```
```ts
  return { bound: true, provider: acct.provider, login: acct.login, accountId: acct.accountId, ...(acct.avatarUrl ? { avatarUrl: acct.avatarUrl } : {}) };
```

- [ ] **Step 4: Implement the wire schema (`src/aggregator.controller.ts`)**

`BindResultSchema` (line 44) is a `z.union`. Add `avatarUrl: z.string().optional()` to the **bound** member (the one with `bound: z.literal(true)` / `login`). Read the exact union first; the bound branch must gain `avatarUrl: z.string().optional()`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS (new case + existing binding cases). `tsc -b` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/binding.ts src/aggregator.controller.ts src/aggregator/__tests__/binding.test.ts
git commit -m "feat(aggregator): recordBinding reconciles accounts (avatar) best-effort + returns avatarUrl"
```

---

### Task 3: Thread avatar through the console bind plumbing (binding.json + schemas)

**Files:**
- Modify: `src/bind/bindCore.ts` (`completeDeviceBind` lines 45-70; `readBindingStatus` lines 72-80)
- Modify: `src/gem.controller.ts` (`BindCompleteSchema` ~line 274-277; `BindStatusSchema` line 277)
- Modify: `packages/console/src/api/routes.ts` (`bindStatusRoute` line 642-644; `bindCompleteRoute` line 651-653)
- Test: `src/bind/__tests__/bindCore.test.ts` (extend)

**Interfaces:**
- Consumes: the `/api/aggregator/bind` response now carries `avatarUrl` (Task 2).
- Produces: `completeDeviceBind` returns `{ bound: true, …, avatarUrl?: string }` and persists `avatarUrl` in `~/.agentgem/binding.json`; `readBindingStatus` returns `{ bound, login?, provider?, avatarUrl? }`; the gem-controller + console-route bind schemas expose `avatarUrl`.

- [ ] **Step 1: Write the failing test**

In `src/bind/__tests__/bindCore.test.ts` (already uses `useHermeticHome`, `jsonFetch(body)`, `fakeIdentity`):

```ts
it("persists and returns avatarUrl from the bind response", async () => {
  const cfg = { clientId: "cid", base: "https://agg.example" };
  const res = await completeDeviceBind(cfg, { deviceCode: "dc" }, {
    poll: async () => "gh-token",
    identity: fakeIdentity,
    fetchImpl: jsonFetch({ bound: true, provider: "github", login: "octocat", accountId: "42", avatarUrl: "https://a/42.png" }),
  });
  expect(res).toMatchObject({ bound: true, login: "octocat", avatarUrl: "https://a/42.png" });
  // written into the hermetic ~/.agentgem/binding.json and read back
  expect(readBindingStatus()).toMatchObject({ bound: true, login: "octocat", avatarUrl: "https://a/42.png" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `avatarUrl` not returned/persisted.

- [ ] **Step 3: Implement `bindCore.ts`**

`completeDeviceBind` — extend the return type (line 49), read `avatarUrl` from the response (line 60), write it into `binding.json` (lines 64-68), and include it in the return (line 69):

```ts
): Promise<{ bound: true; provider: string; login: string; accountId: string; avatarUrl?: string } | { bound: false; rejected: string }> {
```
```ts
  const out = (await res.json()) as { bound: boolean; provider?: string; login?: string; accountId?: string; avatarUrl?: string; rejected?: string };
```
```ts
  writeFileSync(
    bindingPath(),
    JSON.stringify({ provider: out.provider, login: out.login, accountId: out.accountId, avatarUrl: out.avatarUrl, boundAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  return { bound: true, provider: out.provider!, login: out.login!, accountId: out.accountId!, ...(out.avatarUrl ? { avatarUrl: out.avatarUrl } : {}) };
```

`readBindingStatus` (lines 72-80) — read `avatarUrl` from the file:

```ts
export function readBindingStatus(): { bound: boolean; login?: string; provider?: string; avatarUrl?: string } {
  try {
    if (!existsSync(bindingPath())) return { bound: false };
    const j = JSON.parse(readFileSync(bindingPath(), "utf8")) as { login?: string; provider?: string; avatarUrl?: string };
    return j.login ? { bound: true, login: j.login, provider: j.provider, ...(j.avatarUrl ? { avatarUrl: j.avatarUrl } : {}) } : { bound: false };
  } catch {
    return { bound: false };
  }
}
```

- [ ] **Step 4: Implement the schemas**

In `src/gem.controller.ts`: add `avatarUrl: z.string().optional()` to **both** `BindCompleteSchema` (the `z.object` ending with `rejected: z.string().optional(),` ~line 275-277) and `BindStatusSchema` (line 277).

In `packages/console/src/api/routes.ts`: add `avatarUrl: z.string().optional()` to the response objects of **both** `bindStatusRoute` (line 643) and `bindCompleteRoute` (line 653) — keeping them field-identical to the server.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test` then `pnpm --filter @agentgem/console typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/bind/bindCore.ts src/gem.controller.ts packages/console/src/api/routes.ts src/bind/__tests__/bindCore.test.ts
git commit -m "feat(bind): thread avatarUrl through binding.json + bind schemas"
```

---

### Task 4: Show the avatar in the Settings identity box

**Files:**
- Modify: `packages/console/src/panels/Settings/index.tsx` (`BindStatus` type line 10; `connectGitHub` setBindStatus line 60; the "Verified as" render lines 100-101)
- Test: `packages/console/src/panels/Settings/Settings.test.tsx` (extend)

**Interfaces:**
- Consumes: `bindStatusRoute` / `bindComplete` responses now carry `avatarUrl?` (Task 3).
- Produces: the "Verified as @login" line renders a small round avatar when `avatarUrl` is present; text-only otherwise.

- [ ] **Step 1: Write the failing test**

In `packages/console/src/panels/Settings/Settings.test.tsx`, follow the file's existing pattern for mocking `bindStatusRoute.call` (and `deployTargetsRoute`). Add:

```ts
it("renders the GitHub avatar when the binding has one", async () => {
  vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", avatarUrl: "https://a/bob.png" } as any);
  // (mock deployTargetsRoute.call as the existing tests do so the panel renders)
  render(<Settings apiBase="" />);
  const img = await screen.findByRole("img", { name: /bob/i });
  expect(img.getAttribute("src")).toBe("https://a/bob.png");
  expect(screen.getByText(/Verified as @bob/)).toBeInTheDocument();
});
it("falls back to text-only when the binding has no avatar", async () => {
  vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as any);
  render(<Settings apiBase="" />);
  await screen.findByText(/Verified as @bob/);
  expect(screen.queryByRole("img", { name: /bob/i })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console test`
Expected: FAIL — no avatar `<img>` rendered.

- [ ] **Step 3: Implement**

In `packages/console/src/panels/Settings/index.tsx`:

Type (line 10):
```ts
type BindStatus = { bound: boolean; login?: string; provider?: string; avatarUrl?: string } | null;
```

`connectGitHub` — carry avatar from the bindComplete result (line 60):
```ts
        setBindStatus({ bound: true, login: result.login, avatarUrl: result.avatarUrl });
```

The "Verified as" render (lines 100-101) — replace the bound-case paragraph:
```tsx
        {bindStatus === null ? null : bindStatus.bound ? (
          <p className="ws-note">
            {bindStatus.avatarUrl && (
              <img src={bindStatus.avatarUrl} alt={`@${bindStatus.login}`} width={20} height={20}
                   style={{ borderRadius: "50%", verticalAlign: "middle", marginRight: 6 }} />
            )}
            Verified as @{bindStatus.login}
          </p>
        ) : (
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agentgem/console test` then `pnpm --filter @agentgem/console typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Settings/index.tsx packages/console/src/panels/Settings/Settings.test.tsx
git commit -m "feat(console): show the GitHub avatar in the Settings identity box"
```

---

## Deployment note

The avatar only appears once the **hosted aggregator** (api.agentgem.ai) is redeployed with Tasks 1-2 (so `/api/aggregator/bind` actually returns `avatarUrl`). Until then the console gracefully shows text-only "Verified as @login". End-to-end testing locally works by pointing `AGENTGEM_AGGREGATOR_URL` at a local server running this build.

## Self-Review

- **Spec coverage:** verifier avatar → T1; `upsertAccount` reconciliation + `BindResult`/schema avatar → T2; binding.json + gem/console bind schemas → T3; Settings UI → T4. Best-effort/never-throw → T2 try/catch + optional fields throughout. CSP note (Part B): a plain `<img>` in the console shell; verify at implementation.
- **Placeholder scan:** every step has concrete code; the two "reuse the existing test harness" notes (binding.test.ts identity/signature setup, Settings.test.tsx mock pattern) name the exact file to read and give the full delta (fixtures + assertions).
- **Type consistency:** `avatarUrl?: string` (optional string) is the identical field name across `VerifiedAccount`, `BindResult`, `BindResultSchema`, `binding.json`, `completeDeviceBind`/`readBindingStatus`, `BindStatusSchema`/`BindCompleteSchema`, the client routes, and `BindStatus`. `upsertAccount`'s param is `avatarUrl?: string | null` — passed `acct.avatarUrl ?? null` (T2).
- **Never-throw/backward-compat:** `upsertAccount` wrapped in try/catch; all avatar fields optional; no-avatar path renders text-only exactly as today.
