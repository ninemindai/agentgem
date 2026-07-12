# Miniapp Search + Tags/Genre Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a search box, genre filter chips, and free-form clickable tag chips to the miniapps gallery on app.agentgem.ai, plus a tags input in the console Studio publish toolbar.

**Architecture:** UI-only. Every published miniapp already carries its genre in the catalog `tags` array (`["game", <genre>]`, set at `Studio.tsx:279` and flowed unchanged into `catalog_gems.tags` → `GET /api/registry/gems` → the client's `Gem.tags`). So genre chips and search are a **client-side reading of data the gallery already receives** — no schema, migration, backfill, or API change. The console gains a free-form tags input merged into that same publish array.

**Tech Stack:** React 19 + Vite 8 + Vitest (marketplace & console), TypeScript, @testing-library/react + jsdom.

## Global Constraints

- **Sibling dists:** this is a fresh worktree. Before running package tests/typecheck, if any `@agentgem/*` import fails to resolve, run `pnpm build` once at the repo root (`/Users/rfeng/Projects/ninemind/agentgem-worktrees/miniapp-search-tags`) to build sibling dists. Intra-package tests (Task 1, Task 3) do not need this; typecheck (Tasks 2, 4) does.
- **Genre values** are exactly `["replay", "skill-run", "project-fun", "session-heatmap"]` (canonical union `packages/model/src/types.ts:48`). Do NOT add a new enum copy in a shared package — use the local literal lists specified below.
- **Reserved tags:** `game` + the 4 genre values are structural; free-form tags must never contain them.
- **Tag caps:** ≤ 8 tags, each ≤ 24 chars, lowercased, trimmed, deduped, empties dropped.
- **Surgical diffs:** match existing file style (double quotes, no semicolon changes, existing className conventions). Do not reformat untouched lines.
- **Commit** after each task's tests pass. Single PR at the end.
- All paths below are relative to the worktree root `/Users/rfeng/Projects/ninemind/agentgem-worktrees/miniapp-search-tags`.

---

### Task 1: Marketplace filter helpers (`gameGenre`, `displayTags`, `filterGames`, `genreLabel`)

**Files:**
- Modify: `packages/marketplace/src/gems/catalog.ts` (add helpers after `filterGems`, ~line 107)
- Test: `packages/marketplace/src/gems/catalog.test.ts` (append a describe block)

**Interfaces:**
- Consumes: the existing `Gem` interface (`catalog.ts:8`, already has `tags: string[]`).
- Produces (used by Task 2):
  - `GAME_GENRES: readonly ["replay","skill-run","project-fun","session-heatmap"]`
  - `gameGenre(gem: Gem): GameGenreTag | undefined`
  - `displayTags(gem: Gem): string[]`
  - `filterGames(games: Gem[], query: string, genres?: string[]): Gem[]`
  - `genreLabel(g: string): string`

- [ ] **Step 1: Write the failing tests** — append to `packages/marketplace/src/gems/catalog.test.ts`. Also add `gameGenre, displayTags, filterGames, genreLabel` to the existing `import { ... } from "./catalog"` line at the top of the file (merge into the existing named-import list; do not add a duplicate import statement).

```ts
import type { Gem } from "./catalog";
// (merge these into the existing "./catalog" import): gameGenre, displayTags, filterGames, genreLabel

const mkGem = (key: string, tags: string[], description = ""): Gem => ({
  key, version: "1.0.0", description, tags, artifactKinds: ["game"], ingredients: [],
});

describe("game genre + tag helpers", () => {
  it("gameGenre reads the genre value out of the tags array", () => {
    expect(gameGenre(mkGem("a", ["game", "replay", "puzzle"]))).toBe("replay");
    expect(gameGenre(mkGem("b", ["game", "session-heatmap"]))).toBe("session-heatmap");
  });

  it("gameGenre is undefined when no genre tag is present", () => {
    expect(gameGenre(mkGem("c", ["game", "puzzle"]))).toBeUndefined();
    expect(gameGenre(mkGem("d", []))).toBeUndefined();
  });

  it("displayTags strips the structural game tag and the genre tag", () => {
    expect(displayTags(mkGem("a", ["game", "replay", "puzzle", "coop"]))).toEqual(["puzzle", "coop"]);
    expect(displayTags(mkGem("b", ["game", "project-fun"]))).toEqual([]);
  });

  it("filterGames returns all games on a blank query and no genre facet", () => {
    const gs = [mkGem("a", ["game", "replay"]), mkGem("b", ["game", "project-fun"])];
    expect(filterGames(gs, "", []).length).toBe(2);
  });

  it("filterGames narrows by genre facet (OR within the facet)", () => {
    const gs = [mkGem("a", ["game", "replay"]), mkGem("b", ["game", "project-fun"]), mkGem("c", ["game", "replay"])];
    expect(filterGames(gs, "", ["replay"]).map((g) => g.key)).toEqual(["a", "c"]);
    expect(filterGames(gs, "", ["replay", "project-fun"]).length).toBe(3);
  });

  it("filterGames matches query over key, description, and display tags (not the structural tags)", () => {
    const gs = [
      mkGem("@me/duel", ["game", "replay", "puzzle"], "a coding duel"),
      mkGem("@me/heat", ["game", "session-heatmap"], "a heatmap"),
    ];
    expect(filterGames(gs, "puzzle", []).map((g) => g.key)).toEqual(["@me/duel"]);   // display tag
    expect(filterGames(gs, "heatmap", []).map((g) => g.key)).toEqual(["@me/heat"]);  // description
    expect(filterGames(gs, "duel", []).map((g) => g.key)).toEqual(["@me/duel"]);     // key
    expect(filterGames(gs, "game", []).length).toBe(0);      // "game" is structural, not searchable
  });

  it("filterGames AND-combines query and genre facet", () => {
    const gs = [mkGem("a", ["game", "replay", "puzzle"], "x"), mkGem("b", ["game", "project-fun", "puzzle"], "y")];
    expect(filterGames(gs, "puzzle", ["replay"]).map((g) => g.key)).toEqual(["a"]);
  });

  it("genreLabel maps known genres and passes through unknown", () => {
    expect(genreLabel("replay")).toBe("Session replay");
    expect(genreLabel("session-heatmap")).toBe("Session heatmap");
    expect(genreLabel("mystery")).toBe("mystery");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/marketplace && pnpm exec vitest run src/gems/catalog.test.ts`
Expected: FAIL — `gameGenre is not a function` / `filterGames is not exported`.

- [ ] **Step 3: Implement the helpers** — add to `packages/marketplace/src/gems/catalog.ts` immediately after the `filterGems` function (after line 107):

```ts
// The 4 miniapp genres (canonical union: packages/model/src/types.ts GameGenre). The publish path
// writes them into the gem's tags as ["game", <genre>, ...userTags], so the marketplace reads genre
// straight off the tags it already receives — no separate field.
export const GAME_GENRES = ["replay", "skill-run", "project-fun", "session-heatmap"] as const;
export type GameGenreTag = (typeof GAME_GENRES)[number];
const GENRE_SET = new Set<string>(GAME_GENRES);

const GENRE_LABEL: Record<GameGenreTag, string> = {
  replay: "Session replay",
  "skill-run": "Skill run",
  "project-fun": "Project fun",
  "session-heatmap": "Session heatmap",
};

/** Display label for a genre chip; passes unknown values through unchanged. */
export function genreLabel(g: string): string {
  return GENRE_LABEL[g as GameGenreTag] ?? g;
}

/** A game gem's genre, read from its tags. Undefined if it carries no genre tag. */
export function gameGenre(gem: Gem): GameGenreTag | undefined {
  return gem.tags.find((t): t is GameGenreTag => GENRE_SET.has(t));
}

/** The chip-worthy tags: everything except the structural "game" tag and the genre tag. */
export function displayTags(gem: Gem): string[] {
  return gem.tags.filter((t) => t !== "game" && !GENRE_SET.has(t));
}

/** Case-insensitive query over key + description + display tags, AND-ed with a genre facet
 *  (OR within the facet; empty facet = all). Mirrors filterGems but genre-aware. */
export function filterGames(games: Gem[], query: string, genres: string[] = []): Gem[] {
  const q = query.trim().toLowerCase();
  return games.filter(
    (g) =>
      (q === "" ||
        g.key.toLowerCase().includes(q) ||
        g.description.toLowerCase().includes(q) ||
        displayTags(g).some((t) => t.toLowerCase().includes(q))) &&
      (genres.length === 0 || genres.includes(gameGenre(g) ?? "")),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/marketplace && pnpm exec vitest run src/gems/catalog.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/gems/catalog.ts packages/marketplace/src/gems/catalog.test.ts
git commit -m "feat(marketplace): genre + tag filter helpers for miniapps"
```

---

### Task 2: Marketplace gallery UI — search box, genre chips, tag chips

**Files:**
- Modify: `packages/marketplace/src/pages/Minigames.tsx` (full rewrite below)
- Modify: `packages/marketplace/src/styles.css` (append `.mg-tags`/`.mg-tag` + genre-chip surface, after line 933)
- Test: `packages/marketplace/src/pages/Minigames.test.tsx` (append tests)

**Interfaces:**
- Consumes: `filterGames`, `gameGenre`, `displayTags`, `genreLabel` from Task 1.
- Produces: no exports for later tasks (UI leaf).

- [ ] **Step 1: Write the failing tests** — append these `it` blocks inside the existing `describe("Minigames", ...)` in `packages/marketplace/src/pages/Minigames.test.tsx` (the file's stub/`res`/`stars` helpers already exist from the current tests):

```tsx
  const tagged = [
    { key: "@me/duel", version: "1.0.0", artifactKinds: ["game"], description: "a coding duel", tags: ["game", "replay", "puzzle"] },
    { key: "@me/heat", version: "1.0.0", artifactKinds: ["game"], description: "a heatmap view", tags: ["game", "session-heatmap"] },
  ];

  it("filters the grid by the search box", async () => {
    stubFetch(tagged);
    render(<Minigames api={makeApi("")} stars={stars} />);
    await waitFor(() => expect(screen.getByText("@me/duel")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("search miniapps"), { target: { value: "heatmap" } });
    expect(screen.queryByText("@me/duel")).toBeNull();
    expect(screen.getByText("@me/heat")).toBeTruthy();
  });

  it("filters by a genre chip", async () => {
    stubFetch(tagged);
    render(<Minigames api={makeApi("")} stars={stars} />);
    await waitFor(() => expect(screen.getByText("@me/duel")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /filter by Session replay/i }));
    await waitFor(() => expect(screen.queryByText("@me/heat")).toBeNull());
    expect(screen.getByText("@me/duel")).toBeTruthy();
  });

  it("clicking a tag chip narrows to matching miniapps", async () => {
    stubFetch(tagged);
    render(<Minigames api={makeApi("")} stars={stars} />);
    await waitFor(() => expect(screen.getByText("@me/duel")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /filter by tag puzzle/i }));
    await waitFor(() => expect(screen.queryByText("@me/heat")).toBeNull());
    expect(screen.getByText("@me/duel")).toBeTruthy();
  });

  it("shows a no-match state when the search matches nothing", async () => {
    stubFetch(tagged);
    render(<Minigames api={makeApi("")} stars={stars} />);
    await waitFor(() => expect(screen.getByText("@me/duel")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("search miniapps"), { target: { value: "zzzznope" } });
    expect(screen.getByText(/no miniapps match/i)).toBeTruthy();
  });
```

Add `fireEvent` to the existing `@testing-library/react` import at the top of the file if not already present (current import is `{ render, screen, cleanup, waitFor }`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/marketplace && pnpm exec vitest run src/pages/Minigames.test.tsx`
Expected: FAIL — `Unable to find a label 'search miniapps'` / no genre button.

- [ ] **Step 3: Rewrite `packages/marketplace/src/pages/Minigames.tsx`** with the full file below (preserves every existing behavior; adds search/genre/tag UI):

```tsx
// packages/marketplace/src/pages/Minigames.tsx
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import { loadGems, filterGames, gameGenre, displayTags, genreLabel, type Gem } from "../gems/catalog";
import { GamePreview } from "../GamePreview";
import { StarButton } from "../StarButton";
import type { StarsCtx } from "../Router";
import type { StarState } from "../stars";
import { navigate } from "../nav";
import { gamePath } from "../entityPath";

type Api = ReturnType<typeof makeApi>;

// The locally-running CLI console (default port, see src/cli.ts) — the fallback for readers who run
// the console rather than the packaged desktop app, which owns the agentgem:// scheme.
const LOCAL_CONSOLE = "http://localhost:4317";

// "Make your own" — a deep link into the console's Play → Composer → Blank tab, prefilled with a
// title and a first build prompt derived from this game, so the reader lands one click from a studio
// that starts building their own take. The desktop app routes agentgem://play (desktop/src/deeplink.ts).
function remixAppUrl(gem: Gem): string {
  const short = gem.key.split("/").pop() ?? gem.key;
  const about = gem.description ? `: ${gem.description}` : "";
  const qs = new URLSearchParams({
    new: "1",
    title: `${short}-remix`,
    prompt: `Build my own version of the mini-game "${gem.key}"${about}. Same idea — but make it my own.`,
  });
  return `agentgem://play?${qs.toString()}`;
}

// One arcade card: an animated thumbnail with a ▶ badge; click launches the sealed game fullscreen (see
// GamePreview). A broker-fed replay (no baked data, no host here) shows its own waiting state — that's
// expected off the machine that owns the session. Tag chips call onTag to set the page search.
function GameCard({ api, gem, stars, starState, plays, onTag }: { api: Api; gem: Gem; stars: StarsCtx; starState: StarState; plays: number; onTag: (t: string) => void }) {
  // Own the count locally so a play shows up the instant it is clicked (same shape as StarButton).
  // `plays` arrives after the page's bulk fetch resolves, and useState only reads it at mount.
  const [n, setN] = useState(plays);
  useEffect(() => setN(plays), [plays]);
  const tags = displayTags(gem);
  return (
    <li className="mg-card">
      <div className="mg-thumb">
        <GamePreview api={api} gemKey={gem.key} version={gem.version}
          onPlayCountChange={(d) => setN((c) => c + d)} onPlay={() => navigate(gamePath(gem.key))} />
      </div>
      <div className="mg-body">
        <div className="mg-title">{gem.key}</div>
        {gem.description && <div className="mg-desc">{gem.description}</div>}
        {tags.length > 0 && (
          <div className="mg-tags">
            {tags.map((t) => (
              <button type="button" key={t} className="ex-tag mg-tag" aria-label={`filter by tag ${t}`}
                onClick={() => onTag(t)}>#{t}</button>
            ))}
          </div>
        )}
        <div className="mg-row">
          {gem.author && <span className="mg-meta">by {gem.author}</span>}
          {n > 0 && <span className="mg-meta">{n === 1 ? "1 play" : `${n} plays`}</span>}
          <StarButton kind="gem" id={gem.key} count={starState.counts[gem.key] ?? 0} starred={starState.mine.includes(gem.key)}
            signedIn={stars.signedIn} loginUrl={stars.loginUrl} api={stars.api} />
        </div>
        <div className="mg-row mg-actions">
          <a className="mg-remix" href={remixAppUrl(gem)}
            title={`Opens AgentGem → Play, prefilled to build your own version of ${gem.key}`}>Make your own →</a>
          <button className="mg-open" onClick={() => navigate(`/gems/${encodeURIComponent(gem.key)}`)}>Open gem →</button>
        </div>
      </div>
    </li>
  );
}

export function Minigames({ api, stars }: { api: Api; stars: StarsCtx }) {
  const [gems, setGems] = useState<Gem[] | null>(null);
  const [search, setSearch] = useState("");
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [starState, setStarState] = useState<StarState>({ counts: {}, mine: [] });
  const [plays, setPlays] = useState<Record<string, number>>({});
  useEffect(() => { let alive = true; loadGems(api).then((g) => { if (alive) setGems(g); }).catch(() => setGems([])); return () => { alive = false; }; }, [api]);

  // Games are gems, so they star through the very same ("gem", <key>) identity the Gems pages use —
  // one bulk fetch for every card on the page.
  const games = gems?.filter((g) => g.artifactKinds.includes("game")) ?? [];
  const gameKeys = games.map((g) => g.key).join(","); // stable dep: refetch only when the set changes
  useEffect(() => {
    if (!gameKeys) return;
    let alive = true;
    stars.api.get("gem", gameKeys.split(",")).then((s) => { if (alive) setStarState(s); }).catch(() => {});
    api.getGamePlays(gameKeys.split(",")).then((p) => { if (alive) setPlays(p); }).catch(() => {});
    return () => { alive = false; };
  }, [gameKeys, stars.api, api]);

  if (!gems) return <p className="mg-intro">Loading miniapps…</p>;
  // Genre values present in the loaded set — the facet only offers genres that exist.
  const presentGenres = [...new Set(games.map(gameGenre).filter((x): x is NonNullable<typeof x> => !!x))];
  const visible = filterGames(games, search, selectedGenres);
  return (
    <div className="mg">
      <h2 className="mg-h">Miniapps</h2>
      <p className="mg-intro">AI-authored miniapps — sealed and playable right here. Click any one to play fullscreen.</p>
      {games.length === 0
        ? <div className="mg-empty">No miniapps published yet. Build one in AgentGem → <b>Play</b> → <b>Share to app.agentgem.ai</b>.</div>
        : <>
            <input className="ex-search" type="search" aria-label="search miniapps"
              placeholder="filter miniapps by name, tag, description…" value={search}
              onChange={(e) => setSearch(e.target.value)} />
            {presentGenres.length > 0 && (
              <div className="ex-cut-facet">
                {presentGenres.map((g) => {
                  const on = selectedGenres.includes(g);
                  return (
                    <button type="button" key={g} className={"ex-cut ex-cut-toggle" + (on ? " is-on" : "")}
                      aria-pressed={on} aria-label={(on ? "remove filter " : "filter by ") + genreLabel(g)}
                      onClick={() => setSelectedGenres((s) => on ? s.filter((x) => x !== g) : [...s, g])}>
                      {genreLabel(g)}
                    </button>
                  );
                })}
              </div>
            )}
            {visible.length === 0
              ? <p className="mg-empty">No miniapps match "{search}".</p>
              : <ul className="mg-grid">{visible.map((g) => <GameCard key={g.key} api={api} gem={g} stars={stars} starState={starState} plays={plays[g.key] ?? 0} onTag={setSearch} />)}</ul>}
            <p className="mg-foot"><b>Make your own</b> opens the AgentGem desktop app straight to <strong>Play</strong>, prefilled to build your own version of that game. Running the CLI console instead? Open <a className="mg-foot-link" href={`${LOCAL_CONSOLE}/#/play`} target="_blank" rel="noreferrer">localhost:4317 → Play</a>.</p>
          </>}
    </div>
  );
}
```

- [ ] **Step 4: Add card/genre chip CSS** — append to `packages/marketplace/src/styles.css` after line 933 (end of the Minigames arcade block):

```css
.mg-tags { display: flex; gap: 6px; flex-wrap: wrap; margin: 2px 0 10px; }
.mg-tag { background: none; border: 0; padding: 0; font: inherit; cursor: pointer; }
.mg-tag:hover { text-decoration: underline; }
/* Genre facet reuses .ex-cut-toggle geometry; give the chips a readable surface (cuts get theirs
   from inline cutMeta colors, which genres don't have). */
.mg .ex-cut { background: var(--surface-2); color: var(--ink-2); }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/marketplace && pnpm exec vitest run src/pages/Minigames.test.tsx`
Expected: PASS — including the pre-existing tests (blank search + no genres selected preserves the current "lists only game gems" behavior).

- [ ] **Step 6: Typecheck the package**

Run: `cd packages/marketplace && pnpm typecheck`
Expected: no errors. (If `@agentgem/*` imports fail to resolve, run `pnpm build` at the worktree root first — see Global Constraints.)

- [ ] **Step 7: Commit**

```bash
git add packages/marketplace/src/pages/Minigames.tsx packages/marketplace/src/pages/Minigames.test.tsx packages/marketplace/src/styles.css
git commit -m "feat(marketplace): search box + genre chips + tag chips on the miniapps gallery"
```

---

### Task 3: Console `parseTags` helper

**Files:**
- Create: `packages/console/src/panels/Play/parseTags.ts`
- Test: `packages/console/src/panels/Play/parseTags.test.ts`

**Interfaces:**
- Produces (used by Task 4): `parseTags(raw: string): string[]`.

- [ ] **Step 1: Write the failing test** — create `packages/console/src/panels/Play/parseTags.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseTags } from "./parseTags.js";

describe("parseTags", () => {
  it("splits on commas, trims, lowercases", () => {
    expect(parseTags("Puzzle, CO-OP , Roguelike")).toEqual(["puzzle", "co-op", "roguelike"]);
  });
  it("drops empties and whitespace-only entries", () => {
    expect(parseTags("puzzle,, ,coop")).toEqual(["puzzle", "coop"]);
  });
  it("drops reserved words (game + the 4 genres)", () => {
    expect(parseTags("game, replay, project-fun, puzzle, session-heatmap, skill-run")).toEqual(["puzzle"]);
  });
  it("dedupes case-insensitively", () => {
    expect(parseTags("puzzle, Puzzle, PUZZLE")).toEqual(["puzzle"]);
  });
  it("drops tags longer than 24 chars", () => {
    expect(parseTags("ok, thisisaveryverylongtagover24chars")).toEqual(["ok"]);
  });
  it("caps at 8 tags", () => {
    expect(parseTags("a,b,c,d,e,f,g,h,i,j")).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
  it("returns [] for blank input", () => {
    expect(parseTags("   ")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/console && pnpm exec vitest run src/panels/Play/parseTags.test.ts`
Expected: FAIL — `Cannot find module './parseTags.js'`.

- [ ] **Step 3: Implement** — create `packages/console/src/panels/Play/parseTags.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT

// "game" + the 4 genre values are structural tags the publish path writes automatically
// (Studio publishes ["game", <genre>, ...userTags]) and the marketplace reads back as the genre
// facet — so a free-form tag must never collide with them.
const RESERVED = new Set(["game", "replay", "skill-run", "project-fun", "session-heatmap"]);
const MAX_TAGS = 8;
const MAX_LEN = 24;

/** Parse the comma-separated tags input into a clean, capped, deduped, lowercased list. */
export function parseTags(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const t = piece.trim().toLowerCase();
    if (!t || t.length > MAX_LEN || RESERVED.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length === MAX_TAGS) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/console && pnpm exec vitest run src/panels/Play/parseTags.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/parseTags.ts packages/console/src/panels/Play/parseTags.test.ts
git commit -m "feat(console): parseTags helper for the Studio publish tags input"
```

---

### Task 4: Console Studio tags input, wired into publish

**Files:**
- Modify: `packages/console/src/panels/Play/Studio.tsx` (add import, state, input, merge into publish array)
- Modify: `packages/console/src/shell/theme.css` (add `.play-tags-input` rule near `.play-btn`, ~line 681)

**Interfaces:**
- Consumes: `parseTags` from Task 3.

This task is UI wiring with no unit test (the publish path hits the network); verify by typecheck + a manual render note. Steps are edits + typecheck + commit.

- [ ] **Step 1: Add the import** — in `packages/console/src/panels/Play/Studio.tsx`, add to the local imports (next to line 15 `import { resolvePublishAction, ... } from "./publishAction.js";`):

```tsx
import { parseTags } from "./parseTags.js";
```

- [ ] **Step 2: Add tags state** — in `Studio.tsx`, immediately after the `scope` state (line 54: `const [scope, setScope] = useState<"public" | "unlisted" | "private">("public");`), add:

```tsx
  const [tags, setTags] = useState("");   // free-form publish tags (comma separated), parsed via parseTags
```

- [ ] **Step 3: Merge tags into the publish array** — in `publishWorkspace` (line 279), change the `tags` field. Replace:

```tsx
        description: `${g.label} mini-game`, tags: ["game", meta?.genre ?? "project-fun"],
```

with:

```tsx
        description: `${g.label} mini-game`, tags: ["game", meta?.genre ?? "project-fun", ...parseTags(tags)],
```

- [ ] **Step 4: Add the tags input to the toolbar** — in the `play-studio-head` toolbar, add the input immediately before the `play-scope` radiogroup (before line 344 `<div className="play-scope" ...>`):

```tsx
        <input className="play-tags-input" type="text" aria-label="tags" placeholder="tags, comma separated"
          value={tags} onChange={(e) => setTags(e.target.value)} />
```

- [ ] **Step 5: Add the input style** — in `packages/console/src/shell/theme.css`, immediately after the `.play-btn { ... }` rule (starts at line 681), add:

```css
.play-tags-input { font: 12.5px var(--font-ui); padding: 8px 10px; border-radius: var(--radius);
  border: 1px solid var(--line); background: var(--surface); color: var(--ink); min-width: 180px; }
.play-tags-input::placeholder { color: var(--muted); }
```

(If `--line`/`--surface`/`--ink`/`--muted`/`--radius`/`--font-ui` are not the exact token names in this file, grep the file for the tokens used by `.play-btn` and the nearby inputs and match them — do not invent new tokens.)

- [ ] **Step 6: Typecheck**

Run: `cd packages/console && pnpm typecheck`
Expected: no errors. (Run `pnpm build` at the worktree root first if `@agentgem/*` imports fail to resolve.)

- [ ] **Step 7: Manual verification note** (no automated UI test for the network publish path). Confirm by reading the diff that: (a) `tags` state is declared once, (b) the input's `value`/`onChange` are bound to it, (c) the publish array is `["game", <genre>, ...parseTags(tags)]`. Optionally run the console (`pnpm --filter @agentgem/console dev`), open Play → a miniapp Studio, and confirm the tags input renders in the toolbar next to the scope radios.

- [ ] **Step 8: Commit**

```bash
git add packages/console/src/panels/Play/Studio.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): free-form tags input in the Studio publish toolbar"
```

---

### Task 5: Full-suite verification + PR

**Files:** none (verification only).

- [ ] **Step 1: Run the full marketplace test suite**

Run: `cd packages/marketplace && pnpm test`
Expected: PASS (all files, no regressions).

- [ ] **Step 2: Run the console Play tests**

Run: `cd packages/console && pnpm exec vitest run src/panels/Play`
Expected: PASS.

- [ ] **Step 3: Typecheck both packages**

Run: `cd packages/marketplace && pnpm typecheck && cd ../console && pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Push branch and open the PR** (single PR for the whole scope). Follow the repo's PR lifecycle: push `feat/miniapp-search-tags`, open the PR, watch `test (24)` with `gh run watch <run-id> --exit-status`, then `gh pr merge --rebase --delete-branch` once green. After merge, verify each commit's marker is on `origin/main` (this repo's dropped-commit trap).

```bash
git push -u origin feat/miniapp-search-tags
gh pr create --fill --base main
```

---

## Self-Review

**Spec coverage:**
- Search box → Task 2 (`ex-search` input + `filterGames`). ✓
- Genre facet chips → Task 2 (`presentGenres` + `ex-cut-facet`), reading genre via Task 1 `gameGenre`. ✓
- Free-form tag chips (clickable) → Task 2 (`displayTags` chips + `onTag`). ✓
- Console tags authoring → Tasks 3 (`parseTags`) + 4 (input + merge at `Studio.tsx:279`). ✓
- Reserved words / caps → Task 3 `parseTags` (RESERVED + MAX_TAGS/MAX_LEN). ✓
- Existing-catalog genre works day one → inherent (genre already in tags); no backfill task needed. ✓
- No schema/API/backfill → confirmed none in any task. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows full code; every run step shows an exact command + expected result. The one non-code-tested task (Task 4) is explicitly a wiring task with typecheck + manual verification, and its CSS-token caveat is a real instruction (grep + match), not a placeholder.

**Type consistency:** `gameGenre` returns `GameGenreTag | undefined` (Task 1) and is consumed as such in Task 2 (`presentGenres` type guard, `filterGames(... , selectedGenres)`). `filterGames(games, query, genres?)` signature matches its Task 2 call `filterGames(games, search, selectedGenres)`. `displayTags(gem): string[]` matches its use in both the card chips and inside `filterGames`. `parseTags(raw: string): string[]` (Task 3) matches its call `...parseTags(tags)` (Task 4). `genreLabel(g: string): string` matches chip usage.
