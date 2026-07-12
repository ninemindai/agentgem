# Profile hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/@<handle>` a tabbed profile hub (Apps · Reviews · Orgs · Groups · Account) that absorbs `/account` and `/groups`, keeping handle-less users working via thin redirect-or-inline shims.

**Architecture:** Extract the signed-in bodies of `Account.tsx` and `Groups.tsx` into reusable `AccountPanel`/`GroupsPanel` components. `Profile.tsx` becomes tabbed (`?tab=` query param, `TeamUsage`-style) and renders those panels in owner-only tabs. `/account` + `/groups` become shims: redirect to the tab when the user has a handle, render the panel inline when handle-less, sign-in prompt when signed out. No backend change.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest + jsdom + `@testing-library/react`. Package `@agentgem/marketplace`. Spec: `docs/superpowers/specs/2026-07-12-profile-hub-design.md`.

## Global Constraints

- Package `@agentgem/marketplace`. Tests: `pnpm --filter @agentgem/marketplace test` (jsdom; gates CI). Single file: append the path. **Also run `pnpm --filter @agentgem/marketplace typecheck` before every commit — it MUST exit 0** (tsconfig sets `noUnusedLocals`+`noUnusedParameters`; vitest/esbuild does NOT typecheck). Build: `pnpm --filter @agentgem/marketplace build`.
- Run all test/build commands in the FOREGROUND and WAIT — never background them (the suite is fast).
- Marketplace source files have NO license header (match neighbors).
- Tabs: `?tab=<id>` via `useLocationSearch`/`navigate` from `../nav`, `.ex-tabs`/`.ex-tab.is-active`, `role="tablist"`/`role="tab"`/`aria-selected` — copied from `pages/TeamUsage.tsx:173-179`.
- Owner predicate everywhere: `!!(me?.handle && me.handle.toLowerCase() === login.toLowerCase())`.
- Reuse existing CSS classes (`ex-card`, `ex-tabs`, `ex-tab`, `ex-empty`, `ex-error`, `ex-signin`, `ex-chip`, `ex-profile*`, `ex-gem-*`, `ex-account-*`, `ex-org-chip*`). Do not invent a stylesheet.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Tab set (single source of truth for the plan)

| id | label | owner-only |
|----|-------|-----------|
| `apps` | Apps | no (default) |
| `reviews` | Reviews | no |
| `orgs` | Orgs | yes |
| `groups` | Groups | yes |
| `account` | Account | yes |

---

## Task 0: Worktree bootstrap (once)

**Files:** none.

- [ ] **Step 1: Install + build**

Run:
```bash
cd ../agentgem-worktrees/profile-hub
pnpm install
pnpm build
```
Expected: no errors.

- [ ] **Step 2: Baseline the marketplace suite**

Run: `pnpm --filter @agentgem/marketplace test`
Expected: all tests PASS (record the count). If anything fails, stop and report — not your change.

---

## Task 1: Extract `AccountPanel`; make `Account` a shim

**Files:**
- Modify: `packages/marketplace/src/pages/Account.tsx`
- Test: `packages/marketplace/src/pages/Account.test.tsx`

**Interfaces:**
- Produces: `AccountPanel({ api, me, base })` — the signed-in account UI (exported). `Account({ api, me, base })` — the route shim.

- [ ] **Step 1: Rename the component to `AccountPanel` and fix the query-strip**

In `Account.tsx`, rename the exported `export function Account(` to `export function AccountPanel(` (same signature, same body). Then fix ONE thing inside it — the one-shot query-param strip effect currently resets the URL to bare `pathname`, which would drop `?tab=account` when the panel renders inside the profile hub. Replace:

```tsx
  useEffect(() => {
    if (!collision && !connectStatus && !mergeNudgeHandle) return;
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }, []);
```

with a selective strip that removes only the one-shot keys and preserves the rest (e.g. `tab`):

```tsx
  useEffect(() => {
    if (!collision && !connectStatus && !mergeNudgeHandle) return;
    const qs = new URLSearchParams(window.location.search);
    for (const k of ["connect", "error", "merge", "handle"]) qs.delete(k);
    const rest = qs.toString();
    window.history.replaceState(window.history.state, "", window.location.pathname + (rest ? "?" + rest : ""));
  }, []);
```

- [ ] **Step 2: Add the `Account` shim at the bottom of the file**

Append below `AccountPanel`:

```tsx
/** Route wrapper: a signed-in user WITH a handle is redirected to their profile's Account tab
 *  (forwarding any one-shot query params like ?connect=ready from the OAuth return); a signed-in
 *  user with NO handle (a fresh Google account) has no /@handle URL, so the panel renders inline
 *  here; signed-out falls through to the panel's own sign-in prompt. */
export function Account({ api, me, base }: { api: ReturnType<typeof makeApi>; me: Me | null; base: string }) {
  useEffect(() => {
    if (!me?.handle) return;
    const qs = window.location.search ? "&" + window.location.search.slice(1) : "";
    navigate(`/@${encodeURIComponent(me.handle)}?tab=account${qs}`);
  }, [me]);
  if (me?.handle) return null;   // redirecting
  return <AccountPanel api={api} me={me} base={base} />;
}
```

Add the imports this shim needs to the top of the file: `navigate` from `../nav`, and `type makeApi` from `../api` (check the existing import block — `makeApi` type may already be imported; `navigate` is not). `useEffect` is already imported.

- [ ] **Step 3: Update the tests to target the panel + add shim tests**

In `Account.test.tsx`, the existing tests render `<Account .../>`. Change each existing render of `<Account` to `<AccountPanel` (import `AccountPanel` alongside `Account`), since those tests exercise the signed-in/handle-less behavior that now lives in the panel. Then ADD shim tests:

```tsx
  it("shim redirects a handle-having user to their Account tab, forwarding query params", () => {
    window.history.pushState({}, "", "/account?connect=ready");
    const nav = vi.fn();
    // spy on navigate: mock the ../nav module
    // (top of file: vi.mock("../nav", () => ({ navigate: (...a:any) => nav(...a), useLocationSearch: () => "" })))
    render(<Account api={{} as never} me={{ id: "1", name: "A", handle: "alice", avatarUrl: null, orgs: [] }} base="" />);
    expect(nav).toHaveBeenCalledWith("/@alice?tab=account&connect=ready");
  });

  it("shim renders the panel inline for a signed-in user with NO handle", () => {
    render(<Account api={{ getAccountProviders: () => Promise.resolve({ connected: [] }) } as never} me={{ id: "1", name: "A", handle: null, avatarUrl: null, orgs: [] }} base="" />);
    expect(screen.getByRole("heading", { name: /account/i })).toBeTruthy();
  });
```

> Implementer: match the file's existing harness (afterEach cleanup, how it stubs `getAccountProviders`/fetch). Put the `vi.mock("../nav", ...)` at the top of the file (hoisted). If `useLocationSearch` isn't used by Account, still provide it in the mock to avoid an undefined import. Ensure `window.history.pushState` state is reset in `afterEach` (add `window.history.pushState({}, "", "/")`).

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Account.test.tsx` → all pass. Then `pnpm --filter @agentgem/marketplace typecheck` → exit 0.

```bash
git add packages/marketplace/src/pages/Account.tsx packages/marketplace/src/pages/Account.test.tsx
git commit -m "refactor(marketplace): extract AccountPanel; /account becomes a profile-tab shim

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extract `GroupsPanel`; make `Groups` a shim

**Files:**
- Modify: `packages/marketplace/src/pages/Groups.tsx`
- Test: `packages/marketplace/src/pages/Groups.test.tsx`

**Interfaces:**
- Produces: `GroupsPanel({ me, base })` — the signed-in groups UI (exported). `Groups({ me, base })` — the route shim.

- [ ] **Step 1: Rename to `GroupsPanel` and fix the post-redeem navigate**

Rename `export function Groups(` to `export function GroupsPanel(`. Its `?join=` effect calls `navigate("/groups")` after redeeming, which is wrong inside the hub (would leave the profile). Replace the two `navigate("/groups")` calls in that effect with a strip that removes only `join`, keeping the current path + other params. Add this helper inside the component (above the effect):

```tsx
  const stripJoin = () => {
    const qs = new URLSearchParams(window.location.search);
    qs.delete("join");
    const rest = qs.toString();
    navigate(window.location.pathname + (rest ? "?" + rest : ""));
  };
```

and change the effect's two calls from `navigate("/groups")` to `stripJoin()`:

```tsx
    api.redeem(token)
      .then(() => { setJoined("You've joined the group."); stripJoin(); refresh(); })
      .catch((e) => { setErr(e instanceof Error ? e.message : String(e)); stripJoin(); refresh(); });
```

(This works at both `/groups?join=TOK` → `/groups` and `/@alice?tab=groups&join=TOK` → `/@alice?tab=groups`.)

- [ ] **Step 2: Add the `Groups` shim**

Append below `GroupsPanel`:

```tsx
/** Route wrapper: mirrors Account's shim — handle-having users go to their profile's Groups tab
 *  (forwarding query params so an invite /groups?join=<token> lands on /@handle?tab=groups&join=…);
 *  handle-less users get the panel inline; signed-out falls through to the panel's sign-in prompt. */
export function Groups({ me, base }: { me: Me | null; base: string }) {
  useEffect(() => {
    if (!me?.handle) return;
    const qs = window.location.search ? "&" + window.location.search.slice(1) : "";
    navigate(`/@${encodeURIComponent(me.handle)}?tab=groups${qs}`);
  }, [me]);
  if (me?.handle) return null;
  return <GroupsPanel me={me} base={base} />;
}
```

(`useEffect`, `navigate`, `Me` are already imported in this file.)

- [ ] **Step 3: Update tests to target the panel + add shim tests**

In `Groups.test.tsx`, change existing `<Groups .../>` renders to `<GroupsPanel .../>` (import both). Add:

```tsx
  it("shim redirects a handle-having user to their Groups tab, forwarding ?join", () => {
    window.history.pushState({}, "", "/groups?join=TOK");
    const nav = vi.fn();
    // vi.mock("../nav", () => ({ navigate: (...a:any)=>nav(...a), useLocationSearch: ()=>"" })) at top
    render(<Groups me={{ id:"1", name:"A", handle:"alice", avatarUrl:null, orgs:[] }} base="" />);
    expect(nav).toHaveBeenCalledWith("/@alice?tab=groups&join=TOK");
  });
  it("shim renders the panel inline for a signed-in user with NO handle", async () => {
    stubFetch({ "/api/catalog/groups": () => ({ body: { groups: [] } }) });   // reuse the file's stub helper
    render(<Groups me={{ id:"1", name:"A", handle:null, avatarUrl:null, orgs:[] }} base="http://x" />);
    expect(await screen.findByRole("heading", { name: /your groups/i })).toBeTruthy();
  });
```

> Implementer: because `GroupsPanel` uses `useLocationSearch` and `navigate` from `../nav`, the existing panel tests need the real `../nav` (not mocked) OR a mock that provides a working `useLocationSearch`. Simplest: do NOT global-mock `../nav` for the whole file; instead spy via `vi.spyOn` on the nav module for just the shim tests, or split the shim tests into their own `describe` with a scoped `vi.mock`. Match whatever keeps the existing panel tests green. Reset `window.history` in `afterEach`.

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Groups.test.tsx` → pass; `pnpm --filter @agentgem/marketplace typecheck` → 0.

```bash
git add packages/marketplace/src/pages/Groups.tsx packages/marketplace/src/pages/Groups.test.tsx
git commit -m "refactor(marketplace): extract GroupsPanel; /groups becomes a profile-tab shim

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Tab the Profile page (consumes both panels)

**Files:**
- Modify: `packages/marketplace/src/pages/Profile.tsx`
- Modify: `packages/marketplace/src/Router.tsx` (pass `base` to `<Profile>`)
- Test: `packages/marketplace/src/pages/Profile.test.tsx`

**Interfaces:**
- Consumes: `AccountPanel` (Task 1), `GroupsPanel` (Task 2).
- Produces: `Profile({ api, login, me, base })` — gains a required `base: string` prop.

- [ ] **Step 1: Rewrite `Profile.tsx` as a tabbed hub**

Add imports: `import { useLocationSearch, navigate } from "../nav";`, `import { AccountPanel } from "./Account";`, `import { GroupsPanel } from "./Groups";`. Change the signature to add `base` and rewrite the render. Full new component (keep the existing `View` type, the `useEffect` fetch, and the loading/notfound early returns unchanged):

```tsx
const TABS = [
  { id: "apps", label: "Apps", owner: false },
  { id: "reviews", label: "Reviews", owner: false },
  { id: "orgs", label: "Orgs", owner: true },
  { id: "groups", label: "Groups", owner: true },
  { id: "account", label: "Account", owner: true },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function Profile({ api, login, me, base }: { api: ReturnType<typeof makeApi>; login: string; me?: Me | null; base: string }) {
  const [view, setView] = useState<View>({ status: "loading" });
  const search = useLocationSearch();

  useEffect(() => {
    let alive = true;
    api.getProfile(login)
      .then((p) => { if (alive) setView(p ? { status: "ok", profile: p } : { status: "notfound" }); })
      .catch(() => { if (alive) setView({ status: "notfound" }); });
    return () => { alive = false; };
  }, [api, login]);

  const isOwner = !!(me?.handle && me.handle.toLowerCase() === login.toLowerCase());
  const requested = new URLSearchParams(search).get("tab") as TabId | null;
  const canSee = (t: (typeof TABS)[number]) => !t.owner || isOwner;
  const active: TabId = TABS.find((t) => t.id === requested && canSee(t)) ? (requested as TabId) : "apps";
  const setTab = (id: TabId) => navigate(`/@${encodeURIComponent(login)}?tab=${id}`);

  if (view.status === "loading") return <div className="ex-profile"><p className="ex-empty">Loading…</p></div>;
  if (view.status === "notfound") return <div className="ex-profile"><p className="ex-empty">No profile for @{login}.</p></div>;
  const p = view.profile;

  return (
    <div className="ex-profile">
      <header className="ex-profile-head">
        {p.avatarUrl && <img className="ex-avatar-lg" src={p.avatarUrl} alt="" width={64} height={64} />}
        <h2 className="ex-profile-login">
          {p.githubUrl ? <a href={p.githubUrl} target="_blank" rel="noreferrer">@{p.login}</a> : <span>@{p.login}</span>}
          {p.verified && <span className="ex-verified" title="Verified GitHub identity"> ✓ Verified</span>}
        </h2>
        <span className="ex-profile-stars">★ {p.totalStars}</span>
      </header>

      <div className="ex-tabs" role="tablist" aria-label="profile sections">
        {TABS.filter(canSee).map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === active}
            className={"ex-tab" + (t.id === active ? " is-active" : "")} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {active === "apps" && (
        p.gems.length === 0
          ? <p className="ex-empty">@{p.login} hasn't published any gems yet.</p>
          : <ul className="ex-gem-list">{p.gems.map((g) => (
              <li key={g.key} className="ex-gem-item">
                <a className="ex-gem-card" href={"/gems/" + encodeURIComponent(g.key)}>
                  <span className="ex-gem-head"><span className="ex-gem-key">{g.key}</span>
                    <StoneRating grade={g.grade ?? undefined} stars={g.stars} installs={g.installs} verifiedInstalls={g.verifiedInstalls} /></span>
                  {g.description && <span className="ex-gem-desc">{g.description}</span>}
                </a>
              </li>))}</ul>
      )}

      {active === "reviews" && (
        (p.reviews ?? []).length === 0
          ? <p className="ex-empty">No reviews written yet.</p>
          : <ul className="ex-reviews-list">{(p.reviews ?? []).map((r, i) => (
              <li key={r.sourceId + "/" + r.path + i} className="ex-review">
                <div className="ex-review-meta">
                  <a href={`/skills/${encodeURIComponent(r.sourceId)}/${r.path}`}>{r.name}</a>
                  <span className="ex-scope">{r.sourceId}</span>
                  <span className="ex-review-rating" aria-label={`${r.rating} of 5`}>{ratingStars(r.rating)}</span>
                  <time className="ex-review-date" dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleDateString()}</time>
                </div>
                {r.body && <p className="ex-review-body">{r.body}</p>}
              </li>))}</ul>
      )}

      {active === "orgs" && isOwner && (
        (me?.orgs.length ?? 0) === 0
          ? <p className="ex-empty">You're not in any orgs.</p>
          : <section className="ex-profile-orgs" aria-label="your orgs">
              <ul className="ex-org-chips">{me!.orgs.map((o) => (
                <li key={o.scope} className="ex-org-chip">
                  <a className="ex-org-chip-name" href={"/orgs/" + encodeURIComponent(o.scope)}>@{o.scope}</a>
                  {o.role === "admin" && <span className="ex-org-chip-role">admin</span>}
                  <a className="ex-org-chip-usage" href={`/orgs/${encodeURIComponent(o.scope)}/usage`}>Team Pulse →</a>
                </li>))}</ul>
            </section>
      )}

      {active === "groups" && isOwner && <GroupsPanel me={me!} base={base} />}
      {active === "account" && isOwner && <AccountPanel api={api} me={me!} base={base} />}
    </div>
  );
}
```

Keep the existing top-of-file imports (`useEffect`, `useState`, `makeApi` type, `Me`, `ProfileT`, `StoneRating`, `ratingStars`) and the `View` type.

- [ ] **Step 2: Pass `base` from the router**

In `src/Router.tsx`, the `profile` route renders `<Profile ... />`. Add `base={defaultApiBase()}`:

```tsx
  { id: "profile", kind: "profile", match: (p) => p.match(/^\/@([^/]+)$/), render: (m, c) => <Profile api={c.api} login={decodeURIComponent((m as RegExpMatchArray)[1])} me={c.me} base={defaultApiBase()} /> },
```

- [ ] **Step 3: Update `Profile.test.tsx` for tabs**

The existing tests render `<Profile api login />` (no `base`) and assert gems + reviews render inline. Under tabs: (a) add `base=""` to every `<Profile>` render; (b) the default tab is `apps`, so the gem-card and empty-gems tests still pass as-is; (c) the "Reviews written" test must activate the reviews tab first. Reviews now render under `?tab=reviews`; drive it by pushing the URL before render:

```tsx
  it("renders reviews under the Reviews tab, linking each to its /skill page", async () => {
    window.history.pushState({}, "", "/@octocat?tab=reviews");
    const withReviews = { ...full, reviews: [ { sourceId: "matt-skills", path: "productivity/brainstorming.md", name: "brainstorming", rating: 5, body: "a keeper", createdAt: "2026-07-02T00:00:00Z" } ] };
    render(<Profile api={apiWith(withReviews)} login="octocat" me={{ id:"1", name:"octocat", handle:"octocat", avatarUrl:null, orgs:[] }} base="" />);
    const link = await screen.findByText("brainstorming");
    expect(link.closest("a")?.getAttribute("href")).toBe("/skills/matt-skills/productivity/brainstorming.md");
  });
```

Add tab-visibility tests:
```tsx
  it("a non-owner viewer sees only Apps and Reviews tabs", async () => {
    render(<Profile api={apiWith(full)} login="octocat" me={{ id:"2", name:"bob", handle:"bob", avatarUrl:null, orgs:[] }} base="" />);
    await screen.findByRole("heading", { name: /octocat/ });
    expect(screen.getByRole("tab", { name: "Apps" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Reviews" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Account" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Groups" })).toBeNull();
  });
  it("the owner sees all five tabs", async () => {
    render(<Profile api={apiWith(full)} login="octocat" me={{ id:"1", name:"octocat", handle:"octocat", avatarUrl:null, orgs:[] }} base="" />);
    await screen.findByRole("heading", { name: /octocat/ });
    for (const t of ["Apps","Reviews","Orgs","Groups","Account"]) expect(screen.getByRole("tab", { name: t })).toBeTruthy();
  });
  it("a non-owner requesting ?tab=account falls back to Apps (no account controls)", async () => {
    window.history.pushState({}, "", "/@octocat?tab=account");
    render(<Profile api={apiWith(full)} login="octocat" me={{ id:"2", name:"bob", handle:"bob", avatarUrl:null, orgs:[] }} base="" />);
    await screen.findByRole("heading", { name: /octocat/ });
    expect(screen.getByRole("tab", { name: "Apps" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("heading", { name: /^account$/i })).toBeNull();
  });
```

Update the existing "own orgs" tests (the `Profile own-orgs navigation` describe): they must now push `?tab=orgs` before rendering (orgs are a tab) and add `base=""`. The "hides from other viewers / signed out" test becomes "the Orgs tab isn't offered to non-owners / signed-out" — assert `queryByRole("tab", { name: "Orgs" })` is null instead of the section. Keep `afterEach` resetting `window.history.pushState({}, "", "/")`.

> Implementer: `GroupsPanel`/`AccountPanel` self-fetch (`/api/catalog/groups`, `/api/account/providers`) when their tab is active. The owner tab-visibility test above renders on the default `apps` tab, so neither panel mounts and no fetch stub is needed. Only stub fetch if a test actually activates `?tab=groups`/`?tab=account`.

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Profile.test.tsx src/Router.conformance.test.tsx` → pass; `pnpm --filter @agentgem/marketplace typecheck` → 0.

```bash
git add packages/marketplace/src/pages/Profile.tsx packages/marketplace/src/Router.tsx packages/marketplace/src/pages/Profile.test.tsx
git commit -m "feat(marketplace): tabbed /@handle profile hub (Apps/Reviews/Orgs/Groups/Account)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Retarget the nav links

**Files:**
- Modify: `packages/marketplace/src/App.tsx`
- Test: `packages/marketplace/src/App.test.tsx`

**Interfaces:** none new.

- [ ] **Step 1: Point the Account + Groups nav links at the tabs**

In `App.tsx`, the signed-in nav has `<a href="/account">Account</a>` and `<a href="/groups" ...>Groups</a>`. Retarget both to the profile tab when `me.handle` exists, else the shim path. Add near the other `on*` consts:

```tsx
  const accountHref = me?.handle ? `/@${encodeURIComponent(me.handle)}?tab=account` : "/account";
  const groupsHref = me?.handle ? `/@${encodeURIComponent(me.handle)}?tab=groups` : "/groups";
```

Change the two links to use these hrefs (keep the existing `IconGroups`/class/`is-active` shape for Groups; the Account link keeps its existing class):

```tsx
  {me && <a className="ex-navlink" href={accountHref}>Account</a>}
  {me && <a href={groupsHref} className={"ex-navlink" + (path.startsWith("/groups") ? " is-active" : "")}><IconGroups />Groups</a>}
```

(The Account nav link was previously unconditional-in-the-signed-in-block; keep whatever `me &&` gating it had.) Leave the profile chip (`/@handle`) as-is.

- [ ] **Step 2: Update `App.test.tsx`**

Read `App.test.tsx`. If it asserts the Account/Groups nav hrefs for a signed-in user, update those assertions to the new `/@<handle>?tab=…` targets (for a `me` with a handle) and, if it stubs a handle-less `me`, assert the fallback `/account`·`/groups`. If it doesn't assert these hrefs, add one test: a signed-in user with handle "alice" has an Account nav link with href `/@alice?tab=account` and a Groups nav link with `/@alice?tab=groups`. Match the file's existing `auth.getMe` stub harness.

- [ ] **Step 3: Verify + commit**

Run: `pnpm --filter @agentgem/marketplace test src/App.test.tsx` → pass; `pnpm --filter @agentgem/marketplace typecheck` → 0.

```bash
git add packages/marketplace/src/App.tsx packages/marketplace/src/App.test.tsx
git commit -m "feat(marketplace): point Account + Groups nav links at profile tabs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full gate + PR

**Files:** none.

- [ ] **Step 1: Full marketplace gate**

Run (FOREGROUND, each in turn):
```bash
pnpm --filter @agentgem/marketplace test
pnpm --filter @agentgem/marketplace typecheck
pnpm --filter @agentgem/marketplace build
```
Expected: all three succeed (test count = Task 0 baseline + net new; no regressions).

- [ ] **Step 2: Commit nothing new; open the PR** (controller may take this step)

```bash
git push -u origin profile-hub
gh pr create --title "feat: /@handle tabbed profile hub (absorbs /account + /groups)" --body "$(cat <<'EOF'
Consolidates the user's surfaces into a tabbed /@<handle> hub: Apps · Reviews · Orgs · Groups · Account.

- AccountPanel / GroupsPanel extracted from the /account and /groups pages
- /account + /groups become shims: redirect to the tab when you have a handle, render inline for handle-less users (fresh Google accounts), sign-in prompt when signed out
- tabs are a ?tab= query param (TeamUsage-style); Apps+Reviews public, Orgs+Groups+Account owner-only
- nav Account/Groups links retargeted to the tabs; no backend change

Spec: docs/superpowers/specs/2026-07-12-profile-hub-design.md
Plan: docs/superpowers/plans/2026-07-12-profile-hub.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Tabbed `/@handle` (§A/§B) → Task 3. ✓
- Public/owner tab split + owner-only fallback → Task 3 (tests included). ✓
- `?tab=` query param, no route-shape change → Task 3; conformance asserted. ✓
- `AccountPanel`/`GroupsPanel` extraction (§C) + selective query-strip fixes → Tasks 1, 2. ✓
- `/account` + `/groups` shims, handle-less inline (§D) → Tasks 1, 2 (shim tests). ✓
- Nav retarget (§E) → Task 4. ✓
- No backend change (§F) → nothing touches `src/`. ✓
- Tests (§G) → each task. ✓

**Placeholder scan:** Tasks 1-4 delegate the exact test-harness plumbing (how `../nav` is mocked/spied, existing `auth.getMe`/fetch stubs) to "the file's existing harness" — the assertions are concrete; only the mocking mechanics follow repo convention. All component/shim/profile code is complete.

**Type consistency:** `AccountPanel({api,me,base})`, `GroupsPanel({me,base})`, `Account`/`Groups` shims same signatures as their panels, `Profile` gains exactly `base: string`. `TabId`/`TABS`/`isOwner`/`active`/`setTab` defined and used consistently in Task 3.
