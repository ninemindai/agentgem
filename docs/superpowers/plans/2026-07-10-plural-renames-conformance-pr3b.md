# Plural Renames + Router Conformance (PR 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the entity-address scheme: rename the two singular marketplace routes to plural canonical (`/ingredient`→`/ingredients`, `/skill`→`/skills`) keeping the singular forms as redirecting aliases; add a router conformance test that fails when a route invents a non-conforming shape; and wire the marketplace suite into CI so that test actually gates.

**Architecture:** Refactor `Router.tsx`'s hand-rolled `if`-cascade into a declarative `ROUTES` table (each entry: a matcher + a render closure + a conformance classification) that the Router iterates AND the conformance test enumerates. Singular aliases `replaceState` to canonical during path normalization. Then add one `pnpm --filter @agentgem/marketplace test` step to `ci.yml`.

**Tech Stack:** React 19 marketplace SPA, Vitest (jsdom), GitHub Actions.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md` — the *Enforcement* section (the conformance test + "fails CI requires wiring") and the plural `<collection>/<entity-id>` rule.
- **Worktree:** `../agentgem-route-renames`, branch `feat/plural-route-renames`, off `origin/main`. Do not commit to `main`.
- **PURE SPA — no deploy risk, no server, no worker change.** The OG worker (3a) is already merged; do not touch it.
- **Canonical = plural.** `/ingredients/:id`, `/skills/:sourceId/*path`. The singular `/ingredient/:id` and `/skill/:sourceId/*path` are **legacy aliases** that `replaceState` to canonical (so old shared links keep working and the URL bar shows canonical).
- **Behavior-preserving refactor (Task 1):** the existing `Router.test.tsx` + `App.test.tsx` are the regression guard — they must stay green with ZERO changes in Task 1. Route renames + test updates happen in Task 2.
- **Marketplace tests:** `pnpm --filter @agentgem/marketplace test` (jsdom). Green baseline is 268 tests (includes 3a's 7 worker tests). Not in CI until Task 4.
- Every marketplace nav is a plain `<a href>` intercepted by `App.tsx`; `navigate()` (`nav.ts`) is pushState + synthetic popstate. Aliases normalize via `window.history.replaceState` (does NOT fire popstate — no loop).

---

### Task 1: Refactor Router to a declarative `ROUTES` table (behavior-preserving)

**Files:**
- Modify: `packages/marketplace/src/Router.tsx`

**Interfaces:**
- Produces: `export const ROUTES: RouteDef[]` and `export const PANELS: string[]` / `export const COLLECTIONS: string[]` (consumed by the Task 3 conformance test). `RouteDef = { id: string; kind: "home" | "panel" | "collection" | "profile" | "alias"; collection?: string; match(path: string): RegExpMatchArray | boolean | null; render(m: RegExpMatchArray | true, ctx: Ctx): JSX.Element; canonical?(path: string): string }` where `Ctx = { api; stars; reviews; me }`.

- [ ] **Step 1: Verify the current tests are green (baseline to preserve)**

```bash
pnpm --filter @agentgem/marketplace exec vitest run src/Router.test.tsx src/App.test.tsx
```

Expected: PASS. Note the count — Task 1 must end with the same tests passing, unchanged.

- [ ] **Step 2: Refactor Router.tsx to iterate a table**

Replace the `if`-cascade (lines 39-77) with a declarative table + a loop. Keep EVERY route's exact matching + rendering identical (this is the whole point — no behavior change). The table, ctx, and loop:

```tsx
type Ctx = { api: ReturnType<typeof makeApi>; stars: StarsCtx; reviews: ReviewsCtx; me: Me | null };
// match returns a truthy VALUE the render closure consumes (a RegExpMatchArray for regex routes,
// the parsed game key `string` for games, `true` for exact-string panels/home), or null/false.
type MatchVal = RegExpMatchArray | string | true;
export type RouteDef = {
  id: string;
  kind: "home" | "panel" | "collection" | "profile" | "alias";
  collection?: string;                 // the plural segment, for kind "collection"
  match(path: string): MatchVal | null | false;
  render(m: MatchVal, ctx: Ctx): React.ReactNode;
  canonical?(path: string): string;    // aliases only: the plural URL to replaceState to
};

// The single source of truth for what paths this SPA serves. The Router iterates it (first match
// wins, top to bottom — entity-before-collection order preserved); the conformance test enumerates
// it. A NEW route MUST be added here, and pass the conformance rule (see Router.conformance.test).
export const ROUTES: RouteDef[] = [
  { id: "publish", kind: "panel", match: (p) => p === "/publish", render: (_m, c) => <Publish api={c.api} me={c.me} base={defaultApiBase()} /> },
  { id: "account", kind: "panel", match: (p) => p === "/account", render: (_m, c) => <Account api={c.api} me={c.me} base={defaultApiBase()} /> },
  { id: "sources", kind: "panel", match: (p) => p === "/sources", render: (_m, c) => <Sources api={c.api} /> },
  { id: "home", kind: "home", match: (p) => p === "/" || p === "/miniapps" || p === "/minigames", render: (_m, c) => <Minigames api={c.api} stars={c.stars} /> },
  { id: "games", kind: "collection", collection: "games", match: (p) => parseGamePath(p), render: (m, c) => <Play api={c.api} gemKey={m as string} /> },
  { id: "gems-detail", kind: "collection", collection: "gems", match: (p) => p.match(/^\/gems\/(.+)$/), render: (m, c) => <Gem api={c.api} keyName={decodeURIComponent((m as RegExpMatchArray)[1])} stars={c.stars} me={c.me} /> },
  { id: "gems", kind: "collection", collection: "gems", match: (p) => p === "/gems", render: (_m, c) => <Gems api={c.api} stars={c.stars} /> },
  { id: "ingredients", kind: "collection", collection: "ingredients", match: (p) => p.match(/^\/ingredient\/(.+)$/), render: (m, c) => <Ingredient api={c.api} id={decodeURIComponent((m as RegExpMatchArray)[1])} stars={c.stars} /> },
  { id: "skills", kind: "collection", collection: "skills", match: (p) => p.match(/^\/skill\/([^/]+)\/(.+)$/), render: (m, c) => <CatalogSkill api={c.api} reviews={c.reviews} sourceId={decodeURIComponent((m as RegExpMatchArray)[1])} path={(m as RegExpMatchArray)[2]} /> },
  { id: "profile", kind: "profile", match: (p) => p.match(/^\/@([^/]+)$/), render: (m, c) => <Profile api={c.api} login={decodeURIComponent((m as RegExpMatchArray)[1])} me={c.me} /> },
  { id: "org-usage", kind: "collection", collection: "orgs", match: (p) => p.match(/^\/orgs\/([^/]+)\/usage$/), render: (m, c) => <TeamUsage api={c.api} scope={decodeURIComponent((m as RegExpMatchArray)[1])} stars={c.stars} /> },
  { id: "org", kind: "collection", collection: "orgs", match: (p) => p.match(/^\/orgs\/([^/]+)$/), render: (m, c) => <OrgCatalog api={c.api} scope={decodeURIComponent((m as RegExpMatchArray)[1])} /> },
];

// Declared classifications the conformance test checks against.
export const COLLECTIONS = ["games", "gems", "ingredients", "skills", "orgs"];  // plural
export const PANELS = ["publish", "account", "sources"];
```

Note on Task 1 vs Task 2: in Task 1 the `ingredients`/`skills` entries STILL match the SINGULAR paths (`/ingredient/`, `/skill/`) — the `collection` label is already plural (that's just metadata), but the matcher is unchanged so behavior is preserved. Task 2 flips the matchers to plural + adds aliases. Keep it this way so Task 1 changes zero behavior.

Then the Router body:

```tsx
export function Router({ api, stars, reviews, me }: { api: ...; stars: StarsCtx; reviews: ReviewsCtx; me: Me | null }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const ctx: Ctx = { api, stars, reviews, me };
  for (const r of ROUTES) {
    const m = r.match(path);
    if (m) return <>{r.render(m, ctx)}</>;   // m is a truthy MatchVal here
  }
  return (
    <>
      <PopularSkills api={api} stars={stars} reviews={reviews} />
      <h2 className="ex-section-title">Adoption leaderboard</h2>
      <Leaderboard api={api} stars={stars} />
    </>
  );
}
```

(Import `React` for the `React.ReactNode` type if not already imported. The games route's `match` returns the parsed key `string` (or null); its `render` casts `m` to `string` — no double-parse. The existing App.test.tsx game-route test is the guard.)

- [ ] **Step 3: Run the guard tests — MUST be identical green**

```bash
pnpm --filter @agentgem/marketplace exec vitest run src/Router.test.tsx src/App.test.tsx
pnpm --filter @agentgem/marketplace exec tsc -p tsconfig.json --noEmit
```

Expected: the SAME tests pass as in Step 1, with NO test-file changes, typecheck clean. If any route test fails, a render closure or matcher diverged from the original — fix the closure, do not change the test.

- [ ] **Step 4: Commit**

```bash
git add packages/marketplace/src/Router.tsx
git commit -m "refactor(marketplace): Router iterates a declarative ROUTES table (no behavior change)"
```

---

### Task 2: Plural canonical routes + singular aliases + update generators & tests

**Files:**
- Modify: `packages/marketplace/src/Router.tsx` (flip `ingredients`/`skills` matchers to plural; add alias entries)
- Modify: `packages/marketplace/src/pages/Gem.tsx:173`, `Leaderboard.tsx:67`, `PopularSkills.tsx:55`, `Profile.tsx:80` (generators → plural)
- Modify: `packages/marketplace/src/pages/Gem.test.tsx:17`, `Leaderboard.test.tsx:43`, `Profile.test.tsx:57`, `PopularSkills.test.tsx:54,55,121,123`, `App.test.tsx:40`, `Router.test.tsx:45,50` (assertions → plural; add an alias-redirect case)

**Interfaces:**
- Consumes: `ROUTES` from Task 1.

- [ ] **Step 1: Write/adjust the failing tests first**

Update the singular assertions to plural (the generators will produce these):
- `Gem.test.tsx:17`, `Leaderboard.test.tsx:43`, `App.test.tsx:40`: `"/ingredient/" + encodeURIComponent(...)` → `"/ingredients/" + encodeURIComponent(...)`.
- `Profile.test.tsx:57`: `"/skill/matt-skills/productivity/brainstorming.md"` → `"/skills/matt-skills/productivity/brainstorming.md"`.
- `PopularSkills.test.tsx:54,55,121,123`: `/skill/…` → `/skills/…`.
- `Router.test.tsx:45,50`: the ingredient test — change the pushState path to `/ingredients/…` and keep asserting the Ingredient page renders with the decoded id.

Then ADD an alias-redirect test to `Router.test.tsx` (proves the singular alias `replaceState`s to canonical):

```tsx
it("redirects a legacy singular /ingredient/:id to canonical /ingredients/:id", async () => {
  window.history.pushState({}, "", "/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
  render(<Router api={apiStub()} stars={starsStub()} reviews={reviewsStub()} me={null} />);
  // the Ingredient page still renders...
  await waitFor(() => expect(screen.getByText(/brainstorming/i)).toBeTruthy());
  // ...and the URL was rewritten to the plural canonical form
  expect(window.location.pathname).toBe("/ingredients/" + encodeURIComponent("skill:superpowers/brainstorming"));
});
```

(Use the file's existing stub helpers — read `Router.test.tsx` for `apiStub`/`starsStub`/`reviewsStub` names; match them. Add the analogous `/skill`→`/skills` alias test.)

- [ ] **Step 2: Run to verify they fail**

```bash
pnpm --filter @agentgem/marketplace exec vitest run src/Router.test.tsx src/App.test.tsx src/pages/Gem.test.tsx src/pages/Leaderboard.test.tsx src/pages/Profile.test.tsx src/pages/PopularSkills.test.tsx
```

Expected: FAIL — generators still emit singular; no alias redirect yet.

- [ ] **Step 3: Flip the generators to plural**

- `Gem.tsx:173`: `"/ingredient/"` → `"/ingredients/"`.
- `Leaderboard.tsx:67`: `"/ingredient/"` → `"/ingredients/"`.
- `PopularSkills.tsx:55`: `` `/skill/${encodeURIComponent(sourceId)}/${path}` `` → `` `/skills/${encodeURIComponent(sourceId)}/${path}` ``.
- `Profile.tsx:80`: `` `/skill/${encodeURIComponent(r.sourceId)}/${r.path}` `` → `` `/skills/${...}/${...}` ``.

- [ ] **Step 4: Flip the canonical matchers to plural + add alias entries in `ROUTES`**

In `Router.tsx`, change the `ingredients` entry's matcher to `/^\/ingredients\/(.+)$/` and the `skills` entry's to `/^\/skills\/([^/]+)\/(.+)$/`. Then add two `alias` entries (place them so they match — anywhere in the table, they don't collide with the plural forms):

```tsx
  { id: "ingredient-alias", kind: "alias", match: (p) => /^\/ingredient\/.+$/.test(p), canonical: (p) => p.replace(/^\/ingredient\//, "/ingredients/"), render: () => null },
  { id: "skill-alias", kind: "alias", match: (p) => /^\/skill\/[^/]+\/.+$/.test(p), canonical: (p) => p.replace(/^\/skill\//, "/skills/"), render: () => null },
```

And add alias normalization to the Router's path handling so a matched alias rewrites the URL to canonical BEFORE rendering. The cleanest spot is a `canonicalize` helper used in the `useState` initializer and the `onPop` handler:

```tsx
function canonicalize(path: string): string {
  for (const r of ROUTES) {
    if (r.kind === "alias" && r.canonical && r.match(path)) {
      const to = r.canonical(path);
      window.history.replaceState({}, "", to);   // no popstate → no loop
      return to;
    }
  }
  return path;
}
```
```tsx
  const [path, setPath] = useState(() => canonicalize(window.location.pathname));
  useEffect(() => {
    const onPop = () => setPath(canonicalize(window.location.pathname));
    ...
```

So a `/ingredient/x` navigation is rewritten to `/ingredients/x` and then matched by the plural `ingredients` route. The `alias` entries' `render: () => null` is never reached (canonicalize rewrites the path before the render loop sees it); they exist so the conformance test knows these legacy shapes are declared, not stray.

- [ ] **Step 5: Run to verify green**

```bash
pnpm --filter @agentgem/marketplace exec vitest run src/Router.test.tsx src/App.test.tsx src/pages/Gem.test.tsx src/pages/Leaderboard.test.tsx src/pages/Profile.test.tsx src/pages/PopularSkills.test.tsx
pnpm --filter @agentgem/marketplace exec tsc -p tsconfig.json --noEmit
```

Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/src/Router.tsx packages/marketplace/src/pages/*.tsx packages/marketplace/src/pages/*.test.tsx packages/marketplace/src/App.test.tsx
git commit -m "feat(marketplace): plural /ingredients + /skills, singular forms redirect to canonical"
```

---

### Task 3: The router conformance test

**Files:**
- Test: `packages/marketplace/src/Router.conformance.test.tsx` (create)

**Interfaces:**
- Consumes: `ROUTES`, `COLLECTIONS`, `PANELS` from `Router.tsx`.

- [ ] **Step 1: Write the test**

Create `packages/marketplace/src/Router.conformance.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { ROUTES, COLLECTIONS, PANELS } from "./Router";

// The scheme (docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md): every route is
// EITHER a <plural-collection>/<entity> path, an explicitly-listed panel, the profile shape, the
// home tab, or a declared legacy alias. A new route that invents a non-conforming shape fails here.
describe("Router conformance to the entity-address scheme", () => {
  it("every route is a declared collection, panel, profile, home, or alias", () => {
    for (const r of ROUTES) {
      if (r.kind === "collection") {
        expect(COLLECTIONS, `route "${r.id}" declares collection "${r.collection}" — add it to COLLECTIONS (must be plural)`).toContain(r.collection);
        expect(r.collection, `collection "${r.collection}" must be plural`).toMatch(/s$/);
      } else if (r.kind === "panel") {
        expect(PANELS, `panel route "${r.id}" must be listed in PANELS`).toContain(r.id);
      } else {
        expect(["home", "profile", "alias"], `route "${r.id}" has kind "${r.kind}" — not a recognized non-entity kind`).toContain(r.kind);
      }
    }
  });

  it("no two routes share an id (the table is the single source of truth)", () => {
    const ids = ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("canonical collection routes are plural; only aliases carry a singular shape", () => {
    // A collection matcher must not accept a singular /ingredient/ or /skill/ (those are aliases).
    const ing = ROUTES.find((r) => r.id === "ingredients")!;
    const skl = ROUTES.find((r) => r.id === "skills")!;
    expect(ing.match("/ingredient/x")).toBeFalsy();     // singular is NOT the canonical collection
    expect(ing.match("/ingredients/x")).toBeTruthy();
    expect(skl.match("/skill/a/b")).toBeFalsy();
    expect(skl.match("/skills/a/b")).toBeTruthy();
    // and the aliases redirect to the plural canonical
    const ingAlias = ROUTES.find((r) => r.id === "ingredient-alias")!;
    expect(ingAlias.canonical!("/ingredient/x")).toBe("/ingredients/x");
  });
});
```

- [ ] **Step 2: Run — it should PASS (the scheme is already satisfied after Task 2)**

```bash
pnpm --filter @agentgem/marketplace exec vitest run src/Router.conformance.test.tsx
```

Expected: PASS. (This test guards the FUTURE: it fails only when someone adds a non-conforming route.)

- [ ] **Step 3: Prove it has teeth — a temporary non-conforming route fails it**

Sanity-check locally (do NOT commit this): temporarily add `{ id: "widget", kind: "collection", collection: "widget", match: () => null, render: () => null }` to `ROUTES` and re-run — the test must FAIL (`widget` not in COLLECTIONS + not plural). Then remove it. Note in the report that you verified the test bites.

- [ ] **Step 4: Commit**

```bash
git add packages/marketplace/src/Router.conformance.test.tsx
git commit -m "test(marketplace): router conformance to the plural entity-address scheme"
```

---

### Task 4: Wire the marketplace suite into CI

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the step**

After the `- run: pnpm test` line (line 50), add:

```yaml
      # The marketplace SPA (packages/marketplace) has its own jsdom vitest suite that the root
      # `pnpm test` (dist/** + website/edge globs) does not reach. Run it so the router conformance
      # test — and the rest of the user-facing marketplace — gates merges. Green at 268 tests today.
      - run: pnpm --filter @agentgem/marketplace test
```

- [ ] **Step 2: Verify the exact command passes locally (this is what CI will run)**

```bash
pnpm --filter @agentgem/marketplace test
```

Expected: PASS — full marketplace suite (268 baseline + the alias tests + the conformance test). Note the final count.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the marketplace vitest suite (gates the router conformance test)"
```

---

### Task 5: Verify end-to-end, then open the PR

- [ ] **Step 1: Full marketplace suite + typecheck + build + the server suite (unaffected)**

```bash
pnpm --filter @agentgem/marketplace test
pnpm --filter @agentgem/marketplace exec tsc -p tsconfig.json --noEmit
pnpm --filter @agentgem/marketplace build
pnpm test
```

Expected: marketplace green, typecheck + build clean, server suite unaffected (this PR is SPA-only, but `pnpm test` runs in CI so confirm it's green on this branch).

- [ ] **Step 2: Drive the real SPA — the alias redirect**

```bash
pnpm --filter @agentgem/marketplace dev
```

Open `/ingredient/skill:superpowers%2Fbrainstorming` and confirm the address bar rewrites to `/ingredients/…` and the ingredient page renders; open `/skill/matt-skills/productivity/brainstorming.md` and confirm it rewrites to `/skills/…`. Click an ingredient link on the home leaderboard and confirm it goes to `/ingredients/…`. This is the redirect behavior tests can only partially prove.

- [ ] **Step 3: Confirm branch ahead of origin/main only, push, PR**

```bash
git fetch origin && git rev-list --left-right --count origin/main...HEAD
git push -u origin feat/plural-route-renames
gh pr create --title "feat: plural /ingredients + /skills routes, router conformance test, marketplace CI (PR 3b)" --body "$(cat <<'EOF'
PR 3b — the last piece of the entity-address scheme (`docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md`). Pure SPA, no deploy.

- **Plural canonical routes:** `/ingredient/:id`→`/ingredients/:id`, `/skill/:sourceId/*path`→`/skills/:sourceId/*path`. The singular forms are kept as **aliases that `replaceState` to canonical**, so old shared links keep working and the URL bar shows the canonical plural form. All four link generators emit plural.
- **Declarative route table:** `Router.tsx` refactored from a hand-rolled `if`-cascade into a `ROUTES` table it iterates (behavior-preserving — the existing Router/App tests gate it), so routes are enumerable.
- **Router conformance test:** every route must be a declared plural collection, a listed panel, the profile/home shape, or a declared alias — a non-conforming new route fails the test (verified it bites).
- **Marketplace into CI:** added `pnpm --filter @agentgem/marketplace test` to `ci.yml` — the first CI coverage of the user-facing marketplace, so the conformance test actually gates. Suite was green at baseline.

## Test plan
- Full marketplace suite green (was 268; + alias redirect tests + conformance test); typecheck + build clean; server `pnpm test` green
- Drove the SPA: legacy `/ingredient/:id` and `/skill/…` rewrite to plural canonical; generators emit plural

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch CI, merge, verify each commit landed**

```bash
gh run watch <run-id> --exit-status
gh pr merge --rebase --delete-branch
```

CI now runs the marketplace step — confirm `test (24)` is green (it exercises the conformance test for the first time). `--delete-branch` errors on the local delete (`main` checked out elsewhere) but the remote merge lands — verify `gh pr view <n> --json state` is `MERGED`, then grep `origin/main:packages/marketplace/src/Router.tsx` for `ROUTES` and `origin/main:.github/workflows/ci.yml` for `filter @agentgem/marketplace`.
