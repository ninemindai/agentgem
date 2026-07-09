# Task 8 report: mount IdentityProvider + IdentityChip in Shell

## Files touched

- `packages/console/src/shell/Shell.tsx` — imports + provider wrap + footer chip.
- `packages/console/src/shell/Shell.test.tsx` — one new test appended to the existing
  top-level `describe("Shell — phase-primary nav")`.

No other files were touched (not `theme.css`, not `identity/`, not `panels/`).

## Commands run

```bash
pnpm -C packages/console exec vitest run src/shell/Shell.test.tsx   # before wiring: expect FAIL
pnpm -C packages/console exec vitest run src/shell/Shell.test.tsx   # after wiring: expect PASS
pnpm -C packages/console exec vitest run src/shell/                 # full shell suite
pnpm -C packages/console exec tsc --noEmit                          # typecheck
```

(Ran with `pnpm -C packages/console exec vitest …` per the worktree note — plain
`pnpm -C packages/console vitest …` does not resolve here.)

## Step 1–2: failing test (before wiring Shell.tsx)

Added, verbatim from the brief, to `Shell.test.tsx`:

```tsx
  it("renders the identity chip in the footer, unbound when the daemon is unreachable", async () => {
    render(<Shell pages={pages} apiBase="" />);
    expect(await screen.findByRole("button", { name: /sign in/i })).toBeTruthy();
  });
```

Verbatim failing output:

```
 ❯ waitForWrapper ../../node_modules/.pnpm/@testing-library+dom@10.4.1/node_modules/@testing-library/dom/dist/wait-for.js:163:27
 ❯ ../../node_modules/.pnpm/@testing-library+dom@10.4.1/node_modules/@testing-library/dom/dist/query-helpers.js:86:33
 ❯ src/shell/Shell.test.tsx:167:25
    165|   it("renders the identity chip in the footer, unbound when the daemon…
    166|     render(<Shell pages={pages} apiBase="" />);
    167|     expect(await screen.findByRole("button", { name: /sign in/i })).to…
       |                         ^
    168|   });
    169| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 15 passed (16)
```

Unable to find "sign in" — confirms the chip isn't mounted yet, and confirms all 15
pre-existing tests still pass on the unmodified `Shell.tsx` (baseline).

## Step 3: wiring Shell.tsx

Added two imports:

```tsx
import { IdentityProvider } from "../identity/IdentityProvider.js";
import { IdentityChip } from "../identity/IdentityChip.js";
```

Wrapped the returned tree in `<IdentityProvider apiBase={apiBase}>` just inside
`<ToastProvider>`, and appended `<IdentityChip apiBase={apiBase} />` to the existing
`.console-footer` div after `{footer.map(item)}`. No other line was touched — the
open/close tags for `IdentityProvider` were added without reindenting the JSX
between them, keeping the diff to insertions only (see full diff below).

## Step 4: passing run (after wiring)

```
 RUN  v3.2.6 /Users/rfeng/Projects/ninemind/agentgem-identity-chip/packages/console

 ✓ src/shell/Shell.test.tsx (16 tests) 112ms

 Test Files  1 passed (1)
      Tests  16 passed (16)
   Start at  21:04:09
   Duration  576ms (transform 93ms, setup 21ms, collect 164ms, tests 112ms, environment 181ms, prepare 33ms)
```

All 16 tests pass, including the 15 pre-existing ones — no re-scoping was needed.
None of the existing tests queried the footer broadly enough to collide with the new
`<button>` (they target specific `name`s like `"watch"`, `"curate"`, `/notification/i`,
radios by name, etc.), so no pre-existing assertion had to be weakened or narrowed.

Full shell suite:

```
 RUN  v3.2.6 /Users/rfeng/Projects/ninemind/agentgem-identity-chip/packages/console

 ✓ src/shell/Toast.test.tsx (4 tests) 46ms
 ✓ src/shell/useRovingTabIndex.test.tsx (5 tests) 50ms
 ✓ src/shell/ActiveGemSwitcher.test.tsx (8 tests) 74ms
 ✓ src/shell/Shell.test.tsx (16 tests) 129ms

 Test Files  4 passed (4)
      Tests  33 passed (33)
   Start at  21:03:44
   Duration  614ms (transform 145ms, setup 56ms, collect 446ms, tests 299ms, environment 828ms, prepare 142ms)
```

No unhandled-rejection noise printed (checked via `grep -i "unhandled\|reject"` on
the run output — no matches), confirming `IdentityProvider`'s `refresh()` correctly
catches the rejected `fetch` from the unstubbed test environment and degrades to
`{bound:false}` rather than leaking a rejection.

## Typecheck

```
pnpm -C packages/console exec tsc --noEmit
```

```
src/panels/Observe/index.tsx(6,34): error TS2307: Cannot find module '@agentgem/insight/observeAggregate' or its corresponding type declarations.
src/panels/Observe/useObserveData.ts(3,34): error TS2307: Cannot find module '@agentgem/insight/observeAggregate' or its corresponding type declarations.
src/panels/Play/mcpHostTools.ts(6,32): error TS2307: Cannot find module '@agentgem/play' or its corresponding type declarations.
src/panels/Sessions/index.tsx(4,34): error TS2307: Cannot find module '@agentgem/insight/observeAggregate' or its corresponding type declarations.
```

All four are pre-existing errors from unbuilt workspace packages (`@agentgem/insight`,
`@agentgem/play`), unrelated to `shell/` or `identity/`. Nothing new appeared under
`shell/`.

## Full `git diff` of `Shell.tsx`

```diff
diff --git a/packages/console/src/shell/Shell.tsx b/packages/console/src/shell/Shell.tsx
index d36fdb89..b6df326b 100644
--- a/packages/console/src/shell/Shell.tsx
+++ b/packages/console/src/shell/Shell.tsx
@@ -7,6 +7,8 @@ import { useRovingTabIndex } from "./useRovingTabIndex.js";
 import { ToastProvider } from "./Toast.js";
 import { NotificationsProvider } from "../notify/NotificationsProvider.js";
 import { NotifyBell } from "../notify/NotifyBell.js";
+import { IdentityProvider } from "../identity/IdentityProvider.js";
+import { IdentityChip } from "../identity/IdentityChip.js";
 
 const PHASES: { id: Phase; label: string }[] = [
   { id: "observe", label: "Observe" },
@@ -137,6 +139,7 @@ export function Shell({ pages, apiBase }: { pages: ConsolePage[]; apiBase: strin
 
   return (
     <ToastProvider>
+      <IdentityProvider apiBase={apiBase}>
       <div className="console">
         <nav className="console-nav">
           <div className="console-brand">
@@ -170,11 +173,12 @@ export function Shell({ pages, apiBase }: { pages: ConsolePage[]; apiBase: strin
               {g.pages.map(item)}
             </div>
           ))}
-          <div className="console-footer"><NotifyBell />{footer.map(item)}</div>
+          <div className="console-footer"><NotifyBell />{footer.map(item)}<IdentityChip apiBase={apiBase} /></div>
         </nav>
         <main className="console-main">{ActivePage ? <ActivePage apiBase={apiBase} /> : null}</main>
         <NotificationsProvider apiBase={apiBase} />
       </div>
+      </IdentityProvider>
     </ToastProvider>
   );
 }
```

6 lines changed (4 added + 1 modified + 1 added closing tag, counted as 6 `+` lines and
1 `-` line by `git diff --stat`): `packages/console/src/shell/Shell.tsx | 6 +-`.
Every other line — brand block, `WarmingPill`, phase switch, `ActiveGemSwitcher`, nav
groups, `console-main`, `NotificationsProvider` — is byte-for-byte unchanged. The
`<IdentityProvider>`/`</IdentityProvider>` tags were deliberately added without
reindenting the JSX between them, to keep the diff to pure insertions plus the one
footer line.

## Pre-existing tests re-scoped

None. All 15 pre-existing `Shell.test.tsx` tests passed unmodified after wiring —
none of them queried the footer broadly enough to collide with the new chip button.

## Self-review

- Interfaces (`IdentityProvider({ apiBase, children })`, `IdentityChip({ apiBase })`)
  used exactly as specified; not modified.
- `IdentityProvider` placed just inside `ToastProvider`, wrapping the whole tree, so
  any future panel under `console-main` can call `useIdentity()`.
- `IdentityChip` placed inside `.console-footer`, after `{footer.map(item)}`, per
  the brief.
- Diff to `Shell.tsx` is minimal: 2 new imports, 1 open tag, 1 close tag, 1 line
  edited (footer div). No reformatting, no reindentation, no reordering.
- Test suite green (33/33 in `src/shell/`), typecheck has only expected pre-existing
  errors outside `shell/`.
- Only `Shell.tsx` and `Shell.test.tsx` were modified; `identity/`, `panels/`,
  `theme.css`, and `src/` root were untouched.
- An unrelated pre-existing unstaged change to `.superpowers/sdd/task-5-report.md`
  exists in this worktree (not from this task) — left untouched and excluded from
  the commit.
