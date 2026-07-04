# Gem Context Lives With Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate the console's `ActiveGemSwitcher` from the top of the sidebar into the Build group, and drop the duplicate `Build · <gem>` name echo, so gem context lives with the only journey that requires a gem.

**Architecture:** A pure presentational change in one component, `packages/console/src/shell/Shell.tsx`. The switcher (`ActiveGemSwitcher`) is self-contained and portable — moving its render call is sufficient; its internals, `activeGem` store, and `registry` are untouched. Removing the Build-label suffix orphans one CSS rule and one destructured variable, both cleaned up as part of the same surgical change.

**Tech Stack:** React 18, TypeScript, Vitest + @testing-library/react. Package: `@agentgem/console`.

## Global Constraints

- Console tests and typecheck are NOT in CI — they MUST be run locally (`pnpm --filter @agentgem/console test`, `pnpm --filter @agentgem/console typecheck`).
- Surgical diff only: touch `Shell.tsx`, `Shell.test.tsx`, and the single dead CSS rule in `theme.css`. No reformatting, no unrelated edits.
- Match existing file style: double quotes, `.js` import extensions, 2-space indent.
- Commit author is `Raymond Feng <raymond@ninemind.ai>`; every commit message ends with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- Branch `feat/gem-context-build` in worktree `/Users/rfeng/Projects/ninemind/agentgem-gem-nav` (off `origin/main` @ 4ce992b).

---

## File Structure

- **Modify** `packages/console/src/shell/Shell.tsx` — move switcher render call into the Build group; simplify Build label to plain `Build`; drop `name` from the `useActiveGem()` destructure; fix the stale comment at lines 10–11.
- **Modify** `packages/console/src/shell/Shell.test.tsx` — delete the `.console-group-gem` echo test; add one regression test for the switcher's new position and the removed echo.
- **Modify** `packages/console/src/shell/theme.css` — remove the now-dead `.console-group-gem` rule (line 145).

---

### Task 1: Relocate the switcher and remove the gem-name echo

**Files:**
- Modify: `packages/console/src/shell/Shell.tsx`
- Modify: `packages/console/src/shell/theme.css`
- Test: `packages/console/src/shell/Shell.test.tsx`

**Interfaces:**
- Consumes: `ActiveGemSwitcher` (`./ActiveGemSwitcher.js`), `useActiveGem()` → `{ keys: Set<string>, name: string }`, `groupedPages(pages)` → `{ observe, build, library, settings }`. No signatures change.
- Produces: no new exported symbols. Behavioral contract for later verification: the `.console-switcher` node renders in DOM order *after* the `Build` group label; no `.console-group-gem` node exists.

- [ ] **Step 1: Replace the obsolete echo test with a relocation regression test**

In `packages/console/src/shell/Shell.test.tsx`, delete this entire test (currently ≈ lines 132–139):

```tsx
  it("echoes the active gem under the Build label (name when set, 'New Gem' when not)", () => {
    resetGem();
    const { rerender } = render(<Shell pages={pages} apiBase="" />);
    expect(document.querySelector(".console-group-gem")?.textContent).toContain("New Gem");
    act(() => { setName("shiny-kit"); setKeys(new Set(["a"])); });
    rerender(<Shell pages={pages} apiBase="" />);
    expect(document.querySelector(".console-group-gem")?.textContent).toContain("shiny-kit");
  });
```

Replace it with:

```tsx
  it("places the active-gem switcher under the Build label, not at the top of the rail", () => {
    const gp = [
      defineConsolePage({ id: "obs", title: "Observe", order: 10, group: "observe", route: "#/obs", component: () => <p>o</p> }),
      defineConsolePage({ id: "cur", title: "Curate", order: 10, group: "build", route: "#/cur", component: () => <p>c</p> }),
    ];
    const { container } = render(<Shell pages={gp} apiBase="" />);
    const switcher = container.querySelector(".console-switcher")!;
    const buildLabel = screen.getByText("Build");
    const observeItem = screen.getByText("Observe");
    // The switcher now follows the Build label in DOM order (moved into the Build section)...
    expect(buildLabel.compareDocumentPosition(switcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // ...and therefore also follows the Observe items — it is no longer pinned at the top.
    expect(observeItem.compareDocumentPosition(switcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The duplicate gem-name echo in the Build label is gone.
    expect(container.querySelector(".console-group-gem")).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/shell/Shell.test.tsx -t "places the active-gem switcher"`
Expected: FAIL — today the switcher renders *before* the Build label (so the `compareDocumentPosition` FOLLOWING assertions fail) and `.console-group-gem` still exists (so the `toBeNull` assertion fails).

- [ ] **Step 3: Relocate the switcher and simplify the Build label in `Shell.tsx`**

In `packages/console/src/shell/Shell.tsx`:

(a) Update the destructure and its comment. Change lines 10–12 from:

```tsx
  // Drives both the "Build · <gem>" subheader and the dimming of gem-scoped
  // build stages — one subscription so nav text and lock state never drift.
  const { keys, name } = useActiveGem();
```

to:

```tsx
  // Drives the dimming of gem-scoped build stages — one subscription so the
  // lock state of Build items tracks the active gem.
  const { keys } = useActiveGem();
```

(b) Remove the switcher from the top of the nav. Delete this line (currently line 56):

```tsx
        <ActiveGemSwitcher apiBase={apiBase} />
```

(c) Simplify the Build group label and render the switcher directly under it. Change the block (currently lines 60–63) from:

```tsx
        <div className="console-group-label">
          Build <span className="console-group-gem">· {name || "New Gem"}</span>
        </div>
        {groups.build.map(item)}
```

to:

```tsx
        <div className="console-group-label">Build</div>
        <ActiveGemSwitcher apiBase={apiBase} />
        {groups.build.map(item)}
```

The `WarmingPill` render (currently line 57) stays where it is, at the top of the rail.

- [ ] **Step 4: Remove the now-dead CSS rule in `theme.css`**

In `packages/console/src/shell/theme.css`, delete the `.console-group-gem` rule (line 145):

```css
.console-group-gem { color: var(--accent); text-transform: none; letter-spacing: .01em;
```

(Delete the full rule including its closing brace / continuation on the following line. Confirm no other selector references `.console-group-gem` before removing: `grep -rn "console-group-gem" packages/console/src` should return nothing after this edit.)

- [ ] **Step 5: Run the full console test file to verify green**

Run: `pnpm --filter @agentgem/console exec vitest run src/shell/Shell.test.tsx`
Expected: PASS — all tests, including the new relocation test and the unchanged switcher tests (`shows the active gem name…`, `shows 'New Gem' fallback…`, `clicking the active-gem switcher opens its dropdown menu`). Those switcher tests match `getByText("New Gem")` / `getByText("My Gem")`, which resolve to the single switcher label (the old `.console-group-gem` span held `"· New Gem"`, a different string, so removing it does not change their match count).

- [ ] **Step 6: Run the whole console suite + typecheck (guard against collateral breakage)**

Run: `pnpm --filter @agentgem/console test`
Expected: PASS — full suite.
Run: `pnpm --filter @agentgem/console typecheck`
Expected: no errors — in particular, confirm dropping `name` produced no "unused variable" or "cannot find name" error.

- [ ] **Step 7: Commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-gem-nav
git add packages/console/src/shell/Shell.tsx packages/console/src/shell/Shell.test.tsx packages/console/src/shell/theme.css
git commit -F - <<'MSG'
feat(console): move gem switcher into the Build group

A gem is only required for the Build journey, so the ActiveGemSwitcher no
longer sits at the top of the rail implying app-global scope. It now renders
directly under the Build group label, above the gem-scoped Build stages. The
redundant "Build · <gem>" name echo (and its .console-group-gem CSS) is
removed — gem identity now appears once, in the switcher.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
MSG
```

---

### Task 2: Verify live in the browser

**Files:** none (verification only; make code changes only if a defect surfaces, then re-run Task 1's Steps 5–7).

**Interfaces:**
- Consumes: the built console served by the local AgentGem host.
- Produces: confirmation the change behaves in a real browser.

- [ ] **Step 1: Build the console client**

Run: `pnpm --filter @agentgem/console build`
Expected: build succeeds, emits client bundle.

- [ ] **Step 2: Launch the app and open the console**

Use the project's run path (the desktop Electron host or the core server that serves the console). If unsure how this project launches, invoke the `/run` skill to start it and open the console UI.

- [ ] **Step 3: Visually confirm the new layout**

Check, in the left rail:
- The `New Gem ▾` switcher renders under the **Build** group label, directly above Curate/Materialize/… — NOT at the top under the brand.
- `WarmingPill` (when warming) still sits at the top of the rail.
- The Build label reads plain **Build** with no `· New Gem` / `· <name>` suffix.
- Observe and Library groups have no gem chrome above them.

- [ ] **Step 4: Confirm switcher behavior is intact**

- Click the switcher → dropdown opens with recent gems, `＋ New Gem`, and `Browse all →`.
- `＋ New Gem` resets to a fresh gem and navigates to `#/curate`.
- With no active gem, the `requiresGem` Build stages appear dimmed (`is-locked`); selecting/creating a gem un-dims them.

- [ ] **Step 5: Eyeball spacing**

Confirm the switcher and the Build label are not visually cramped. Only if cramped, adjust spacing minimally (e.g. a small `margin-top` on `.console-switcher` when it follows a group label) and re-run Task 1 Steps 5–7. Otherwise no CSS change.

---

## Self-Review

**Spec coverage:**
- Relocate switcher under Build label → Task 1 Step 3(b,c). ✓
- Drop `Build · <name>` echo + `.console-group-gem` span → Task 1 Step 3(c). ✓
- Remove dead `.console-group-gem` CSS → Task 1 Step 4. ✓
- Drop unused `name` destructure → Task 1 Step 3(a). ✓
- Fix stale comment at Shell.tsx:10–11 → Task 1 Step 3(a). ✓
- WarmingPill stays at top → Task 1 Step 3(b) note. ✓
- Delete `.console-group-gem` echo test → Task 1 Step 1. ✓
- Switcher tests stay green (single "New Gem" match) → Task 1 Step 5 note. ✓
- `getByText("Build")` group-label test still holds → label text is still exactly `Build`; covered by Step 6 full suite. ✓
- Verification: console tests + typecheck + browser dogfood → Task 1 Steps 5–6, Task 2. ✓

**Placeholder scan:** No TBD/TODO; every code and command step shows exact content. Task 2 is verification-only by design (no code to pre-write); its one conditional edit points back to Task 1's cycle. ✓

**Type consistency:** `useActiveGem()` still returns `{ keys, name }`; we simply stop destructuring `name`. `groupedPages` return shape and `ActiveGemSwitcher`'s `{ apiBase }` prop are unchanged. New test uses valid `group: "observe"` (per `contract.ts:9`). ✓
