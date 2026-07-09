# Task 6: ConnectGitHubModal — Report

## Files touched
- `packages/console/src/identity/ConnectGitHubModal.tsx` — created
- `packages/console/src/identity/__tests__/ConnectGitHubModal.test.tsx` — created
- `packages/console/src/shell/theme.css` — appended `.identity-modal` block after `.setup-config` rule

## TDD Flow

### Step 1: RED — Write test (from brief, lines 19–70)
Created `ConnectGitHubModal.test.tsx` with 5 test cases.

### Step 2: RED — Run to verify failure
```
pnpm -C packages/console exec vitest run src/identity/__tests__/ConnectGitHubModal.test.tsx
```

Output:
```
FAIL  src/identity/__tests__/ConnectGitHubModal.test.tsx
Error: Failed to resolve import "../ConnectGitHubModal.js" from "src/identity/__tests__/ConnectGitHubModal.test.tsx". Does the file exist?
  Plugin: vite:import-analysis
```

Expected failure: component does not yet exist.

### Step 3: Implement (from brief, lines 82–124)
Created `ConnectGitHubModal.tsx` and appended `.identity-modal` CSS block to `theme.css`.

### Step 4: First GREEN attempt — Partial failure
```
pnpm -C packages/console exec vitest run src/identity/__tests__/ConnectGitHubModal.test.tsx
```

Output:
```
 ❯ src/identity/__tests__/ConnectGitHubModal.test.tsx (5 tests | 1 failed) 60ms
   × ConnectGitHubModal > renders a labelled modal dialog wrapping ConnectGitHub 46ms
     → Unable to find an accessible element with the role "button" and name `/connect github/i`
```

Tests passed: 4/5. Failure root cause: Test expected button with "Connect GitHub" but implementation had `idleLabel="Sign in with GitHub"` (contradiction in brief's code vs. test).

### Step 5: Fix and GREEN
Changed line 117 of `ConnectGitHubModal.tsx` from `idleLabel="Sign in with GitHub"` to `idleLabel="Connect GitHub"` to match test expectation (TDD: test is spec).

```
pnpm -C packages/console exec vitest run src/identity/__tests__/ConnectGitHubModal.test.tsx
```

Output:
```
 ✓ src/identity/__tests__/ConnectGitHubModal.test.tsx (5 tests) 47ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
 Start at  20:46:22
 Duration  408ms
```

All 5 tests pass.

## Deviation from Brief

**Found contradiction in brief itself** (not a design flaw — genuine inconsistency):
- Test (line 40): expects button name `/connect github/i`
- Implementation code (line 117): `idleLabel="Sign in with GitHub"`

These strings do not match. Per TDD principle (test is spec), changed implementation's `idleLabel` to `"Connect GitHub"` to pass the test. This is the only deviation from the brief's verbatim code.

## Commit

```bash
git add packages/console/src/identity/ConnectGitHubModal.tsx \
  packages/console/src/identity/__tests__/ConnectGitHubModal.test.tsx \
  packages/console/src/shell/theme.css
git commit -m "feat(console): ConnectGitHubModal for signing in from the shell"
```

**Commit SHA:** `c31e100b`

## Self-review

✓ All 5 tests pass (dialog role/aria, Escape close, overlay vs. panel click distinction, close button, device code display)
✓ Modal owns `.identity-modal` classes (no coupling to Setup's `.setup-modal`)
✓ CSS appended after `.setup-config` as specified
✓ Only existing CSS variables used
✓ Single warm-paper theme (no dark-mode variant added)
✓ Only touched the three target files (no refactoring of existing modals)
✓ Proper React hooks (useEffect), .js imports, copyright header
✓ Caller owns `bind` object and responsible for `bind.reset()` on close per spec

## Correction (post-hoc)

The original resolution above was wrong: it treated the brief's *test* as the
spec and changed the component to match, deleting the intended
`idleLabel="Sign in with GitHub"`. But the modal is the sign-in surface for
Task 7's `IdentityChip`, whose tests click a button named
`/sign in with github/i` inside this modal. The brief's test was the actual
error, not the component code.

Fix applied:
- `ConnectGitHubModal.tsx`: restored `idleLabel="Sign in with GitHub"` on the
  `<ConnectGitHub>` it renders.
- `ConnectGitHubModal.test.tsx`: updated the one button-role assertion to
  expect `/sign in with github/i`; left the `aria-label` "Connect GitHub"
  dialog-title assertion untouched; added a new test pinning that the two
  labels are intentionally distinct (dialog title "Connect GitHub" vs. idle
  button "Sign in with GitHub").

Verified `pnpm -C packages/console exec vitest run src/identity/`: 30 tests
pass (5 IdentityProvider + 10 useGitHubBind + 9 ConnectGitHub + 6
ConnectGitHubModal, the last including the new distinctness assertion).
Confirmed `ConnectGitHub.tsx`'s default `idleLabel` remains `"Connect
GitHub"` and that `ConnectGitHub.tsx`, `useGitHubBind.ts`, and
`IdentityProvider.tsx` were not modified.

**Commit SHA:** `14fffda0618b4bdd466549f8317882f5e4ea0bcf`
