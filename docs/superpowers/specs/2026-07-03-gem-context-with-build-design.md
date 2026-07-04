# Gem context lives with Build — sidebar IA change

**Date:** 2026-07-03
**Branch:** `feat/gem-context-build` (off `origin/main` @ 4ce992b)
**Status:** approved design, pre-implementation

## Problem

The console left rail pins the `ActiveGemSwitcher` at the very top, under the
brand and above the Observe group. That placement implies the active gem scopes
the *whole* app. It does not: a gem is only required for the **Build** journey
(Curate → Materialize → Publish …). Observe and Library need no gem. The
top-of-rail placement therefore misrepresents scope, and the gem name is shown
twice — once in the switcher (`New Gem ▾`) and again in the Build group label
(`Build · New Gem`, rendered via `.console-group-gem`).

## Goal

Move the gem context to sit with the journey it actually scopes, and remove the
duplicate gem-name echo. Success = the switcher renders directly under the
`Build` group label, immediately above the Build stages; the `Build · <name>`
suffix is gone; Observe/Library have no gem chrome above them; all console tests
green.

## Non-goals

- No separate always-visible `＋ New Gem` button. Creating a fresh gem already
  lives in the switcher's dropdown (`＋ New Gem`), which now sits at Build. A
  dedicated one-click create action is a possible trivial follow-up, explicitly
  out of scope here.
- No change to `ActiveGemSwitcher.tsx` internals, `registry.ts`, or
  `activeGem.ts`. The switcher is self-contained and portable.
- No relocation of `WarmingPill` — it reflects app-global background-warming
  state, not the active gem, so it stays at the top of the rail.

## Design

### Rail order (after)

```
AgentGem                     brand
[WarmingPill]                stays at top (app-global)

OBSERVE                      group label
  Observe / Watch / Insights / …

BUILD                        group label — now just "Build" (no "· name")
  [ New Gem ▾ ]              ActiveGemSwitcher moves HERE
  Curate / Materialize / …   requiresGem stages dim directly below the switcher

LIBRARY
  …
─────────
⚙ Settings                   footer, unchanged
```

### Changes — all in `packages/console/src/shell/Shell.tsx`

1. **Relocate the switcher.** Remove `<ActiveGemSwitcher apiBase={apiBase} />`
   from its current position (line 56, between brand and `WarmingPill`) and
   render it immediately after the Build group label, before
   `{groups.build.map(item)}`.
2. **Simplify the Build label.** Replace

   ```tsx
   <div className="console-group-label">
     Build <span className="console-group-gem">· {name || "New Gem"}</span>
   </div>
   ```

   with a plain `<div className="console-group-label">Build</div>`. The switcher
   directly below now carries gem identity, so the `.console-group-gem` span is
   deleted.
3. **`name` usage.** After removing the label suffix, `name` from
   `useActiveGem()` is no longer read in `Shell.tsx` (the switcher reads its own
   copy internally). Drop `name` from the destructure; keep `keys`/`hasGem` for
   the `is-locked` dimming of gem-scoped stages.
4. **Fix the now-stale comment** at `Shell.tsx:10–11`. It currently reads that
   the `useActiveGem()` subscription "Drives both the 'Build · <gem>' subheader
   and the dimming of gem-scoped build stages." Once the subheader is gone, the
   subscription only drives the dimming — update the comment to say just that,
   so it doesn't describe removed behavior.

### Why this reads well

The locked (`is-locked`) Build stages now sit directly beneath the very control
that unlocks them — "pick or create a gem here → these light up." The
gem-independent Observe and Library journeys no longer have gem chrome floating
above them. The gem name appears exactly once, next to the workflow it scopes.

## CSS

No speculative CSS. `.console-switcher { margin-bottom: 4px }` and
`.console-group-label` margins should compose fine when adjacent. Verify the
spacing live in the browser after the change and nudge only if cramped. The now
unused `.console-group-gem` rule (theme.css:145) is dead after the label
simplification — remove it as part of the surgical change since our change is
what orphans it.

## Tests — `packages/console/src/shell/Shell.test.tsx`

- **Delete** `"echoes the active gem under the Build label (name when set,
  'New Gem' when not)"` (≈line 132). It asserts `.console-group-gem`
  `textContent`; that element is intentionally removed.
- The switcher tests (`"shows the active gem name in the switcher"`,
  `"shows 'New Gem' fallback"`, `"clicking the active-gem switcher opens its
  dropdown menu"`, ≈lines 99–118) become *more* robust: after dropping the label
  suffix there is a single `"New Gem"` string in the DOM, so `getByText("New
  Gem")` is unambiguous. Confirm they still pass; no logic change expected.
- The `"nav renders Build group label"` test (≈line 126, asserts
  `getByText("Build")`) still holds — the label text is still exactly `Build`.

## Verification

- `pnpm test` in `packages/console` (console tests are NOT in CI — must run
  locally) and a typecheck.
- Drive the console in the browser: confirm the switcher sits under `Build`,
  Observe/Library have no gem chrome, the dropdown still opens with `＋ New Gem`
  and recent gems, and the requiresGem Build stages dim/undim correctly as the
  active gem changes.
