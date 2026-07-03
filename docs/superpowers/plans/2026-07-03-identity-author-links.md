# SP3 Slice A — Marketplace Author Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a clickable `@publishedBy` byline on marketplace gem cards and the gem detail page, linking to the SP2 profile at `/@login`.

**Architecture:** Client-only. The server already serves `publishedBy` (the verified GitHub login) on `GET /api/registry/gems` (`RegistryGemSchema.publishedBy`); the marketplace just drops it. Thread it through the client `RegistryGem` → `Gem` types, then render it as a link where present, falling back to the unlinked free-text `author`.

**Tech Stack:** TypeScript, React + Vite (marketplace), Vitest + `@testing-library/react` (jsdom).

## Global Constraints

- **Link `publishedBy`, never `author`.** `publishedBy` is the verified, server-derived GitHub login (SP2 profiles are keyed on it). `author` is a free-text manifest label (e.g. "superpowers") and must stay an **unlinked** fallback — linking it would 404 to a nonexistent profile.
- **Byline rules:** *Gem detail* — `publishedBy` present → a link; else `author` present → unlinked `by {author}`; else nothing. *Gem card* — `publishedBy` present → a link; else nothing (cards stay clean, no free-text author).
- **No nested anchors.** The gem **card** is itself an `<a href="/gems/:key">`; the author link must be a **sibling** of it (wrapped alongside it in a `.ex-gem-body` div), never nested inside — nested `<a>` is invalid HTML and React warns. The gem **detail** byline lives in a `<p>`, so nesting the link there is fine.
- **Links are same-origin `/@<login>` hrefs.** App's click-interceptor navigates them via pushState. SP3 does **not** add the `/@login` Router match — that is SP2's (#92). On a checkout without #92, hrefs are correct but navigation falls through to the Leaderboard until #92 merges. Tests assert href values (route-independent).
- **Reuse one CSS class** `.ex-gem-author` for the byline in both places.
- **Client types mirror the server** `RegistryGemSchema.publishedBy` (already `z.string().optional()`).
- **Marketplace is NOT in root CI** — `cd packages/marketplace && pnpm test` (typecheck + jsdom tests) is the gate.
- **Commits** authored as `Raymond Feng <raymond@ninemind.ai>`, each message ending with a `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer: `git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "…"`.

---

### Task 1: Thread `publishedBy` through the client gem types

**Files:**
- Modify: `packages/marketplace/src/types.ts` (client `RegistryGem`)
- Modify: `packages/marketplace/src/gems/catalog.ts` (`Gem` interface + `toGem`)
- Test: `packages/marketplace/src/gems/catalog.test.ts`

**Interfaces:**
- Consumes: the server response `RegistryGemSchema` (already has `publishedBy?: string` on the wire).
- Produces: `Gem.publishedBy?: string`, populated by `toGem` from `RegistryGem.publishedBy`. Task 2 renders it.

- [ ] **Step 1: Write the failing test**

Add to `packages/marketplace/src/gems/catalog.test.ts`, inside the existing `describe("cut threading", …)` block (or a new `describe("publishedBy threading", …)` block beside it — it reuses the same `apiWith` helper and `loadGems` import already present in the file):

```ts
  it("loadGems threads RegistryGem.publishedBy → Gem.publishedBy", async () => {
    const live: RegistryGem = { key: "k", version: "1.0.0", description: "d", tags: [], artifactKinds: ["skill"], publishedBy: "rfeng" };
    const [g] = await loadGems(apiWith(() => Promise.resolve([live])));
    expect(g.publishedBy).toBe("rfeng");
  });
  it("a live gem with no publishedBy maps to an undefined Gem.publishedBy", async () => {
    const live: RegistryGem = { key: "k", version: "1.0.0", description: "d", tags: [], artifactKinds: [] };
    const [g] = await loadGems(apiWith(() => Promise.resolve([live])));
    expect(g.publishedBy).toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/marketplace && pnpm exec vitest run src/gems/catalog.test.ts`
Expected: FAIL — `RegistryGem` has no `publishedBy` (TS error) and/or `g.publishedBy` is `undefined` because `toGem` doesn't thread it.

- [ ] **Step 3: Add `publishedBy` to the client types + `toGem`**

In `packages/marketplace/src/types.ts`, add `publishedBy?: string` to the `RegistryGem` interface (after `type?: string;`):

```ts
export interface RegistryGem {
  key: string;
  version: string;
  author?: string;
  description?: string;
  tags?: string[];
  artifactKinds?: string[];
  type?: string;
  publishedBy?: string;
  grade?: number;
  installable?: boolean;
}
```

In `packages/marketplace/src/gems/catalog.ts`, add `publishedBy?: string` to the `Gem` interface (after the `author?: string;` line):

```ts
export interface Gem {
  key: string;            // unique, url-safe (e.g. "brainstorming-kit")
  version: string;        // e.g. "1.2.0"
  author?: string;
  publishedBy?: string;   // verified GitHub login (server-derived); links to the /@login profile
  description: string;
  tags: string[];
  artifactKinds: string[];      // e.g. ["skill","mcp"] — chip row
  cut?: string;                  // gem cut (type), e.g. "kit" | "skill" | "integration" | "setup"
  grade?: number;                // authoring quality floor (1–3); blended with community stars into the 1–5 rating
  ingredients: GemIngredient[]; // bundled ingredients; ids match aggregator ids for cross-linking
}
```

And thread it in `toGem` (same file):

```ts
function toGem(r: RegistryGem): Gem {
  return { key: r.key, version: r.version, author: r.author, publishedBy: r.publishedBy, description: r.description ?? "", tags: r.tags ?? [], artifactKinds: r.artifactKinds ?? [], cut: r.type, grade: r.grade, ingredients: [] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/marketplace && pnpm exec vitest run src/gems/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/types.ts packages/marketplace/src/gems/catalog.ts packages/marketplace/src/gems/catalog.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(authorlinks): thread publishedBy into the client gem types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Render the `@publishedBy` byline on gem detail + cards

**Files:**
- Modify: `packages/marketplace/src/pages/Gem.tsx` (detail byline)
- Modify: `packages/marketplace/src/pages/Gems.tsx` (card byline + `.ex-gem-body` wrapper)
- Modify: `packages/marketplace/src/styles.css` (`.ex-gem-body`, `.ex-gem-author`)
- Test: `packages/marketplace/src/pages/Gem.test.tsx`
- Test: `packages/marketplace/src/pages/Gems.test.tsx`

**Interfaces:**
- Consumes: `Gem.publishedBy?: string` (Task 1).
- Produces: an `<a class="ex-gem-author" href="/@<login>">@<login></a>` on the detail page and on each browse card whose gem has `publishedBy`.

- [ ] **Step 1: Write the failing detail test**

Add to `packages/marketplace/src/pages/Gem.test.tsx` (it already has `render`, `screen`, `cleanup`, an `apiLive` and `stars` — mirror those). Add inside the `describe("Gem (detail)", …)` block:

```tsx
  it("renders a linked @publishedBy byline to the profile", async () => {
    const apiPub = { getGems: () => Promise.resolve([{ key: "pub-gem", version: "1.0.0", publishedBy: "rfeng", author: "acme", description: "d", tags: [], artifactKinds: ["skill"] }]), gemAdoption: () => Promise.resolve({}) } as never;
    render(<Gem api={apiPub} keyName="pub-gem" stars={stars} />);
    const link = (await screen.findByText("@rfeng")).closest("a");
    expect(link?.getAttribute("href")).toBe("/@rfeng");
  });

  it("falls back to unlinked 'by {author}' when there is no publishedBy", async () => {
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} />); // apiLive gem: author 'acme', no publishedBy
    await screen.findByRole("heading", { name: /live-gem/ });
    expect(screen.getByText(/by acme/)).toBeTruthy();
    expect(screen.queryByText("@acme")).toBeNull(); // author is NOT linked
  });
```

- [ ] **Step 2: Write the failing card test**

Add to `packages/marketplace/src/pages/Gems.test.tsx` (it already has `render`, `screen`, `cleanup`, `apiWith`, `stars`), inside `describe("Gems (browse)", …)`:

```tsx
  it("shows a linked @publishedBy byline on a card", async () => {
    const api = apiWith(() => Promise.resolve([{ key: "pub-gem", version: "1.0.0", publishedBy: "rfeng", description: "d", tags: [], artifactKinds: ["skill"] }]));
    render(<Gems api={api} stars={stars} />);
    const link = (await screen.findByText("@rfeng")).closest("a");
    expect(link?.getAttribute("href")).toBe("/@rfeng");
  });

  it("shows no author byline on a card without publishedBy", async () => {
    const api = apiWith(() => Promise.resolve([{ key: "no-pub", version: "1.0.0", author: "acme", description: "d", tags: [], artifactKinds: ["skill"] }]));
    render(<Gems api={api} stars={stars} />);
    await screen.findByText("no-pub");
    expect(screen.queryByText(/^@/)).toBeNull();
  });
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `cd packages/marketplace && pnpm exec vitest run src/pages/Gem.test.tsx src/pages/Gems.test.tsx`
Expected: FAIL — no `@rfeng` link rendered yet.

- [ ] **Step 4: Render the byline (detail)**

In `packages/marketplace/src/pages/Gem.tsx`, replace the `ex-gem-meta` byline (currently `{gem.author && <span>by {gem.author}</span>}`) so `publishedBy` wins as a link, `author` is the unlinked fallback:

```tsx
      <p className="ex-gem-meta">
        {gem.publishedBy
          ? <a className="ex-gem-author" href={"/@" + encodeURIComponent(gem.publishedBy)}>@{gem.publishedBy}</a>
          : (gem.author ? <span>by {gem.author}</span> : null)}
        {gem.artifactKinds.map((k) => <span key={k} className="ex-chip">{kindLabel(k)}</span>)}
      </p>
```

- [ ] **Step 5: Render the byline (cards) without nesting anchors**

In `packages/marketplace/src/pages/Gems.tsx`, wrap the existing card `<a className="ex-gem-card">…</a>` in a `<div className="ex-gem-body">` and add the author link as a **sibling** of the card link inside that wrapper (so the author `<a>` is never nested inside the card `<a>`). The `StarButton` stays a sibling of the new wrapper:

```tsx
          <li key={g.key} className="ex-gem-item">
            <div className="ex-gem-body">
              <a className="ex-gem-card" href={"/gems/" + encodeURIComponent(g.key)}>
                <span className="ex-gem-head">
                  <span className="ex-gem-key">{g.key}</span>
                  <CutBadge cut={g.cut} />
                  <StoneRating cut={g.cut} grade={g.grade} stars={starState.counts[g.key] ?? 0} installs={adoptions[g.key]?.installs ?? 0} verifiedInstalls={adoptions[g.key]?.verifiedInstalls ?? 0} />
                  <span className="ex-gem-kinds">{g.artifactKinds.map((k) => <span key={k} className="ex-chip">{kindLabel(k)}</span>)}</span>
                </span>
                <span className="ex-gem-desc">{g.description}</span>
                <span className="ex-gem-tags">{g.tags.map((t) => <span key={t} className="ex-tag">#{t}</span>)}</span>
              </a>
              {g.publishedBy && <a className="ex-gem-author" href={"/@" + encodeURIComponent(g.publishedBy)}>@{g.publishedBy}</a>}
            </div>
            <StarButton kind="gem" id={g.key} count={starState.counts[g.key] ?? 0} starred={starState.mine.includes(g.key)}
              signedIn={stars.signedIn} loginUrl={stars.loginUrl} api={stars.api} />
          </li>
```

- [ ] **Step 6: Add the CSS**

In `packages/marketplace/src/styles.css`, change the flex rule from the card to the new wrapper and add the author style. Replace the existing line `.ex-gem-item .ex-gem-card { flex: 1 1 auto; min-width: 0; }` with:

```css
.ex-gem-item .ex-gem-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.ex-gem-author { align-self: flex-start; color: var(--muted); font-size: 0.8rem; text-decoration: none; }
.ex-gem-author:hover { color: var(--brand); text-decoration: underline; }
```

- [ ] **Step 7: Run both test files to verify they pass**

Run: `cd packages/marketplace && pnpm exec vitest run src/pages/Gem.test.tsx src/pages/Gems.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the full marketplace gate**

Run: `cd packages/marketplace && pnpm test`
Expected: PASS (typecheck + all tests; no regressions).

- [ ] **Step 9: Commit**

```bash
git add packages/marketplace/src/pages/Gem.tsx packages/marketplace/src/pages/Gems.tsx packages/marketplace/src/styles.css packages/marketplace/src/pages/Gem.test.tsx packages/marketplace/src/pages/Gems.test.tsx
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(authorlinks): @publishedBy byline linking to /@login on gem detail + cards

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Thread `publishedBy` through client `RegistryGem` + `Gem` + `toGem` → Task 1. ✅
- Detail byline: `publishedBy` link, else unlinked `author`, else nothing → Task 2 Step 4. ✅
- Card byline: `publishedBy` link, else nothing → Task 2 Step 5. ✅
- Link `publishedBy` not `author`; `author` stays unlinked fallback → both tasks + tests assert `@acme` is not linked. ✅
- No nested anchors on cards (sibling in `.ex-gem-body`) → Task 2 Step 5 + constraint. ✅
- Same-origin `/@login` hrefs; no Router change (SP2 owns it) → constraints; tests assert href only. ✅
- Reuse `.ex-gem-author` in both places → Steps 4–6. ✅
- Slice B (console) is a non-goal here (documented fast-follow in the spec). ✅

**2. Placeholder scan:** No TBD/"handle errors"/"similar to". Every code step shows complete code; commands have expected outcomes. ✅

**3. Type consistency:** `publishedBy?: string` is identical across `RegistryGem` (types.ts), `Gem` (catalog.ts), and the server `RegistryGemSchema.publishedBy`. `toGem` reads `r.publishedBy`. `Gem.tsx`/`Gems.tsx` read `gem.publishedBy`/`g.publishedBy`. Test logins ("rfeng", "acme") consistent across Task 1 and Task 2. The `.ex-gem-author` class name matches between Gem.tsx, Gems.tsx, and styles.css. `.ex-gem-body` matches between Gems.tsx and the styles.css flex rule. ✅
