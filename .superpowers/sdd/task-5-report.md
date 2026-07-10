# Task 5 report — Setup panel lazy-load artifact bodies

## What was done

- `packages/console/src/panels/Setup/index.tsx`
  - Mount effect now requests `body: "defer"` on `inventoryRoute.call` (both the
    project-scoped and global query branches), so the initial `/api/inventory` fetch
    drops inline `content` from the top-level `skills`/`subagents`/`instructions`
    lists. `inventory.projects[]` is untouched server-side, so project artifacts still
    arrive with inline `content` and no `id`.
  - `ArtifactViewer` now receives `apiBase` (threaded from `Setup`'s render call) and
    owns `lazyBody`/`lazyErr` state plus a `useEffect` that fetches
    `artifactContentRoute` by `a.id` only when `a.content === undefined && a.id` is
    truthy — i.e. never for project artifacts (no `id`), and never redundantly for
    artifacts that already carry inline `content`.
  - On a successful fetch, `lazyErr` is explicitly cleared (`setLazyErr(null)`) before
    setting the body, matching the discipline from the sibling Curate fix
    (`be7ff2ab`) that a later success must not leave a stale error blocking render.
    The modal body IIFE checks `lazyErr` before `body`, then falls through to a
    "Loading…" state while `a.id` is set but neither body nor error has landed yet,
    and finally to the pre-existing config/`(no file body…)` fallback.
  - Both effects use an `alive` flag guarding `setState` after unmount/dependency
    change, consistent with the rest of the file.

- `packages/console/src/panels/Setup/Setup.test.tsx`
  - Reshaped the shared `inv` fixture: the global `brainstorming` skill now carries
    `id: "workspace/skills/superpowers/brainstorming"` and no `content` (what
    `?body=defer` returns).
  - Added two new tests, following this file's existing convention of stubbing the
    global `fetch` and switching on URL (not `artifactContentRoute.call = vi.fn(...)`
    as the brief literally wrote):
    - `"lazily loads a deferred global artifact body when the modal opens"` — stubs
      `/api/artifact/content` to return `LAZY-SETUP-BODY`, opens brainstorming's
      modal, asserts the body renders.
    - `"renders a project artifact's inline body without fetching (it has no id)"` —
      reuses the existing "shows project artifacts with a layer badge" test's
      scope-picker interaction pattern (stub `/api/testbed/recents`,
      `/api/testbed/projects`, `/api/inventory` keyed on the `projects` query param)
      with an inventory `projects: [{ root: "/p", ..., skills: [{ ..., content:
      "PROJECT-BODY" }] }]`. After switching to project scope and opening
      `proj-skill`'s modal, asserts `PROJECT-BODY` renders and that no call ever hit
      `/api/artifact/content` (`fetchSpy.mock.calls.some(...)` is `false`) — a
      zero-request assertion on the fetch spy itself, matching the brief's intent
      without touching `artifactContentRoute.call`.
  - Used `.toBeTruthy()` on `findByText(...)` results in the new tests, not
    `.toBeInTheDocument()` — this repo's Vitest config does not register jest-dom
    matchers (confirmed: `toBeInTheDocument` threw `Invalid Chai property` on first
    run), and every other test in the file already uses `.toBeTruthy()`.

## Pre-existing assertion adjusted

Reshaping the fixture (removing `brainstorming`'s inline `content`) broke
`"opens the viewer for an artifact addressed by #/setup/<tab>?a=<name>"`, which
previously asserted `screen.getByText(/full skill body/)` synchronously off the
inline-content fixture. Fixed in place (same behavior, now exercised through the lazy
path) by:
- Switching that test's `fetch` stub to a URL-aware mock that returns
  `{ id: "workspace/skills/superpowers/brainstorming", content: "full skill body" }`
  from `/api/artifact/content`.
- Changing the assertion from `getByText` to `await screen.findByText(...)` since the
  body now arrives asynchronously.

No test was deleted; the test still verifies "opening a deep-linked artifact renders
its body via `ContentView`", just now via the fetch-by-id path instead of inline
content.

## Commands run, in order

```bash
# Baseline (before any change)
pnpm -C packages/console exec vitest run src/panels/Setup/Setup.test.tsx
# -> 14 passed (14)

# Step 1: failing test written, run to confirm failure
pnpm -C packages/console exec vitest run src/panels/Setup/Setup.test.tsx
# -> 2 failed | 14 passed (16)
#    FAIL  opens the viewer for an artifact addressed by #/setup/<tab>?a=<name>
#      (rendered "(no file body for this artifact)" instead of "full skill body")
#    FAIL  lazily loads a deferred global artifact body when the modal opens
#      (timed out waiting for /LAZY-SETUP-BODY/, same fallback text rendered)
#    (the third new test, "renders a project artifact's inline body without
#     fetching", already passed pre-implementation — project-artifact inline
#     rendering was already correct in the existing code; only the lazy-fetch
#     path for global artifacts was missing)

# Step 3/4: implementation, run to confirm pass
pnpm -C packages/console exec vitest run src/panels/Setup/
# -> Test Files  1 passed (1)
#    Tests  16 passed (16)

# Typecheck
pnpm -C packages/console exec tsc --noEmit
# -> (no output, clean)

# Regression check on the sibling panel that shares the lazy-load pattern
pnpm -C packages/console exec vitest run src/panels/Curate/
# -> Test Files  7 passed (7)
#    Tests  60 passed (60)
```

## Commit

`f4704661915b112d564fedfe1dcca13231d79107` on branch `feat/inventory-defer-body`:

```
feat(console): Setup lazily loads artifact bodies on modal open

Global artifacts arrive deferred (?body=defer) and load by id when the modal
opens; project artifacts keep inline bodies (the entity-address scheme has no
project-scoped path yet) and never fetch.
```

Diff scope: exactly the two permitted files —
`packages/console/src/panels/Setup/index.tsx` (+36/-8) and
`packages/console/src/panels/Setup/Setup.test.tsx` (+62/-3). No server files touched.

## Concerns

- One pre-existing test assertion was adjusted (see above) because reshaping the
  shared `inv` fixture to make `brainstorming` deferred was necessary to exercise the
  new lazy-load path realistically — this was anticipated and pre-approved by the
  task instructions ("fix the assertion so it still tests the same behavior").
- `ArtifactViewer` does not `key`-reset `lazyBody`/`lazyErr` between two different
  deferred artifacts, since it relies on React state naturally resetting only on
  unmount. This is safe in practice because Setup's modal can only be reached via a
  full close (`onClose` clears `?a=`, unmounting the viewer) before a different
  artifact's `?a=` link opens a new one — the backdrop `onClick={onClose}` makes it
  impossible to click a different list item while the modal is open. Flagged per the
  brief's explicit ask to note this ordering/consistency discipline; no code change
  was needed given that invariant.
- Found (and overwrote) that `.superpowers/sdd/task-5-report.md` already existed in
  this worktree with unrelated content ("Goldmine Context Assembler" — a different
  task-5 from another plan/numbering series, referencing `packages/insight/`, not
  this brief). It did not match `task-5-brief.md` in the same directory, which is the
  Setup panel work. Replaced it with this report; flagging in case that stale content
  indicates cross-contamination between worktrees or plans worth checking.

## Fix pass

The "no code change needed" call above was wrong. The invariant it leaned on — "the
modal can only be reached via a full close before a different artifact's `?a=` link
opens a new one" — only holds for *click*-driven navigation, where the backdrop's
`onClick={onClose}` blocks reaching another list item while the modal is open. It
does not hold for **hash-driven** navigation: the `hashchange` listener
(`index.tsx:99-109`) calls `setOpenName(p.a)` unconditionally, with no route through
`closeViewer`. Browser back/forward, or any other panel deep-linking straight to
`#/setup/<tab>?a=<name>` (a documented cross-panel entry point — see the file-header
comment at `index.tsx:17-19`), can drive the hash from artifact A directly to
artifact B while the modal stays open. Because `<ArtifactViewer>` was unkeyed, React
reconciled it as the *same* component instance across that transition (same position,
same type) — the new `a` prop switched the title, but the old `lazyBody`/`lazyErr`
state survived, so the modal briefly (or indefinitely, if B's fetch is slow, fails,
or never resolves) showed the wrong artifact's body under the new artifact's title.

**Fix:** give the `<ArtifactViewer>` element a `key={selected.artifact.id ?? selected.artifact.name}`
at its render site (`index.tsx:179`, inside `Setup`). Keying on artifact identity
makes React unmount/remount the component whenever the addressed artifact changes,
which discards `lazyBody`/`lazyErr` as a side effect of the remount — no manual
`useEffect` reset (which would race a fast-resolving new fetch against a slower state
clear) is needed.

**Covering test:** `packages/console/src/panels/Setup/Setup.test.tsx`, new case
`"discards a stale body when the hash switches directly from one deferred artifact to
another"`. Two deferred global skills (`brainstorming` → `BODY-A`,
`second` → held pending forever, so the bug is a sustained wrong-body render rather
than a one-frame flicker). Opens `brainstorming`, awaits `BODY-A`, then drives the
hash straight to `second` via the file's existing `setHash()` helper without closing
the modal, and asserts the dialog's `aria-label` is now `"second"` while
`screen.queryByText("BODY-A")` is `null`.

Commands run from `/Users/rfeng/Projects/ninemind/agentgem-defer-body`:

```
pnpm -C packages/console exec vitest run src/panels/Setup/
pnpm -C packages/console exec tsc --noEmit
```

Pre-fix (unkeyed `<ArtifactViewer>`, `index.tsx:179` reverted via `git stash` of just
that file) — the new test fails, all 16 pre-existing tests still pass:

```
 ❯ src/panels/Setup/Setup.test.tsx (17 tests | 1 failed) 293ms
     × discards a stale body when the hash switches directly from one deferred artifact to another 18ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/panels/Setup/Setup.test.tsx > Setup > discards a stale body when the hash switches directly from one deferred artifact to another
AssertionError: expected <p></p> to be null

- Expected:
null

+ Received:
<p>
  BODY-A
</p>

 ❯ src/panels/Setup/Setup.test.tsx:160:42
    158|     setHash("#/setup/skills?a=second");
    159|     await waitFor(() => expect(screen.getByRole("dialog").getAttribute…
    160|     expect(screen.queryByText("BODY-A")).toBeNull();
       |                                          ^
    161|   });

 Test Files  1 failed (1)
      Tests  1 failed | 16 passed (17)
```

Post-fix (`key={selected.artifact.id ?? selected.artifact.name}` restored) — all 17
pass:

```
 Test Files  1 passed (1)
      Tests  17 passed (17)
   Start at  23:23:15
   Duration  841ms (transform 69ms, setup 26ms, import 144ms, tests 287ms, environment 320ms)
```

`pnpm -C packages/console exec tsc --noEmit` produced no output (clean).

Only `packages/console/src/panels/Setup/index.tsx` (the one-line `key` addition plus
comment) and `packages/console/src/panels/Setup/Setup.test.tsx` (the new test) were
changed for this pass; no other files touched.
