# Group-shared gems — Frontend Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose group management and gem-sharing in the `app.agentgem.ai` marketplace SPA: create/list groups, invite + join, a per-group "shared apps" view, and an owner "Share with groups" control on the gem page.

**Architecture:** A new `makeGroups(base)` HTTP client (mirrors `stars.ts`) that calls the Plan 1 backend endpoints. Two new pages (`Groups` panel at `/groups`, `GroupDetail` collection at `/groups/:id`), a join flow folded into the Groups panel via `?join=<token>`, an owner share-control section added to the existing `Gem` page, and a signed-in "Groups" nav link. All wired through the hand-rolled `ROUTES` table.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest + jsdom + `@testing-library/react`. Package: `@agentgem/marketplace`. Depends on the Plan 1 backend endpoints (already implemented on branch `group-shared-gems` / PR #358).

## Global Constraints

- Package is `@agentgem/marketplace`. Run its tests with `pnpm --filter @agentgem/marketplace test` (vitest+jsdom, **gates CI** at `.github/workflows/ci.yml`). Typecheck: `pnpm --filter @agentgem/marketplace typecheck`. Build: `pnpm --filter @agentgem/marketplace build`.
- Marketplace source files have **NO license header** (match neighbors like `pages/Publish.tsx`). Do not add one.
- ESM/TS. Client mirrors `src/stars.ts`: `makeGroups(base)` factory, every call `credentials: "include"`, `401 → throw NotSignedIn` (import `NotSignedIn` from `./stars`).
- Pages are function components. A page needing auth gates on `me` and renders the sign-in prompt EXACTLY like `pages/Publish.tsx:17-28` (both GitHub and Google, via `makeAuth(base).signIn(...)`). `Me` type is `{ id, name, handle, avatarUrl, orgs }`.
- Navigation: render plain `<a href="/...">` (App's global click interceptor turns same-origin clicks into `navigate()`); for programmatic navigation import `navigate` from `./nav`. Read query params reactively with `useLocationSearch()` from `./nav`.
- A new route MUST be added to `ROUTES` in `src/Router.tsx` AND classified: collections in `COLLECTIONS` (plural, matches `/s$/`), panels' ids in `PANELS`. The suite `src/Router.conformance.test.tsx` enforces this.
- Reuse existing CSS classes (`ex-card`, `ex-signin`, `ex-error`, `ex-empty`, `ex-search`, `ex-chip`, `ex-navlink`) — do not invent a stylesheet.
- Do NOT value-import from `@agentgem/play` (breaks `pnpm build`); type-only imports are fine. This plan needs neither.
- Tests: `@testing-library/react` (`render`, `screen`, `fireEvent`, `waitFor`, `cleanup`), `afterEach(() => { cleanup(); vi.unstubAllGlobals(); })`, stub network with `vi.stubGlobal("fetch", vi.fn(...))`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Backend endpoint contract (from Plan 1 — the client targets these)

- `GET /api/catalog/groups` → `{ groups: {id,kind,installationId,scope,name,role}[] }` · `POST {name}` → `{ group:{id,kind,installationId,scope,name} }` · `DELETE ?id=` → `{ deleted:true }`
- `GET /api/catalog/group-members?id=` → `{ members: {accountId,login,avatarUrl,role,viaSync,viaInvite}[] }` · `DELETE ?id=&account=` → `{ removed:true }`
- `GET /api/catalog/group-invites?id=` → `{ invites: {id,role,expiresAt,revokedAt}[] }` · `POST ?id=` body `{role?,ttlDays?}` → `{ id, token, expiresAt }` (token shown ONCE) · `DELETE ?id=&invite=` → `{ revoked:true }`
- `POST /api/catalog/group-invite-redeem` body `{token}` → `{ joined:true }` (404 not-found, 410 gone)
- `GET /api/catalog/gem-shares?key=` → `{ shares: {groupId,name}[] }` · `POST {key,groupId}` → `{ shared:true }` (403 not in group, 404 not owner) · `DELETE ?key=&groupId=` → `{ removed:boolean }`
- `GET /api/catalog/group-gems?id=` → `{ gems: {gemKey,version,description,artifactKinds,installable}[] }`

---

## Task 0: Worktree bootstrap (once)

**Files:** none.

- [ ] **Step 1: Install + build sibling dists**

Fresh worktree; `@agentgem/marketplace` resolves sibling workspace packages that must be built once.

Run:
```bash
cd ../agentgem-worktrees/group-shared-gems-fe
pnpm install
pnpm build
```
Expected: completes with no errors.

- [ ] **Step 2: Baseline the marketplace suite**

Run: `pnpm --filter @agentgem/marketplace test`
Expected: all tests PASS (the pre-change baseline — ~273+ tests). If anything fails here, stop and report; it is not your change.

---

## Task 1: `makeGroups` client + types + tests

**Files:**
- Create: `packages/marketplace/src/groups.ts`
- Test: `packages/marketplace/src/groups.test.ts`

**Interfaces:**
- Consumes: `NotSignedIn` from `./stars`.
- Produces: `makeGroups(base: string)` returning an object with these methods, plus the exported types `GroupSummary`, `GroupMember`, `GroupInvite`, `GroupGem`, `GemShareRef`, `GroupRole`.

- [ ] **Step 1: Write the client**

Create `packages/marketplace/src/groups.ts`:

```ts
// Group + gem-sharing client. Credentialed so the parent-domain session cookie travels; every
// write 401s when signed out (NotSignedIn), mirroring stars.ts.
import { NotSignedIn } from "./stars";

export type GroupRole = "admin" | "member";
export interface GroupSummary { id: string; kind: string; installationId: number | null; scope: string | null; name: string; role: GroupRole }
export interface GroupMember { accountId: string; login: string | null; avatarUrl: string | null; role: GroupRole; viaSync: boolean; viaInvite: boolean }
export interface GroupInvite { id: string; role: GroupRole; expiresAt: string; revokedAt: string | null }
export interface MintedInvite { id: string; token: string; expiresAt: string }
export interface GroupGem { gemKey: string; version: string; description: string; artifactKinds: string[]; installable: boolean }
export interface GemShareRef { groupId: string; name: string }

async function jsonOrThrow<T>(r: Response, what: string): Promise<T> {
  if (r.status === 401) throw new NotSignedIn();
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `${what} -> ${r.status}`);
  }
  return (await r.json()) as T;
}
const q = (o: Record<string, string>) => "?" + new URLSearchParams(o).toString();

export function makeGroups(base: string) {
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const del = (path: string) => fetch(base + path, { method: "DELETE", credentials: "include" });
  const getc = (path: string) => fetch(base + path, { credentials: "include" });
  return {
    list: async (): Promise<GroupSummary[]> => (await jsonOrThrow<{ groups: GroupSummary[] }>(await getc("/api/catalog/groups"), "groups")).groups,
    create: async (name: string): Promise<GroupSummary> => (await jsonOrThrow<{ group: GroupSummary }>(await post("/api/catalog/groups", { name }), "create group")).group,
    remove: async (id: string): Promise<void> => { await jsonOrThrow(await del("/api/catalog/groups" + q({ id })), "delete group"); },
    members: async (id: string): Promise<GroupMember[]> => (await jsonOrThrow<{ members: GroupMember[] }>(await getc("/api/catalog/group-members" + q({ id })), "members")).members,
    removeMember: async (id: string, account: string): Promise<void> => { await jsonOrThrow(await del("/api/catalog/group-members" + q({ id, account })), "remove member"); },
    invites: async (id: string): Promise<GroupInvite[]> => (await jsonOrThrow<{ invites: GroupInvite[] }>(await getc("/api/catalog/group-invites" + q({ id })), "invites")).invites,
    createInvite: async (id: string, opts: { role?: GroupRole; ttlDays?: number } = {}): Promise<MintedInvite> =>
      jsonOrThrow<MintedInvite>(await post("/api/catalog/group-invites" + q({ id }), opts), "mint invite"),
    revokeInvite: async (id: string, invite: string): Promise<void> => { await jsonOrThrow(await del("/api/catalog/group-invites" + q({ id, invite })), "revoke invite"); },
    redeem: async (token: string): Promise<void> => { await jsonOrThrow(await post("/api/catalog/group-invite-redeem", { token }), "join group"); },
    groupGems: async (id: string): Promise<GroupGem[]> => (await jsonOrThrow<{ gems: GroupGem[] }>(await getc("/api/catalog/group-gems" + q({ id })), "group gems")).gems,
    listGemShares: async (key: string): Promise<GemShareRef[]> => (await jsonOrThrow<{ shares: GemShareRef[] }>(await getc("/api/catalog/gem-shares" + q({ key })), "gem shares")).shares,
    shareGem: async (key: string, groupId: string): Promise<void> => { await jsonOrThrow(await post("/api/catalog/gem-shares", { key, groupId }), "share gem"); },
    unshareGem: async (key: string, groupId: string): Promise<void> => { await jsonOrThrow(await del("/api/catalog/gem-shares" + q({ key, groupId })), "unshare gem"); },
  };
}
```

- [ ] **Step 2: Write the tests**

Create `packages/marketplace/src/groups.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeGroups } from "./groups";
import { NotSignedIn } from "./stars";

afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const { status = 200, body = {} } = handler(url, init);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }));
}

describe("makeGroups", () => {
  it("list returns the groups array and sends credentials", async () => {
    const seen: RequestInit[] = [];
    stub((url, init) => { seen.push(init ?? {}); return { body: { groups: [{ id: "g1", name: "Team", role: "admin", kind: "native", installationId: null, scope: null }] } }; });
    const groups = await makeGroups("http://x").list();
    expect(groups[0]).toMatchObject({ id: "g1", name: "Team", role: "admin" });
    expect(seen[0].credentials).toBe("include");
  });

  it("create posts the name and returns the group", async () => {
    let sentBody: any;
    stub((_url, init) => { sentBody = JSON.parse(String(init?.body)); return { body: { group: { id: "g2", name: "Friends", role: "admin", kind: "native", installationId: null, scope: null } } }; });
    const g = await makeGroups("http://x").create("Friends");
    expect(sentBody).toEqual({ name: "Friends" });
    expect(g.name).toBe("Friends");
  });

  it("throws NotSignedIn on 401", async () => {
    stub(() => ({ status: 401 }));
    await expect(makeGroups("http://x").list()).rejects.toBeInstanceOf(NotSignedIn);
  });

  it("surfaces the server error message on non-401 failure", async () => {
    stub(() => ({ status: 400, body: { error: "name required (1-80 chars)" } }));
    await expect(makeGroups("http://x").create("")).rejects.toThrow(/name required/);
  });

  it("createInvite posts to the id-scoped URL and returns the one-time token", async () => {
    let url = "";
    stub((u) => { url = u; return { body: { id: "i1", token: "SECRET", expiresAt: "2026-07-18T00:00:00.000Z" } }; });
    const inv = await makeGroups("http://x").createInvite("g1", { role: "member" });
    expect(url).toContain("/api/catalog/group-invites?id=g1");
    expect(inv.token).toBe("SECRET");
  });

  it("groupGems returns the shared-apps list", async () => {
    stub(() => ({ body: { gems: [{ gemKey: "o/app", version: "1.0.0", description: "hi", artifactKinds: ["game"], installable: true }] } }));
    const gems = await makeGroups("http://x").groupGems("g1");
    expect(gems[0].gemKey).toBe("o/app");
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `pnpm --filter @agentgem/marketplace test src/groups.test.ts`
Expected: all 6 PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/marketplace/src/groups.ts packages/marketplace/src/groups.test.ts
git commit -m "feat(marketplace): makeGroups client for groups + gem-sharing endpoints

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `Groups` page (`/groups`) — list, create, join

**Files:**
- Create: `packages/marketplace/src/pages/Groups.tsx`
- Modify: `packages/marketplace/src/Router.tsx` (import; add panel route; add `"groups"` to `PANELS`)
- Test: `packages/marketplace/src/pages/Groups.test.tsx`

**Interfaces:**
- Consumes: `makeGroups` (Task 1), `Me` from `../auth`, `makeAuth` from `../auth`, `useLocationSearch`/`navigate` from `../nav`.
- Produces: `Groups({ me, base })` panel component; a `ROUTES` entry `{ id: "groups", kind: "panel" }`.

- [ ] **Step 1: Write the page**

Create `packages/marketplace/src/pages/Groups.tsx`:

```tsx
import { useEffect, useState, useCallback } from "react";
import { makeAuth, type Me } from "../auth";
import { makeGroups, type GroupSummary } from "../groups";
import { useLocationSearch, navigate } from "../nav";

export function Groups({ me, base }: { me: Me | null; base: string }) {
  const api = makeGroups(base);
  const search = useLocationSearch();
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);

  const refresh = useCallback(() => { api.list().then(setGroups).catch((e) => setErr(String(e instanceof Error ? e.message : e))); }, [base]);

  // Invite links land here as /groups?join=<token>. Redeem once, then strip the param and refresh.
  useEffect(() => {
    if (!me) return;
    const token = new URLSearchParams(search).get("join");
    if (!token) { refresh(); return; }
    api.redeem(token)
      .then(() => { setJoined("You've joined the group."); navigate("/groups"); refresh(); })
      .catch((e) => { setErr(e instanceof Error ? e.message : String(e)); navigate("/groups"); refresh(); });
  }, [me, search]);

  if (!me) {
    const signIn = (p: "github" | "google") => makeAuth(base).signIn(p, window.location.href).catch((e) => setErr(String(e)));
    return (
      <div className="ex-card">
        <p>Sign in to create and manage groups. <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("github"); }}>Sign in with GitHub</a> <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("google"); }}>Sign in with Google</a></p>
        {err && <p className="ex-error">{err}</p>}
      </div>
    );
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setErr(null);
    try { await api.create(name.trim()); setName(""); refresh(); }
    catch (e2) { setErr(e2 instanceof Error ? e2.message : String(e2)); }
    finally { setBusy(false); }
  };

  return (
    <div className="ex-card">
      <h2>Your groups</h2>
      {joined && <p className="ex-empty" style={{ color: "var(--verified)" }}>{joined}</p>}
      {err && <p className="ex-error">{err}</p>}
      <form onSubmit={create} style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <input aria-label="group name" className="ex-search" style={{ margin: 0 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="New group name" />
        <button type="submit" className="ex-signin" disabled={busy}>{busy ? "Creating…" : "Create group"}</button>
      </form>
      {groups === null ? <p className="ex-empty">Loading…</p>
        : groups.length === 0 ? <p className="ex-empty">You're not in any groups yet. Create one above.</p>
        : (
          <ul className="ex-groups" style={{ listStyle: "none", padding: 0 }}>
            {groups.map((g) => (
              <li key={g.id} style={{ padding: "6px 0" }}>
                <a href={"/groups/" + encodeURIComponent(g.id)}>{g.name}</a> <span className="ex-chip">{g.role}</span>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the route + classification**

In `src/Router.tsx`: add the import `import { Groups } from "./pages/Groups";`. Add this route to `ROUTES` alongside the other panels (after the `sources` panel):

```tsx
  { id: "groups", kind: "panel", match: (p) => p === "/groups", render: (_m, c) => <Groups me={c.me} base={defaultApiBase()} /> },
```

Add `"groups"` to the `PANELS` array:

```tsx
export const PANELS = ["publish", "account", "sources", "groups"];
```

- [ ] **Step 3: Write the tests**

Create `packages/marketplace/src/pages/Groups.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Groups } from "./Groups";

const me = { id: "1", name: "Alice", handle: "alice", avatarUrl: null, orgs: [] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { window.history.pushState({}, "", "/groups"); });

function stubFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body?: unknown }>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://x").pathname;
    const h = routes[path] ?? (() => ({ body: {} }));
    const { status = 200, body = {} } = h(init);
    return { ok: status < 300, status, json: async () => body } as unknown as Response;
  }));
}

describe("Groups page", () => {
  it("prompts sign-in when signed out", () => {
    render(<Groups me={null} base="http://x" />);
    expect(screen.getByText(/sign in to create and manage groups/i)).toBeTruthy();
  });

  it("lists the signed-in user's groups", async () => {
    stubFetch({ "/api/catalog/groups": () => ({ body: { groups: [{ id: "g1", name: "Team", role: "admin", kind: "native", installationId: null, scope: null }] } }) });
    render(<Groups me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText("Team")).toBeTruthy());
  });

  it("creates a group and refreshes the list", async () => {
    let created = false;
    stubFetch({
      "/api/catalog/groups": (init) => {
        if (init?.method === "POST") { created = true; return { body: { group: { id: "g2", name: "Friends", role: "admin", kind: "native", installationId: null, scope: null } } }; }
        return { body: { groups: created ? [{ id: "g2", name: "Friends", role: "admin", kind: "native", installationId: null, scope: null }] : [] } };
      },
    });
    render(<Groups me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText(/not in any groups yet/i)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/group name/i), { target: { value: "Friends" } });
    fireEvent.click(screen.getByText(/create group/i));
    await waitFor(() => expect(screen.getByText("Friends")).toBeTruthy());
  });

  it("redeems an invite from ?join=<token> and shows a confirmation", async () => {
    window.history.pushState({}, "", "/groups?join=TOK");
    let redeemed = false;
    stubFetch({
      "/api/catalog/group-invite-redeem": () => { redeemed = true; return { body: { joined: true } }; },
      "/api/catalog/groups": () => ({ body: { groups: [] } }),
    });
    render(<Groups me={me} base="http://x" />);
    await waitFor(() => expect(redeemed).toBe(true));
    await waitFor(() => expect(screen.getByText(/you've joined the group/i)).toBeTruthy());
  });
});
```

- [ ] **Step 4: Run the tests + conformance**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Groups.test.tsx src/Router.conformance.test.tsx`
Expected: all PASS (Groups' 4 + conformance green with the new panel).

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/pages/Groups.tsx packages/marketplace/src/Router.tsx packages/marketplace/src/pages/Groups.test.tsx
git commit -m "feat(marketplace): /groups page — list, create, join-via-token

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `GroupDetail` page (`/groups/:id`) — members, invites, shared apps, delete

**Files:**
- Create: `packages/marketplace/src/pages/GroupDetail.tsx`
- Modify: `packages/marketplace/src/Router.tsx` (import; add collection route; add `"groups"` to `COLLECTIONS`)
- Test: `packages/marketplace/src/pages/GroupDetail.test.tsx`

**Interfaces:**
- Consumes: `makeGroups` + its types (Task 1), `Me`, `navigate`.
- Produces: `GroupDetail({ id, me, base })`; a `ROUTES` collection entry `{ id: "group-detail", kind: "collection", collection: "groups" }`.

- [ ] **Step 1: Write the page**

Create `packages/marketplace/src/pages/GroupDetail.tsx`:

```tsx
import { useEffect, useState, useCallback } from "react";
import { makeAuth, type Me } from "../auth";
import { makeGroups, type GroupMember, type GroupInvite, type GroupGem, type MintedInvite } from "../groups";
import { navigate } from "../nav";

export function GroupDetail({ id, me, base }: { id: string; me: Me | null; base: string }) {
  const api = makeGroups(base);
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [invites, setInvites] = useState<GroupInvite[] | null>(null);
  const [gems, setGems] = useState<GroupGem[] | null>(null);
  const [minted, setMinted] = useState<MintedInvite | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const iAmAdmin = (members ?? []).find((m) => m.accountId === me?.id)?.role === "admin";

  const load = useCallback(() => {
    api.members(id)
      .then((m) => { setMembers(m); setGems(null); api.groupGems(id).then(setGems).catch(() => setGems([])); api.invites(id).then(setInvites).catch(() => setInvites(null)); })
      .catch((e) => { if (String(e).includes("404")) setNotFound(true); else setErr(e instanceof Error ? e.message : String(e)); });
  }, [id, base]);

  useEffect(() => { if (me) load(); }, [me, id]);

  if (!me) {
    const signIn = (p: "github" | "google") => makeAuth(base).signIn(p, window.location.href).catch((e) => setErr(String(e)));
    return <div className="ex-card"><p>Sign in to view this group. <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("github"); }}>Sign in with GitHub</a></p>{err && <p className="ex-error">{err}</p>}</div>;
  }
  if (notFound) return <div className="ex-card"><p className="ex-empty">Group not found, or you're not a member.</p></div>;
  if (members === null) return <div className="ex-card"><p className="ex-empty">Loading…</p></div>;

  const mint = async () => { setErr(null); try { setMinted(await api.createInvite(id, { role: "member" })); api.invites(id).then(setInvites).catch(() => {}); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const revoke = async (inviteId: string) => { try { await api.revokeInvite(id, inviteId); api.invites(id).then(setInvites).catch(() => {}); } catch (e) { setErr(String(e)); } };
  const remove = async (account: string) => { try { await api.removeMember(id, account); load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const del = async () => { if (!window.confirm("Delete this group? This can't be undone.")) return; try { await api.remove(id); navigate("/groups"); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const inviteLink = minted ? `${window.location.origin}/groups?join=${encodeURIComponent(minted.token)}` : "";

  return (
    <div className="ex-card">
      <h2>Group</h2>
      {err && <p className="ex-error">{err}</p>}

      <h3>Members</h3>
      <ul className="ex-members" style={{ listStyle: "none", padding: 0 }}>
        {members.map((m) => (
          <li key={m.accountId} style={{ padding: "4px 0" }}>
            {m.login ?? "user"} <span className="ex-chip">{m.role}</span>
            {iAmAdmin && m.accountId !== me.id && <button type="button" className="ex-copy" onClick={() => remove(m.accountId)}>Remove</button>}
          </li>
        ))}
      </ul>

      {iAmAdmin && (
        <section>
          <h3>Invites</h3>
          <button type="button" className="ex-signin" onClick={mint}>Create invite link</button>
          {minted && (
            <p className="ex-empty">Share this link (shown once): <code className="ex-key">{inviteLink}</code></p>
          )}
          <ul style={{ listStyle: "none", padding: 0 }}>
            {(invites ?? []).filter((i) => !i.revokedAt).map((i) => (
              <li key={i.id} style={{ padding: "4px 0" }}>Invite {i.id.slice(0, 8)} <span className="ex-chip">{i.role}</span> <button type="button" className="ex-copy" onClick={() => revoke(i.id)}>Revoke</button></li>
            ))}
          </ul>
        </section>
      )}

      <h3>Apps shared with this group</h3>
      {gems === null ? <p className="ex-empty">Loading…</p>
        : gems.length === 0 ? <p className="ex-empty">No apps shared with this group yet.</p>
        : (
          <ul className="ex-shared-gems" style={{ listStyle: "none", padding: 0 }}>
            {gems.map((g) => (
              <li key={g.gemKey} style={{ padding: "4px 0" }}><a href={"/gems/" + encodeURIComponent(g.gemKey)}>{g.gemKey}</a> <span className="ex-gem-version">v{g.version}</span></li>
            ))}
          </ul>
        )}

      {iAmAdmin && (
        <section className="ex-card ex-danger" style={{ marginTop: 16 }}>
          <h3>Danger zone</h3>
          <button type="button" className="ex-unpublish" onClick={del}>Delete group</button>
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the route + classification**

In `src/Router.tsx`: add `import { GroupDetail } from "./pages/GroupDetail";`. Add this route with the other collections, and it MUST come before any broader `/groups` matcher (there is none — the `groups` panel is an exact `p === "/groups"` match, so ordering is safe):

```tsx
  { id: "group-detail", kind: "collection", collection: "groups", match: (p) => p.match(/^\/groups\/([^/]+)$/), render: (m, c) => <GroupDetail id={decodeURIComponent((m as RegExpMatchArray)[1])} me={c.me} base={defaultApiBase()} /> },
```

Add `"groups"` to `COLLECTIONS`:

```tsx
export const COLLECTIONS = ["games", "gems", "ingredients", "skills", "orgs", "groups"];
```

- [ ] **Step 3: Write the tests**

Create `packages/marketplace/src/pages/GroupDetail.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { GroupDetail } from "./GroupDetail";

const me = { id: "u-admin", name: "Alice", handle: "alice", avatarUrl: null, orgs: [] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body?: unknown }>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://x").pathname;
    const h = routes[path] ?? (() => ({ body: {} }));
    const { status = 200, body = {} } = h(init);
    return { ok: status < 300, status, json: async () => body } as unknown as Response;
  }));
}
const adminMembers = { body: { members: [{ accountId: "u-admin", login: "alice", avatarUrl: null, role: "admin", viaSync: false, viaInvite: true }] } };

describe("GroupDetail page", () => {
  it("shows 'not found' on a 404 members response (no-leak)", async () => {
    stubFetch({ "/api/catalog/group-members": () => ({ status: 404, body: { error: "group not found" } }) });
    render(<GroupDetail id="g1" me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText(/group not found, or you're not a member/i)).toBeTruthy());
  });

  it("renders members, shared apps, and (for an admin) invite + danger controls", async () => {
    stubFetch({
      "/api/catalog/group-members": () => adminMembers,
      "/api/catalog/group-invites": () => ({ body: { invites: [] } }),
      "/api/catalog/group-gems": () => ({ body: { gems: [{ gemKey: "alice/app", version: "1.2.0", description: "", artifactKinds: ["game"], installable: true }] } }),
    });
    render(<GroupDetail id="g1" me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText("alice")).toBeTruthy());
    expect(screen.getByText("alice/app")).toBeTruthy();
    expect(screen.getByText(/create invite link/i)).toBeTruthy();
    expect(screen.getByText(/delete group/i)).toBeTruthy();
  });

  it("mints an invite and shows the one-time join link", async () => {
    stubFetch({
      "/api/catalog/group-members": () => adminMembers,
      "/api/catalog/group-invites": (init) => init?.method === "POST" ? ({ body: { id: "i1", token: "TOK123", expiresAt: "2026-07-18T00:00:00.000Z" } }) : ({ body: { invites: [] } }),
      "/api/catalog/group-gems": () => ({ body: { gems: [] } }),
    });
    render(<GroupDetail id="g1" me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText(/create invite link/i)).toBeTruthy());
    fireEvent.click(screen.getByText(/create invite link/i));
    await waitFor(() => expect(screen.getByText(/\/groups\?join=TOK123/)).toBeTruthy());
  });

  it("hides admin controls for a plain member", async () => {
    stubFetch({
      "/api/catalog/group-members": () => ({ body: { members: [{ accountId: "u-admin", login: "alice", avatarUrl: null, role: "member", viaSync: false, viaInvite: true }] } }),
      "/api/catalog/group-invites": () => ({ status: 403, body: { error: "group admin required" } }),
      "/api/catalog/group-gems": () => ({ body: { gems: [] } }),
    });
    render(<GroupDetail id="g1" me={me} base="http://x" />);
    await waitFor(() => expect(screen.getByText("alice")).toBeTruthy());
    expect(screen.queryByText(/create invite link/i)).toBeNull();
    expect(screen.queryByText(/delete group/i)).toBeNull();
  });
});
```

- [ ] **Step 4: Run the tests + conformance**

Run: `pnpm --filter @agentgem/marketplace test src/pages/GroupDetail.test.tsx src/Router.conformance.test.tsx`
Expected: GroupDetail's 4 + conformance PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/pages/GroupDetail.tsx packages/marketplace/src/Router.tsx packages/marketplace/src/pages/GroupDetail.test.tsx
git commit -m "feat(marketplace): /groups/:id — members, invites, shared apps, delete

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Owner "Share with groups" control on the gem page

**Files:**
- Modify: `packages/marketplace/src/pages/Gem.tsx` (add a `base` prop; add an owner-only share section)
- Modify: `packages/marketplace/src/Router.tsx` (pass `base={defaultApiBase()}` to `<Gem …>`)
- Test: `packages/marketplace/src/pages/Gem.test.tsx` (append)

**Interfaces:**
- Consumes: `makeGroups` (Task 1). `Gem` already computes `isOwner` (`Gem.tsx:90`).
- Produces: `Gem` gains a `base: string` prop.

- [ ] **Step 1: Add the share control to `Gem.tsx`**

Add the import near the top: `import { makeGroups, type GroupSummary, type GemShareRef } from "../groups";`.

Change the signature (`Gem.tsx:40`) to accept `base`:
```tsx
export function Gem({ api, keyName, stars, me, base }: { api: ReturnType<typeof makeApi>; keyName: string; stars: StarsCtx; me: Me | null; base: string }) {
```

Add this component ABOVE `export function Gem` (a focused sub-component so `Gem` stays readable):
```tsx
function ShareWithGroups({ base, gemKey }: { base: string; gemKey: string }) {
  const api = makeGroups(base);
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [shared, setShared] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.list().then((g) => { if (alive) setGroups(g); }).catch(() => { if (alive) setGroups([]); });
    api.listGemShares(gemKey).then((s: GemShareRef[]) => { if (alive) setShared(new Set(s.map((x) => x.groupId))); }).catch(() => {});
    return () => { alive = false; };
  }, [base, gemKey]);

  const toggle = async (groupId: string, on: boolean) => {
    setErr(null);
    const next = new Set(shared); on ? next.add(groupId) : next.delete(groupId); setShared(next);   // optimistic
    try { on ? await api.shareGem(gemKey, groupId) : await api.unshareGem(gemKey, groupId); }
    catch (e) { const back = new Set(shared); setShared(back); setErr(e instanceof Error ? e.message : String(e)); }
  };

  if (groups === null) return null;
  if (groups.length === 0) return <p className="ex-empty">You're not in any groups yet. <a href="/groups">Create one</a> to share this privately.</p>;
  return (
    <div>
      {err && <p className="ex-error">{err}</p>}
      {groups.map((g) => (
        <label key={g.id} style={{ display: "block", padding: "3px 0" }}>
          <input type="checkbox" aria-label={`share with ${g.name}`} checked={shared.has(g.id)} onChange={(e) => toggle(g.id, e.target.checked)} /> {g.name}
        </label>
      ))}
    </div>
  );
}
```

Inside the existing `{isOwner && ( … )}` owner-controls section (`Gem.tsx:154-163`), add a share block above the unpublish note:
```tsx
          <h4>Share privately with a group</h4>
          <p className="ex-danger-note" style={{ marginTop: 0 }}>Members of a checked group can open and install this gem even while it's private.</p>
          <ShareWithGroups base={base} gemKey={gemKey} />
```

- [ ] **Step 2: Pass `base` from the router**

In `src/Router.tsx`, the `gems-detail` route render — add `base={defaultApiBase()}`:
```tsx
  render: (m, c) => <Gem api={c.api} keyName={decodeURIComponent((m as RegExpMatchArray)[1])} stars={c.stars} me={c.me} base={defaultApiBase()} />
```

- [ ] **Step 3: Write the test (append to `Gem.test.tsx`)**

First read the top of `packages/marketplace/src/pages/Gem.test.tsx` to match its existing fetch-stub + gem-fixture harness. Then append a test that renders `Gem` as the owner (`me.handle === publishedBy`) with a stubbed `/api/catalog/groups` + `/api/catalog/gem-shares`, and asserts a "share with <group>" checkbox appears and toggling it POSTs to `/api/catalog/gem-shares`. Use the file's existing gem-loading stub pattern (do NOT invent a new one). Concretely, the new test asserts:
```tsx
  it("owner sees a share-with-group checkbox and can toggle it", async () => {
    // stub: gems catalog returns a gem published by "alice"; /api/catalog/groups → [{id:"g1",name:"Team",...}];
    //       /api/catalog/gem-shares → { shares: [] }; POST /api/catalog/gem-shares → { shared: true }
    // render <Gem ... me={alice-owner} base="http://x" />
    // await the "share with Team" checkbox; click it; assert a POST to /api/catalog/gem-shares fired with {key, groupId:"g1"}
  });
```
Fill in the body using the file's established harness. Keep the assertion concrete (checkbox present for owner; POST fired on toggle).

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @agentgem/marketplace test src/pages/Gem.test.tsx`
Expected: existing Gem tests + the new owner-share test PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/pages/Gem.tsx packages/marketplace/src/Router.tsx packages/marketplace/src/pages/Gem.test.tsx
git commit -m "feat(marketplace): owner 'share with groups' control on the gem page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: "Groups" nav link + green build → PR

**Files:**
- Modify: `packages/marketplace/src/App.tsx` (signed-in "Groups" nav link)
- Modify: `packages/marketplace/src/icons.tsx` (add `IconGroups`)
- Test: `packages/marketplace/src/App.test.tsx` (append, if the file asserts nav presence)

**Interfaces:** none new.

- [ ] **Step 1: Add the nav link + icon**

In `src/icons.tsx`, add an `IconGroups` following the EXACT pattern of the other icon exports in that file (open it first; the others are simple SVG components — copy one, e.g. `IconMyApps`, and swap the path for a two-figures/people glyph or reuse a generic one). Export it.

In `src/App.tsx`: import `IconGroups` in the icons import (line 8). Add a nav link after the "My apps" link (`App.tsx:70`), shown only when signed in:
```tsx
          {me && <a href="/groups" className={"ex-navlink" + (path.startsWith("/groups") ? " is-active" : "")}><IconGroups />Groups</a>}
```
(Add `const onGroups = path.startsWith("/groups");` near the other `on*` consts if you prefer — inline is fine and matches the surrounding style.)

- [ ] **Step 2: Test (if applicable)**

Read `packages/marketplace/src/App.test.tsx`. If it asserts the nav set for a signed-in user, add an assertion that a signed-in user sees a "Groups" link and a signed-out user does not, matching the file's existing render harness (it stubs `auth.getMe`). If `App.test.tsx` does not exercise nav membership, skip adding a test here (do not fabricate one) and note it.

- [ ] **Step 3: Full marketplace gate — test + typecheck + build**

Run:
```bash
pnpm --filter @agentgem/marketplace test
pnpm --filter @agentgem/marketplace typecheck
pnpm --filter @agentgem/marketplace build
```
Expected: all three succeed. `build` must pass (guards the "value-import from @agentgem/play breaks build" trap even though this plan adds none).

- [ ] **Step 4: Commit**

```bash
git add packages/marketplace/src/App.tsx packages/marketplace/src/icons.tsx packages/marketplace/src/App.test.tsx
git commit -m "feat(marketplace): Groups nav entry

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Push + PR**

```bash
git push -u origin group-shared-gems-fe
gh pr create --title "feat: group-shared gems (frontend — groups pages, share control, nav)" --body "$(cat <<'EOF'
Frontend for group-shared gems (Plan 2 of 2). Adds the marketplace UI over the Plan 1 endpoints (#358):
- makeGroups client (groups CRUD, invites, redeem, gem-shares, group-gems)
- /groups page (list, create, join-via-?token=)
- /groups/:id page (members, invite links, shared apps, delete)
- owner "share with groups" control on the gem page
- signed-in Groups nav entry

Spec: docs/superpowers/specs/2026-07-11-group-shared-gems-design.md
Plan: docs/superpowers/plans/2026-07-11-group-shared-gems-frontend.md
Depends on the backend endpoints from #358 (functions once that is merged + deployed).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Watch CI, merge on green** (`test (24)` + the marketplace vitest job)

```bash
gh run watch "$(gh run list --branch group-shared-gems-fe --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```
Then hand the merge decision to the human (trunk merge is the irreversible step).

---

## Self-Review

**Spec coverage (frontend section of the design doc):**
- `groups.ts` client (CRUD + invites + redeem + shares) → Task 1. ✓
- `Groups.tsx` (list + create) → Task 2. ✓
- Join flow → Task 2 (`?join=<token>`, folded into the panel to avoid a route colliding with `/groups/:id`). ✓
- `GroupDetail.tsx` (members, mint/revoke invites, delete, **shared-apps discovery listing**) → Task 3. ✓
- `Gem.tsx` owner share control → Task 4. ✓
- Routing + `COLLECTIONS`/`PANELS` + conformance → Tasks 2, 3. ✓
- Signed-in "Groups" nav entry → Task 5. ✓
- A `.test.tsx`/`.test.ts` per new unit + conformance → every task. ✓

**Placeholder scan:** Task 4 Step 3 and Task 5 Step 2 delegate the exact test body / icon SVG to "the file's existing harness/pattern" rather than inventing one — the assertions and behavior are concrete; only the fixture plumbing follows repo convention (the design deviation from the backend plan that mandated matching existing test harnesses). All other steps carry complete code.

**Type consistency:** `makeGroups` method names and the types `GroupSummary`/`GroupMember`/`GroupInvite`/`MintedInvite`/`GroupGem`/`GemShareRef` are defined in Task 1 and used unchanged in Tasks 2-4. `Gem` gains exactly one prop (`base: string`), threaded from the router in Task 4.

**Scope check:** single package (`@agentgem/marketplace`), one PR, independently testable via its jsdom vitest.
