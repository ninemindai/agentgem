# Studio Publish Toolbar Declutter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink the Studio head row to actions only (Save · Push to git · Share · Request review) by moving the tags input and Public/Unlisted/Private choice into a settings footer row of the cover-confirm banner, per the approved design spec (variant C).

**Architecture:** Pure JSX + CSS move inside `packages/console` — the `scope`/`tags` React state and the entire publish flow are untouched (both values are read only after the banner resolves). The visibility pills become an ink-selected segmented control (`.play-seg`) so the banner keeps exactly one terracotta primary; a destination-focused helper line explains the selected choice.

**Tech Stack:** React 18 (console SPA), hand-authored CSS in `src/shell/theme.css` (no framework), vitest + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/2026-07-15-studio-toolbar-declutter-design.md` (same branch — read it first; it carries the approved layout, copy, and a11y decisions).

## Global Constraints

- **No new dependencies.** Everything uses what `packages/console` already has.
- **Every new className gets a matching rule in `src/shell/theme.css` in the same change** (project rule; grep before finishing).
- **Console tests are NOT in CI** — they must be run locally (`packages/console` vitest + typecheck).
- **Do not touch the publish flow logic** — `scope`/`tags` `useState` hooks, `shareToExplore`, `proceedToPublish`, `checkAndPublish`, `publishWorkspace` all stay byte-identical.
- **Helper copy is user-approved verbatim** (em dashes included):
  - public: `Listed in Explore — anyone can find and play it.`
  - unlisted: `Anyone with the link can play; not listed in Explore.`
  - private: `Only you — lives in My apps.`
- **Integration path is a PR** off this branch; never commit to `main`. Merge gate is the `test (24)` CI check.
- Work happens in the existing worktree `/Users/rfeng/Projects/ninemind/agentgem-worktrees/studio-toolbar-declutter` (branch `studio-toolbar-declutter`).

---

### Task 1: Rebase onto current origin/main

`origin/main` gained two commits after this branch was cut (`53f7a820` marketplace, `4ee06fa2` console routes.ts). Neither touches `Studio.tsx`, `theme.css`, or `StudioShare.test.tsx`, so the rebase is clean — but do it first so the PR diff is against the real trunk.

**Files:** none modified by hand.

- [ ] **Step 1: Rebase**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/studio-toolbar-declutter
git fetch origin
git rebase origin/main
```

Expected: `Successfully rebased and updated refs/heads/studio-toolbar-declutter.` (2 docs commits replayed, no conflicts)

- [ ] **Step 2: Verify branch state**

```bash
git status -sb
```

Expected: `## studio-toolbar-declutter...origin/main [ahead 2]` — ahead only, not behind.

---

### Task 2: Update StudioShare.test.tsx to the new UI contract (red)

The tests define the new contract first: the Share button is named "Share", visibility is chosen *inside* the banner (after clicking Share), the helper line explains each choice, and the toolbar no longer hosts settings. All 15 existing tests plus 2 new ones must compile against the new contract; they FAIL until Tasks 3–4 land.

**Files:**
- Modify: `packages/console/src/panels/Play/__tests__/StudioShare.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the test contract Tasks 3–4 implement — button accessible name `Share`; segment buttons `Public`/`Unlisted`/`Private` with `aria-pressed`, reachable only after the banner opens; helper texts exactly as in Global Constraints; no `tags, comma separated` placeholder and no `Public` button before Share is clicked.

- [ ] **Step 1: Rewrite the `shareAndSkipCover` helper (lines 55–62) to click Share by its new name and optionally pick a visibility inside the banner**

Replace the existing helper block with:

```tsx
// The publish flow now ALWAYS pauses on the cover-confirm banner (a screenshot is attempted after
// save()). The default Runner stub returns {ok:false}, so the banner opens with no thumbnail and
// Skip proceeds to publish with no cover. Visibility now lives IN the banner, so tests pick it
// here (after Share, before Skip); omitting `scope` publishes with the default (public).
async function shareAndSkipCover(scope?: "unlisted" | "private") {
  fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));
  if (scope) fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${scope}$`, "i") }));
  fireEvent.click(await screen.findByRole("button", { name: /^skip$/i }));
}
```

- [ ] **Step 2: Move the visibility pre-clicks into the helper call**

In the test `"scope set to Unlisted: …"` delete the line

```tsx
    fireEvent.click(await screen.findByRole("button", { name: /^unlisted$/i }));
```

and change `await shareAndSkipCover();` to `await shareAndSkipCover("unlisted");`.

In the test `"scope set to Private: …"` delete the line

```tsx
    fireEvent.click(await screen.findByRole("button", { name: /^private$/i }));
```

and change `await shareAndSkipCover();` to `await shareAndSkipCover("private");`.

- [ ] **Step 3: Rename every direct Share-button query**

Five tests query the button directly (the failed-save test, the cover-threading test, the Skip-no-cover test, the oversized-capture test, the failed-capture test). Replace **all five** occurrences of:

```tsx
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
```

with:

```tsx
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));
```

- [ ] **Step 4: Add the two new tests at the end of the describe block (before the closing `});`)**

```tsx
  it("the banner explains each visibility choice as it's selected, and marks the selection", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));

    // Default is public — its helper shows without any interaction.
    expect(await screen.findByText("Listed in Explore — anyone can find and play it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^public$/i }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /^unlisted$/i }));
    expect(screen.getByText("Anyone with the link can play; not listed in Explore.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^unlisted$/i }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^public$/i }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: /^private$/i }));
    expect(screen.getByText("Only you — lives in My apps.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^private$/i }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the toolbar hosts only actions — visibility and tags live in the share banner", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    mount();
    await screen.findByRole("button", { name: /^share$/i });
    // Before Share is clicked there is no banner — so no visibility control and no tags input anywhere.
    expect(screen.queryByRole("button", { name: /^public$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^unlisted$/i })).toBeNull();
    expect(screen.queryByPlaceholderText(/tags, comma separated/i)).toBeNull();
  });
```

- [ ] **Step 5: Run the file and verify it FAILS for the right reason**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/studio-toolbar-declutter/packages/console
pnpm exec vitest run src/panels/Play/__tests__/StudioShare.test.tsx
```

Expected: FAIL — every test times out or errors on `findByRole("button", { name: /^share$/i })` (the button is still named "Share to app.agentgem.ai"). If anything fails compiling instead, fix the test file, not the assertions.

Do NOT commit yet — red tests land together with the implementation (repo practice: CI runs on every PR commit).

---

### Task 3: Studio.tsx — toolbar strip + banner settings footer

**Files:**
- Modify: `packages/console/src/panels/Play/Studio.tsx` (toolbar JSX ~lines 508–519; cover-confirm banner ~lines 546–568; one module-scope const)

**Interfaces:**
- Consumes: the test contract from Task 2.
- Produces: `SCOPE_HELP: Record<"public" | "unlisted" | "private", string>` (module-scope const); banner markup with `.play-banner--share`, `.play-banner__opts`, `.play-seg`, `.play-banner__opts-label`, `.play-banner__opts-help`, `.play-banner__opts-spacer` classNames that Task 4 must back with CSS.

- [ ] **Step 1: Add the helper-copy const at module scope** (below the imports, above the component — near the other module-level helpers)

```tsx
// Destination-focused helper copy for the visibility choice (user-approved verbatim in the
// design spec). Keyed by the same union the `scope` state uses.
const SCOPE_HELP = {
  public: "Listed in Explore — anyone can find and play it.",
  unlisted: "Anyone with the link can play; not listed in Explore.",
  private: "Only you — lives in My apps.",
} as const;
```

- [ ] **Step 2: Strip settings from the toolbar and rename the Share button**

Replace this block (currently after the Push to git button):

```tsx
        <input className="play-tags-input" type="text" aria-label="tags" placeholder="tags, comma separated"
          value={tags} onChange={(e) => setTags(e.target.value)} />
        <div className="play-scope" role="radiogroup" aria-label="Sharing scope">
          <button type="button" className={`play-btn ${scope === "public" ? "play-btn--primary" : "play-btn--ghost"}`} aria-pressed={scope === "public"} onClick={() => setScope("public")}>Public</button>
          <button type="button" className={`play-btn ${scope === "unlisted" ? "play-btn--primary" : "play-btn--ghost"}`} aria-pressed={scope === "unlisted"} onClick={() => setScope("unlisted")}>Unlisted</button>
          <button type="button" className={`play-btn ${scope === "private" ? "play-btn--primary" : "play-btn--ghost"}`} aria-pressed={scope === "private"} onClick={() => setScope("private")}>Private</button>
        </div>
        <button className="play-btn play-btn--primary" onClick={shareToExplore}>Share to app.agentgem.ai</button>
```

with:

```tsx
        <button className="play-btn play-btn--primary" onClick={shareToExplore} title="Share to app.agentgem.ai">Share</button>
```

- [ ] **Step 3: Add the settings footer row to the cover-confirm banner**

In the `{coverStage === "confirm" && (` block: change the wrapper `<div className="play-banner">` to

```tsx
        <div className="play-banner play-banner--share">
```

and insert the footer row immediately after the Skip button (last child of the banner div, before its closing `</div>`):

```tsx
          <div className="play-banner__opts">
            <span className="play-banner__opts-label">Visibility</span>
            <div className="play-seg" role="radiogroup" aria-label="Sharing scope">
              <button type="button" aria-pressed={scope === "public"} onClick={() => setScope("public")}>Public</button>
              <button type="button" aria-pressed={scope === "unlisted"} onClick={() => setScope("unlisted")}>Unlisted</button>
              <button type="button" aria-pressed={scope === "private"} onClick={() => setScope("private")}>Private</button>
            </div>
            <span className="play-banner__opts-help" aria-live="polite">{SCOPE_HELP[scope]}</span>
            <span className="play-banner__opts-spacer" />
            <label className="play-banner__opts-label" htmlFor="play-share-tags">Tags</label>
            <input id="play-share-tags" className="play-tags-input" type="text" placeholder="tags, comma separated"
              value={tags} onChange={(e) => setTags(e.target.value)} />
          </div>
```

Notes: the tags input keeps `.play-tags-input` (rule exists) but gains a real `<label>` (fixes placeholder-as-label); the old `aria-label="tags"` is dropped in favor of the label. Do NOT touch the `scope`/`tags` useState declarations or any handler.

- [ ] **Step 4: Typecheck** (tests still red until Task 4's CSS exists is fine — CSS isn't typechecked)

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/studio-toolbar-declutter/packages/console
pnpm run typecheck
```

Expected: exit 0, no errors.

---

### Task 4: theme.css — segmented control + footer row rules (green)

**Files:**
- Modify: `packages/console/src/shell/theme.css` (remove the stale `.play-scope` rule at line ~587; add new rules next to the existing `.play-banner*` rules at ~line 714)

**Interfaces:**
- Consumes: the classNames Task 3 produced.
- Produces: nothing further.

- [ ] **Step 1: Remove the now-unused `.play-scope` rule**

Delete this line (its only consumer was the toolbar div removed in Task 3):

```css
.play-scope { display: inline-flex; gap: 6px; }
```

- [ ] **Step 2: Add the new rules directly after the existing `.play-banner--ok` rule**

```css
/* Share banner settings footer (visibility + tags moved out of the Studio toolbar).
   The banner wraps so the footer takes a full row under a hairline; wrap order at
   narrow widths: helper drops under the segmented control first, then the tags
   group takes its own line. */
.play-banner--share { flex-wrap: wrap; }
.play-banner__opts { flex-basis: 100%; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  border-top: 1px solid var(--line); margin-top: 10px; padding-top: 9px; }
.play-banner__opts-label { font: 600 11px var(--font-ui); letter-spacing: .05em; text-transform: uppercase;
  color: var(--muted); }
.play-banner__opts-help { font: 500 11.5px var(--font-ui); color: var(--muted); }
.play-banner__opts-spacer { flex: 1; }

/* Joined single-choice segmented control. Selected segment is INK, deliberately not the
   terracotta primary — the banner's one primary stays "Use this". */
.play-seg { display: inline-flex; border: 1px solid var(--line); border-radius: var(--radius);
  overflow: hidden; background: var(--raised); }
.play-seg button { font: 600 12px var(--font-ui); padding: 7px 13px; border: 0; background: transparent;
  color: var(--ink-soft); cursor: pointer; border-right: 1px solid var(--line); transition: .14s; }
.play-seg button:last-child { border-right: 0; }
.play-seg button[aria-pressed="true"] { background: var(--ink); color: var(--raised); }
.play-seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
```

- [ ] **Step 3: Verify every new className has a CSS rule** (project rule)

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/studio-toolbar-declutter/packages/console
for c in play-banner--share play-banner__opts play-banner__opts-label play-banner__opts-help play-banner__opts-spacer play-seg; do
  printf '%s: ' "$c"; grep -c "\.$c" src/shell/theme.css; done
grep -c "play-scope" src/shell/theme.css src/panels/Play/Studio.tsx || true
```

Expected: each new class ≥ 1; `play-scope` count 0 in both files.

- [ ] **Step 4: Run the test file — everything passes now**

```bash
pnpm exec vitest run src/panels/Play/__tests__/StudioShare.test.tsx
```

Expected: PASS — 17 tests (15 updated + 2 new).

- [ ] **Step 5: Commit tests + implementation + CSS together**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/studio-toolbar-declutter
git add packages/console/src/panels/Play/Studio.tsx packages/console/src/shell/theme.css packages/console/src/panels/Play/__tests__/StudioShare.test.tsx
git commit -m "feat(console): declutter Studio toolbar — visibility + tags move into the share banner

Toolbar shrinks to actions (Save · Push to git · Share · Request review).
The cover-confirm banner gains a settings footer row: an ink-selected
segmented control (single terracotta primary preserved), a destination-
focused helper line (aria-live), and the tags input with a real label.
No publish-flow logic changes — scope/tags state is read after the banner.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Full local verification + PR

**Files:** none new.

- [ ] **Step 1: Full console suite + typecheck** (console tests are NOT in CI — this is the only gate they get)

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/studio-toolbar-declutter/packages/console
pnpm run test && pnpm run typecheck
```

Expected: all console tests pass, typecheck clean. (Known flake: build.test.ts can wedge under load; workers already capped at 4. Re-run in isolation if the pool hangs.)

- [ ] **Step 2: Verify styled UI in a real browser** (jsdom can't assert appearance)

Use the project's verify skill (`.claude/skills` — the repo's recipe for building + driving the console). Reminder from repo memory: a full rebuild is root `pnpm build` (tsc -b alone leaves the console bundle stale), and the server caches the SPA at boot — restart it after rebuilding. Check:
1. Toolbar shows exactly `Save · Push to git · Share · Request review` (+ Stop while busy); Share is the only terracotta button; hover shows "Share to app.agentgem.ai".
2. Click Share on a saved miniapp → banner shows cover row, hairline, then VISIBILITY segmented control + helper + TAGS input; exactly one terracotta primary ("Use this").
3. Click Unlisted/Private → segment fills ink, helper line swaps.
4. Keyboard: Tab reaches segments, focus ring visible (terracotta outline).
5. Narrow the window (~800px) → helper wraps under the control, then tags to its own line; no horizontal scroll.

- [ ] **Step 3: Push and open a PR**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/studio-toolbar-declutter
git push -u origin studio-toolbar-declutter
gh pr create --title "feat(console): declutter Studio toolbar — visibility + tags move into the share banner" --body "$(cat <<'EOF'
## Summary
- Studio head row shrinks from 8 controls to 4 actions: Save · Push to git · **Share** (renamed from "Share to app.agentgem.ai"; destination kept as tooltip) · Request review
- Tags input + Public/Unlisted/Private move into the cover-confirm banner as a settings footer row (design spec variant C, docs/superpowers/specs/2026-07-15-studio-toolbar-declutter-design.md)
- Visibility becomes an ink-selected segmented control (.play-seg) — the banner keeps exactly one terracotta primary; a destination-focused helper line (aria-live) explains the selected choice
- No publish-flow logic changes: scope/tags state is read only after the banner resolves

## Test plan
- [ ] StudioShare.test.tsx: 15 updated + 2 new tests pass locally (console tests are not in CI)
- [ ] packages/console typecheck clean
- [ ] Real-browser check: single primary, helper swap, focus ring, narrow-width wrap

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch CI, then merge**

```bash
gh run watch $(gh run list --branch studio-toolbar-declutter --limit 1 --json databaseId -q '.[0].databaseId') --exit-status
gh pr merge --rebase --delete-branch
```

Expected: `test (24)` green, merge succeeds. The `--delete-branch` local step may error because `main` is checked out in another worktree — **the remote merge still succeeds**; verify instead of trusting the error:

```bash
git fetch origin
git show origin/main:packages/console/src/panels/Play/Studio.tsx | grep -c 'title="Share to app.agentgem.ai"'
git show origin/main:packages/console/src/shell/theme.css | grep -c 'play-seg'
```

Expected: both counts ≥ 1 (every commit's content actually landed on origin/main).
