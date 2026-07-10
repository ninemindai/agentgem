# Google Sign-In (First Slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can sign in to app.agentgem.ai with Google and land authenticated, the same way GitHub works today; Google accounts are separate from GitHub, and a login-less user claims a handle lazily at first publish.

**Architecture:** Google is a built-in `better-auth/social-providers` entry (zero new deps), added to `makeAuth` only when its creds are present. The re-key already anchors any provider on a uuid with a NULL login, so a Google account is a first-class identity with no handle until claimed. The session is extended to expose `handle`, and the marketplace SPA is re-keyed to treat identity as `uuid + optional handle` instead of assuming `login` always exists.

**Tech Stack:** better-auth 1.6.23, drizzle + PGlite (tests), React (marketplace SPA), TypeScript ESM.

## Global Constraints

- **Zero new dependencies.** Google is in the already-installed `better-auth/social-providers`. Do not add packages.
- **Google scopes are exactly `["openid", "email", "profile"]`** — non-sensitive, no Google verification review.
- **`mapProfileToUser` for Google maps `name` + `image` only — never a `login`.** Google has no username; the re-key writes a NULL-login anchor for non-GitHub providers.
- **Separate accounts.** No `linkSocial`, no account merging. GitHub and Google for one person are two accounts.
- **Lazy handle claim.** Do not prompt for a handle at sign-in. The claim form appears only inside Publish, for a signed-in user with no handle.
- **Google is additive.** The existing `if (ghClientId && ghSecret && webOrigins.length > 0 && aggDb)` guard in `src/index.ts` is UNCHANGED — GitHub still gates auth existence. Google is added *inside* `socialProviders` only when both `AGENTGEM_GOOGLE_CLIENT_ID` and `AGENTGEM_GOOGLE_CLIENT_SECRET` are set.
- **Node >= 24; ESM; `.js` import specifiers** in `packages/aggregator` and `src/`.
- **Backend tests run against compiled `dist/`.** `pnpm exec tsc -b` then `pnpm exec vitest run dist/aggregator/__tests__/<file>.test.js`. A `src/*.ts` vitest path matches nothing. Aggregator store lives in `packages/aggregator/src/`; its tests live at repo-root `src/aggregator/__tests__/` importing `@agentgem/aggregator`.
- **Marketplace tests run over `src/` via the package's own vitest (jsdom), NOT dist:** `pnpm -C packages/marketplace exec vitest run src/<file>.test.tsx`. Marketplace tests are NOT in CI — run them locally.
- **`ensureSchema` is the sole DDL authority** (no drizzle-kit). `handle` is already a column on `"user"` (added by the re-key) — this plan adds NO new columns.
- **A stray `consoleMount` failure under a full `pnpm test`** is a pre-existing harness quirk on `main`, unrelated to this work.
- **Manual prerequisite already done:** OAuth client `94243720748-gbh3thj2bl5ebfupirithro1psup2ve4.apps.googleusercontent.com` created; `AGENTGEM_GOOGLE_CLIENT_ID`/`AGENTGEM_GOOGLE_CLIENT_SECRET` set on Fly (`agentgem-api`). To confirm at smoke-test: redirect URI is exactly `https://api.agentgem.ai/api/auth/callback/google`, consent screen is External + Published.

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `packages/aggregator/src/auth/betterAuth.ts` | modify | Add `handle` to session `additionalFields`; add optional Google provider |
| `src/index.ts` | modify | Read Google env, pass to `makeAuth` |
| `src/aggregator/__tests__/betterAuth.test.ts` | modify | makeAuth: Google present iff creds |
| `src/aggregator/__tests__/betterAuthIntegration.test.ts` | modify | Session exposes handle; Google anchor is NULL-login, no auto-claim |
| `packages/marketplace/src/auth.ts` | modify | `Me` re-keyed off `login`; `getMe` returns login-less users; `signIn(provider, returnTo)` |
| `packages/marketplace/src/auth.test.ts` | create | Unit tests for `getMe`/`signIn` |
| `packages/marketplace/src/App.tsx` | modify | Chip shows `name` + conditional `/@handle`; Google button; `signIn(provider)` |
| `packages/marketplace/src/App.test.tsx` | modify | Chip + Google button tests |
| `packages/marketplace/src/HandleClaim.tsx` | create | Handle-claim form (POST /api/handle) |
| `packages/marketplace/src/HandleClaim.test.tsx` | create | Claim form 200/400/409 behavior |
| `packages/marketplace/src/pages/Publish.tsx` | modify | Lazy gate: show `HandleClaim` when `me && !me.handle` |

**Deliberate deviation from the spec:** the spec named "publish **or their own profile**" as the lazy-claim trigger. A handle-less user cannot reach their own profile — with no handle there is no `/@handle` URL, and the chip (Task 6) renders no profile link for them. The Profile gate would be dead code, so this plan puts the gate in **Publish only**. Publish is discoverable: the Publish nav item shows for any signed-in user.

---

## Task 1: Session exposes `handle` (prove first)

This is the load-bearing integration point. Every SPA task depends on the client being able to read `handle` off the session. Prove it before touching the SPA.

**Files:**
- Modify: `packages/aggregator/src/auth/betterAuth.ts:72`
- Test: `src/aggregator/__tests__/betterAuthIntegration.test.ts`

**Interfaces:**
- Consumes: `makeAuth`, `mintSession`, `claimHandle`, `makeTestDb` from `@agentgem/aggregator`; the test's existing `createGithubUser` helper.
- Produces: `get-session`'s `user` object now carries `handle: string | null`.

- [ ] **Step 1: Write the failing test**

Add to `src/aggregator/__tests__/betterAuthIntegration.test.ts` inside the top-level `describe`. `claimHandle` is already imported there; confirm the import line includes it (it does after the re-key).

```ts
  it("get-session exposes the account's handle — null before a claim, set after", async () => {
    stubGithubMembershipsFetch();
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts });
    const { user } = await createGithubUser(db, auth, "neo", "neo@example.com");
    // A GitHub sign-in auto-claims handle=login. NULL it to model a login-less (Google) account,
    // so this test proves BOTH states of the field, not just the happy one.
    await db.execute(sql`update "user" set handle = null where id = ${user.id}`);
    const { token } = await mintSession(auth, user.id);

    const before = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    expect((before as { user?: { handle?: string | null } })?.user?.handle ?? null).toBeNull();

    await claimHandle(db, user.id, "neo");
    const after = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    expect((after as { user?: { handle?: string | null } })?.user?.handle).toBe("neo");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/betterAuthIntegration.test.js -t "exposes the account"`
Expected: FAIL — `after.user.handle` is `undefined` (not `"neo"`), because `handle` is not in `additionalFields` yet.

- [ ] **Step 3: Add `handle` to `additionalFields`**

`packages/aggregator/src/auth/betterAuth.ts:72` — change:

```ts
    user: { additionalFields: { login: { type: "string", required: false } } },
```

to:

```ts
    user: { additionalFields: {
      login: { type: "string", required: false },
      // The re-key made `handle` a column on "user" (the account's public name; NULL until claimed).
      // Surfacing it here lets the SPA tell a handle-less account (a fresh Google user) from a named
      // one, which is what gates the lazy handle-claim flow. additionalFields reads the column
      // directly — no query change.
      handle: { type: "string", required: false },
    } },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/betterAuthIntegration.test.js -t "exposes the account"`
Expected: PASS.

- [ ] **Step 5: Prove the test is discriminating (mutation)**

Temporarily revert Step 3 (remove the `handle` additionalField), rebuild, re-run: the test must FAIL. Restore Step 3, rebuild, re-run: PASS. This confirms the test actually pins the field, not something incidental.

- [ ] **Step 6: Commit**

```bash
git add packages/aggregator/src/auth/betterAuth.ts src/aggregator/__tests__/betterAuthIntegration.test.ts
git commit -m "feat(auth): expose handle in the session for the lazy handle-claim gate"
```

---

## Task 2: Google provider in `makeAuth` + env wiring

**Files:**
- Modify: `packages/aggregator/src/auth/betterAuth.ts` (opts type ~line 18-21; `socialProviders` ~line 73-79)
- Modify: `src/index.ts` (env reads ~line 214; `makeAuth({...})` call ~line 224-232)
- Test: `src/aggregator/__tests__/betterAuth.test.ts`

**Interfaces:**
- Consumes: `makeAuth` from `@agentgem/aggregator`.
- Produces: `makeAuth` accepts optional `googleClientId?: string; googleClientSecret?: string`. When both are truthy, `auth.options.socialProviders` includes `google`.

- [ ] **Step 1: Write the failing test**

Add to `src/aggregator/__tests__/betterAuth.test.ts` (it already constructs `makeAuth` with `opts`; reuse that `opts`).

```ts
  it("registers Google iff both Google creds are supplied; GitHub is unaffected", async () => {
    const db = await makeTestDb();
    const withGoogle = makeAuth({ db, ...opts, googleClientId: "gid", googleClientSecret: "gsec" });
    const provWith = Object.keys((withGoogle.options.socialProviders ?? {}) as Record<string, unknown>).sort();
    expect(provWith).toEqual(["github", "google"]);

    const noGoogle = makeAuth({ db, ...opts });
    const provNone = Object.keys((noGoogle.options.socialProviders ?? {}) as Record<string, unknown>);
    expect(provNone).toEqual(["github"]);

    // one cred without the other must NOT register google (fail closed on partial config)
    const partial = makeAuth({ db, ...opts, googleClientId: "gid" });
    expect(Object.keys((partial.options.socialProviders ?? {}) as Record<string, unknown>)).toEqual(["github"]);
  });
```

> Note: better-auth's returned auth object exposes the resolved config at `auth.options`. If `auth.options` is `undefined` under 1.6.23, read it via the context instead: `(await withGoogle.$context).options.socialProviders`. Use whichever is defined; do not change the assertion.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsc -b`
Expected: FAIL to compile — `googleClientId` is not on the `makeAuth` opts type.

- [ ] **Step 3: Add the optional opts and the conditional provider**

`packages/aggregator/src/auth/betterAuth.ts` — widen the opts type (~line 18-21):

```ts
export function makeAuth(opts: {
  db: AppDb; secret: string; baseURL: string; githubClientId: string; githubClientSecret: string;
  googleClientId?: string; googleClientSecret?: string;
  webOrigins: string[]; cookieDomain?: string;
}): Auth<BetterAuthOptions> {
```

And the `socialProviders` block (~line 73-79) — add Google conditionally:

```ts
    socialProviders: {
      github: {
        clientId: opts.githubClientId, clientSecret: opts.githubClientSecret,
        scope: ["read:user", "read:org"],
        mapProfileToUser: (p: any) => ({ login: p.login, name: p.name ?? p.login, image: p.avatar_url }),
      },
      // Google is additive and optional — registered only when BOTH creds are present (a partial
      // config registers nothing, failing closed). Non-sensitive scopes only. Google supplies no
      // username, so mapProfileToUser sets name + image and NO login; the re-key's anchorAndScopes
      // writes a NULL-login accounts anchor for any non-github provider, and the handle stays NULL
      // until the user claims one.
      ...(opts.googleClientId && opts.googleClientSecret ? {
        google: {
          clientId: opts.googleClientId, clientSecret: opts.googleClientSecret,
          scope: ["openid", "email", "profile"],
          mapProfileToUser: (p: any) => ({ name: p.name ?? p.email, image: p.picture }),
        },
      } : {}),
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/betterAuth.test.js -t "registers Google"`
Expected: PASS.

- [ ] **Step 5: Wire the env into `src/index.ts`**

`src/index.ts` — after the GitHub cred reads (~line 214-215), add:

```ts
  const googleClientId = process.env.AGENTGEM_GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.AGENTGEM_GOOGLE_CLIENT_SECRET;
```

And inside the existing `makeAuth({...})` call (~line 224-232), add the two optional args next to the GitHub pair — the surrounding `if (ghClientId && ghSecret && …)` guard is UNCHANGED:

```ts
    auth = makeAuth({
      db: aggDb,
      secret: process.env.AGENTGEM_SESSION_SECRET ?? ghSecret,
      baseURL: `${process.env.AGENTGEM_PUBLIC_BASE ?? "https://api.agentgem.ai"}/api/auth`,
      githubClientId: ghClientId,
      githubClientSecret: ghSecret,
      googleClientId,
      googleClientSecret,
      webOrigins,
      cookieDomain: process.env.AGENTGEM_SESSION_COOKIE_DOMAIN,
    });
```

- [ ] **Step 6: Rebuild to confirm the wiring compiles**

Run: `pnpm exec tsc -b`
Expected: exit 0. (The `index.ts` wiring is config plumbing; the provider logic is covered by Step 4's test, and the live behavior is confirmed at the deploy smoke-test, exactly as the GitHub creds are.)

- [ ] **Step 7: Commit**

```bash
git add packages/aggregator/src/auth/betterAuth.ts src/index.ts src/aggregator/__tests__/betterAuth.test.ts
git commit -m "feat(auth): optional Google social provider, wired from AGENTGEM_GOOGLE_CLIENT_*"
```

---

## Task 3: Google account anchors on a uuid with NULL login, no handle auto-claim

Proves a Google sign-in produces a first-class identity: an `accounts` anchor with NULL login, no auto-claimed handle, and a satisfiable uuid FK (so the user's first star doesn't 500).

**Files:**
- Test: `src/aggregator/__tests__/betterAuthIntegration.test.ts`

**Interfaces:**
- Consumes: the test's existing `createNonGithubUser(db, auth, providerId, email)` helper (drives the real `account.create` hook for a non-github provider).

- [ ] **Step 1: Write the failing test**

Add to `src/aggregator/__tests__/betterAuthIntegration.test.ts`:

```ts
  it("a Google account.create anchors a NULL-login account, auto-claims NO handle, and satisfies the uuid FK", async () => {
    const db = await makeTestDb();
    const auth = makeAuth({ db, ...opts, googleClientId: "gid", googleClientSecret: "gsec" });
    const { user } = await createNonGithubUser(db, auth, "google", "trinity@gmail.com");

    const anchor = (await db.execute(sql`select id, provider, login from accounts where id = ${user.id}`))
      .rows as { id: string; provider: string; login: string | null }[];
    expect(anchor).toHaveLength(1);
    expect(anchor[0]).toMatchObject({ provider: "google", login: null });

    // Non-github ⇒ no handle auto-claim (only a GitHub login seeds a handle for free).
    const handleRow = (await db.execute(sql`select handle from "user" where id = ${user.id}`))
      .rows as { handle: string | null }[];
    expect(handleRow[0].handle).toBeNull();

    // The uuid anchor actually satisfies one of the ten accounts.id FKs — the user's first star
    // (or review/group) must not 500.
    await db.execute(sql`insert into stars (id, account_id, target_kind, target_id)
                         values (${crypto.randomUUID()}, ${user.id}, 'gem', '@a/b')`);
    const starN = (await db.execute(sql`select count(*)::int as n from stars where account_id = ${user.id}`))
      .rows as { n: number }[];
    expect(starN[0].n).toBe(1);
  });
```

- [ ] **Step 2: Run the test**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/aggregator/__tests__/betterAuthIntegration.test.js -t "Google account.create anchors"`
Expected: **PASS immediately.** The re-key's `anchorAndScopes` already handles any non-github provider (NULL login, no handle, uuid anchor). This test is a regression guard proving Google specifically works — no production code change is expected. If it FAILS, `anchorAndScopes` regressed and must be fixed before proceeding.

- [ ] **Step 3: Commit**

```bash
git add src/aggregator/__tests__/betterAuthIntegration.test.ts
git commit -m "test(auth): pin that a Google account anchors NULL-login, no handle, uuid FK satisfiable"
```

---

## Task 4: SPA identity re-keyed off `login`

`Me` becomes uuid + optional handle. `getMe` stops returning `null` for a login-less (Google) session — the reason a Google user currently would not appear signed in.

**Files:**
- Modify: `packages/marketplace/src/auth.ts` (`Me` interface line 3; `getMe` lines 7-20)
- Test: `packages/marketplace/src/auth.test.ts` (create)

**Interfaces:**
- Consumes: `get-session` now returns `user.handle` (Task 1).
- Produces: `interface Me { id: string; name: string; handle: string | null; avatarUrl: string | null; orgs: MyOrg[] }`. `getMe(): Promise<Me | null>` returns a `Me` whenever the session has a `user.id`.

- [ ] **Step 1: Write the failing test**

Create `packages/marketplace/src/auth.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeAuth } from "./auth";

const res = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body } as unknown as Response);

afterEach(() => vi.unstubAllGlobals());

describe("getMe", () => {
  it("returns a Me for a login-less (Google) session — id present, login absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      res({ user: { id: "uuid-1", name: "Ray Feng", handle: null, login: undefined, image: "http://a/x.png" }, orgs: [] })));
    const me = await makeAuth("https://api.x").getMe();
    expect(me).toEqual({ id: "uuid-1", name: "Ray Feng", handle: null, avatarUrl: "http://a/x.png", orgs: [] });
  });

  it("keeps a GitHub user's handle from their login-backed handle field", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      res({ user: { id: "uuid-2", name: "octocat", handle: "octocat", login: "octocat", image: null }, orgs: [{ scope: "ninemind", role: "admin" }] })));
    const me = await makeAuth("https://api.x").getMe();
    expect(me).toMatchObject({ id: "uuid-2", name: "octocat", handle: "octocat", orgs: [{ scope: "ninemind", role: "admin" }] });
  });

  it("returns null when there is no session (no user id)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(null)));
    expect(await makeAuth("https://api.x").getMe()).toBeNull();
  });

  it("returns null on a non-2xx get-session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(null, false, 500)));
    expect(await makeAuth("https://api.x").getMe()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/marketplace exec vitest run src/auth.test.ts`
Expected: FAIL — current `Me` has no `id`/`name`/`handle`, and `getMe` returns `null` for the login-less case (it gates on `login`).

- [ ] **Step 3: Re-key `Me` and `getMe`**

`packages/marketplace/src/auth.ts` — replace the `Me` interface (line 3):

```ts
export interface Me { id: string; name: string; handle: string | null; avatarUrl: string | null; orgs: MyOrg[] }
```

Replace `getMe` (lines 7-20):

```ts
    async getMe(): Promise<Me | null> {
      try {
        const r = await fetch(base + "/api/auth/get-session", { credentials: "include" });
        if (!r.ok) return null;
        // Identity is the uuid + an OPTIONAL handle, never `login`: a Google user has no login and
        // no handle until they claim one, but they ARE signed in. Gate on `user.id`, not `login`.
        // `handle` falls back to `login` so an existing GitHub user's /@ profile link keeps working
        // even if their handle column is somehow unset; `name` falls back to login then "".
        const j = (await r.json()) as {
          user?: { id?: string; name?: string; login?: string; handle?: string | null; image?: string | null };
          orgs?: MyOrg[];
        } | null;
        const u = j?.user;
        if (!u?.id) return null;
        return {
          id: u.id,
          name: u.name ?? u.login ?? "",
          handle: u.handle ?? u.login ?? null,
          avatarUrl: u.image ?? null,
          orgs: j?.orgs ?? [],
        };
      } catch { return null; }
    },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C packages/marketplace exec vitest run src/auth.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/auth.ts packages/marketplace/src/auth.test.ts
git commit -m "feat(marketplace): key identity on uuid + optional handle, not login"
```

---

## Task 5: `signIn(provider)` + Google button

**Files:**
- Modify: `packages/marketplace/src/auth.ts` (`signIn`, lines 30-41)
- Modify: `packages/marketplace/src/App.tsx` (`signIn` wrapper line 47-50; the sign-in link line 82)
- Test: `packages/marketplace/src/auth.test.ts` (extend); `packages/marketplace/src/App.test.tsx` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `signIn(provider: "github" | "google", returnTo: string): Promise<void>`. App-level `signIn(provider?: "github" | "google")` wrapper defaulting to `"github"` (so existing zero-arg callers stay on GitHub).

- [ ] **Step 1: Write the failing tests**

Append to `packages/marketplace/src/auth.test.ts`:

```ts
describe("signIn", () => {
  it("POSTs sign-in/social with the given provider and follows the returned url", async () => {
    let body: string | undefined;
    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => {
      body = o?.body as string;
      return res({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc", redirect: true });
    }));
    await makeAuth("https://api.x").signIn("google", "https://app.x/gems");
    expect(JSON.parse(body!)).toEqual({ provider: "google", callbackURL: "https://app.x/gems" });
    expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
  });
});
```

Add to `packages/marketplace/src/App.test.tsx` (mirror the existing GitHub sign-in test at line 97):

```ts
  it("shows a Sign in with Google link that POSTs sign-in/social with the google provider", async () => {
    let signInBody: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (u: string, o?: RequestInit) => {
      if (u.includes("/api/auth/get-session")) return res(null);
      if (u.includes("/api/auth/sign-in/social")) { signInBody = o?.body as string; return res({ url: "https://accounts.google.com/o?state=abc", redirect: true }); }
      if (u.includes("/popular-skills")) return res({ skills: [], groups: [] });
      return res([]);
    }));
    render(<App />);
    const link = await screen.findByRole("link", { name: /sign in with google/i });
    fireEvent.click(link);
    await waitFor(() => expect(signInBody && JSON.parse(signInBody)).toMatchObject({ provider: "google" }));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C packages/marketplace exec vitest run src/auth.test.ts src/App.test.tsx`
Expected: FAIL — `signIn` takes one arg (returnTo) today; no "Sign in with Google" link exists.

- [ ] **Step 3: Parameterize `signIn` in `auth.ts`**

`packages/marketplace/src/auth.ts` — replace `signIn` (lines 30-41):

```ts
    async signIn(provider: "github" | "google", returnTo: string): Promise<void> {
      const r = await fetch(base + "/api/auth/sign-in/social", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, callbackURL: returnTo }),
      });
      if (!r.ok) throw new Error(`sign-in failed (${r.status})`);
      const j = (await r.json()) as { url?: string };
      if (!j.url) throw new Error("sign-in response had no redirect url");
      window.location.assign(j.url);
    },
```

- [ ] **Step 4: Update `App.tsx` — wrapper + Google button**

`packages/marketplace/src/App.tsx` — the `signIn` wrapper (lines 47-50), add a defaulted `provider` param so existing zero-arg callers (`stars.loginUrl`, `reviews.loginUrl`, prompts) stay on GitHub:

```ts
  const signIn = (provider: "github" | "google" = "github") => {
    setSignInError(null);
    auth.signIn(provider, window.location.href).catch((err) => setSignInError(err instanceof Error ? err.message : String(err)));
  };
```

Replace the single sign-in link (line 82) with two buttons:

```tsx
            <>
              <a className="ex-signin" href="#" onClick={(e) => { e.preventDefault(); signIn("github"); }}>Sign in with GitHub</a>
              <a className="ex-signin" href="#" onClick={(e) => { e.preventDefault(); signIn("google"); }}>Sign in with Google</a>
            </>
```

(The `me ? (...) : (...)` ternary's else-branch becomes this fragment. The existing GitHub test at line 97 still passes — it clicks the GitHub link by its accessible name.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm -C packages/marketplace exec vitest run src/auth.test.ts src/App.test.tsx`
Expected: PASS — including the pre-existing GitHub sign-in test (unchanged behavior).

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/src/auth.ts packages/marketplace/src/App.tsx packages/marketplace/src/auth.test.ts packages/marketplace/src/App.test.tsx
git commit -m "feat(marketplace): parameterize signIn by provider; add Sign in with Google"
```

---

## Task 6: Chip shows `name` + conditional `/@handle` link

A handle-less user must not render a broken `/@` link. Show the display name always; link to `/@handle` only when a handle exists.

**Files:**
- Modify: `packages/marketplace/src/App.tsx` (the authed chip, lines 74-78)
- Test: `packages/marketplace/src/App.test.tsx` (extend)

**Interfaces:**
- Consumes: `Me.handle` (Task 4), `Me.name`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/marketplace/src/App.test.tsx`:

```ts
  it("chip: a handle-less (Google) user shows their name and NO profile link", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/auth/get-session")) return res({ user: { id: "u1", name: "Ray Feng", handle: null, image: null }, orgs: [] });
      if (u.includes("/popular-skills")) return res({ skills: [], groups: [] });
      return res([]);
    }));
    render(<App />);
    expect(await screen.findByText("Ray Feng")).toBeTruthy();
    // no /@ profile link anywhere in the header
    expect(screen.queryByRole("link", { name: "Ray Feng" })).toBeNull();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeTruthy();
  });

  it("chip: a handled user's name links to their /@handle profile", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (u.includes("/api/auth/get-session")) return res({ user: { id: "u2", name: "octocat", handle: "octocat", image: null }, orgs: [] });
      if (u.includes("/popular-skills")) return res({ skills: [], groups: [] });
      return res([]);
    }));
    render(<App />);
    const link = await screen.findByRole("link", { name: "octocat" });
    expect(link.getAttribute("href")).toBe("/@octocat");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C packages/marketplace exec vitest run src/App.test.tsx`
Expected: FAIL — the chip currently always renders `<a href={/@${me.login}}>` and `me.login` is now undefined.

- [ ] **Step 3: Make the chip conditional**

`packages/marketplace/src/App.tsx` — replace the authed identity block (lines 74-78, the `<a className="ex-me" …>` and its contents inside the `me ? (…)` branch):

```tsx
              {me.handle ? (
                <a className="ex-me" href={`/@${me.handle}`} title="Your profile">
                  {me.avatarUrl && <img className="ex-avatar" src={me.avatarUrl} alt="" width={20} height={20} />}
                  <span className="ex-login">{me.name}</span>
                </a>
              ) : (
                <span className="ex-me" title="Claim a handle from Publish to get a profile page">
                  {me.avatarUrl && <img className="ex-avatar" src={me.avatarUrl} alt="" width={20} height={20} />}
                  <span className="ex-login">{me.name}</span>
                </span>
              )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C packages/marketplace exec vitest run src/App.test.tsx`
Expected: PASS. Also re-run the existing "shows the login + Sign out when authenticated" test (line 111) — update its stub if it asserts `/@octocat`: it sends `user: { login: "octocat", image: null }`; add `handle: "octocat"` so the profile link still renders. Confirm that test passes.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/App.tsx packages/marketplace/src/App.test.tsx
git commit -m "feat(marketplace): chip shows name; profile link only when a handle exists"
```

---

## Task 7: `HandleClaim` form + lazy gate in Publish

**Files:**
- Create: `packages/marketplace/src/HandleClaim.tsx`
- Create: `packages/marketplace/src/HandleClaim.test.tsx`
- Modify: `packages/marketplace/src/pages/Publish.tsx` (the `if (!me)` block ~lines 16-27; the `scope` default ~line 9)

**Interfaces:**
- Consumes: `Me.handle` (Task 4); `POST /api/handle` returning 200 `{handle}` / 400 (charset) / 409 (taken-or-reserved). CORS + credentials handled by the route (`src/handles/install.ts`).
- Produces: `<HandleClaim base={string} onClaimed={() => void} />`.

- [ ] **Step 1: Write the failing test**

Create `packages/marketplace/src/HandleClaim.test.tsx`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { HandleClaim } from "./HandleClaim";

const res = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body } as unknown as Response);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("HandleClaim", () => {
  it("posts the handle and calls onClaimed on 200", async () => {
    let body: string | undefined;
    const onClaimed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => { body = o?.body as string; return res({ handle: "ray" }); }));
    render(<HandleClaim base="https://api.x" onClaimed={onClaimed} />);
    fireEvent.change(screen.getByLabelText("handle"), { target: { value: "ray" } });
    fireEvent.click(screen.getByRole("button", { name: /claim/i }));
    await waitFor(() => expect(onClaimed).toHaveBeenCalled());
    expect(JSON.parse(body!)).toEqual({ handle: "ray" });
  });

  it("shows a charset message on 400 and does not call onClaimed", async () => {
    const onClaimed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "bad" }, false, 400)));
    render(<HandleClaim base="https://api.x" onClaimed={onClaimed} />);
    fireEvent.change(screen.getByLabelText("handle"), { target: { value: "bad name" } });
    fireEvent.click(screen.getByRole("button", { name: /claim/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/letters, numbers/i);
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it("shows a taken/reserved message on 409", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "nope" }, false, 409)));
    render(<HandleClaim base="https://api.x" onClaimed={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("handle"), { target: { value: "ninemind" } });
    fireEvent.click(screen.getByRole("button", { name: /claim/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/taken or reserved/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C packages/marketplace exec vitest run src/HandleClaim.test.tsx`
Expected: FAIL — `HandleClaim` does not exist.

- [ ] **Step 3: Create the component**

Create `packages/marketplace/src/HandleClaim.tsx`:

```tsx
import { useState } from "react";

/** Claim a public handle. POSTs to /api/handle (credentialed, cross-origin CORS handled by the
 *  route). The handle names the account; it authorizes nothing. On success the caller refetches the
 *  session so the new handle propagates to the chip and the publish scope. */
export function HandleClaim({ base, onClaimed }: { base: string; onClaimed: () => void }) {
  const [handle, setHandle] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(base + "/api/handle", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle }),
      });
      if (r.ok) { onClaimed(); return; }
      if (r.status === 400) setMsg("Handles use letters, numbers, and hyphens only (1–39 characters).");
      else if (r.status === 409) setMsg("That handle is taken or reserved. Try another.");
      else setMsg(`Could not claim handle (${r.status}).`);
    } catch {
      setMsg("Network error — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="ex-card" onSubmit={submit}>
      <p>Claim a handle to publish and get a profile page at <code>/@your-handle</code>.</p>
      <input aria-label="handle" placeholder="your-handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
      <button type="submit" disabled={busy || handle.trim().length === 0}>Claim</button>
      {msg && <p className="ex-error" role="alert">{msg}</p>}
    </form>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C packages/marketplace exec vitest run src/HandleClaim.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Gate Publish on a handle**

`packages/marketplace/src/pages/Publish.tsx` — add the import at the top:

```ts
import { HandleClaim } from "../HandleClaim";
```

Change the `scope` default (line 9) — a Google user has no login; default the publish scope to their handle:

```ts
  const [scope, setScope] = useState(me?.handle ?? "");
```

After the existing `if (!me) { … }` block (which returns the sign-in prompt), add the handle gate before the publish form:

```tsx
  if (!me.handle) {
    // Lazy claim: a signed-in user with no handle (a fresh Google account) cannot publish until they
    // pick a public name. Refetch the session on success so `me.handle` (and the scope default) fill in.
    return (
      <div className="ex-card">
        <HandleClaim base={base} onClaimed={() => { window.location.reload(); }} />
      </div>
    );
  }
```

> `window.location.reload()` is the simplest correct refresh — `me` is fetched once in `App.tsx`'s effect, and a reload re-runs `getMe` so the new handle reaches the chip and the publish form. A prop-drilled `refetch` callback would be tidier but is not worth the wiring for this slice.

- [ ] **Step 6: Run the marketplace suite**

Run: `pnpm -C packages/marketplace exec vitest run`
Expected: PASS across the marketplace package (Publish has no existing test that asserts the handle-less branch; confirm nothing regressed).

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/src/HandleClaim.tsx packages/marketplace/src/HandleClaim.test.tsx packages/marketplace/src/pages/Publish.tsx
git commit -m "feat(marketplace): lazy handle-claim form, gated in Publish"
```

---

## Final verification (after all tasks)

- [ ] **Backend full build + suite:** `pnpm clean && pnpm test`. Expected: green except the known pre-existing `consoleMount` failure (also fails on `main`). If any OTHER test fails, investigate before finishing.
- [ ] **Marketplace suite:** `pnpm -C packages/marketplace exec vitest run`. Expected: all green (marketplace is not in CI, so this local run is the gate).
- [ ] **Typecheck the marketplace:** `pnpm -C packages/marketplace exec tsc --noEmit`. Expected: exit 0 (the `Me` shape changed; confirm no consumer of `me.login` outside the files touched here still references the removed field).
- [ ] **Grep for stragglers:** `grep -rn "me\.login\|\.login" packages/marketplace/src --include=*.tsx --include=*.ts | grep -v test` — expected: no remaining reads of `me.login` in non-test code (all should now read `me.handle` or `me.name`).

## Deploy + smoke-test (after merge)

1. The Fly secrets are already set. On merge to `main`, the Fly deploy picks up the code that now reads them, and `socialProviders.google` registers.
2. **Verify the two silent-failure points** (from the spec): the Google client's redirect URI is exactly `https://api.agentgem.ai/api/auth/callback/google`, and the consent screen is External + Published.
3. Browser smoke-test, mirroring the GitHub one: click "Sign in with Google" → Google consent → back to app.agentgem.ai → `GET /api/auth/get-session` returns a `user` with `login: null`, `handle: null`, a uuid `id`. The chip shows the Google display name with no `/@` link. Click Publish → the `HandleClaim` form appears → claim a handle → the chip's `/@handle` link appears and publishing is unblocked.
