# Task 11 report: no raw status setter on the identity context

## Status
DONE.

## Change summary
- `IdentityProvider.tsx`: removed `setStatus` from `IdentityContextValue` and the
  context value object; added `disconnect(): Promise<void>` which calls
  `bindDisconnectRoute` and applies the returned record to internal state,
  rethrowing on failure. Added a comment explaining why no raw setter is exposed
  (optimistic partial writes clobber the record `refresh()` just fetched — this
  shipped once on this branch and was reverted). `useMemo` deps updated to
  `[status, refresh, disconnect]`.
- `Settings/index.tsx`: `disconnectGitHub` now calls `bind.reset(); await
  disconnect();` inside the existing try/catch. Removed `setStatus` from the
  `useIdentity()` destructure and the now-unused `bindDisconnectRoute` import.
  `makeClient` import kept (still used by `openOnWeb` and other calls).
- Confirmed via `grep -rn "setStatus" packages/console/src` that Settings was the
  only `useIdentity().setStatus` consumer; `IdentityChip.tsx` and `Studio.tsx`
  never used it.
- Tests: added two new cases to `IdentityProvider.test.tsx` — `disconnect()`
  applies the route's returned record, and `disconnect()` rejects on a thrown
  route error (via a new `DisconnectProbe` test component). No other test files
  needed structural changes; `Settings.test.tsx`'s disconnect test spies on
  `routes.bindDisconnectRoute.call` at the module level, which still intercepts
  the call now that it originates inside the provider — no assertions changed.

## Unrepresentable-bug proof
Reintroduced the clobbering write in `IdentityChip.tsx`:
```ts
const { status, refresh, setStatus } = useIdentity();
...
const bind = useGitHubBind(apiBase, { onBound: (login) => { setStatus({ bound: true, login }); setOpen(false); } });
```
`tsc --noEmit` failed with:
```
src/identity/IdentityChip.tsx(13,28): error TS2339: Property 'setStatus' does not exist on type 'IdentityContextValue'.
```
Reverted the file; `git status --porcelain` on it is empty and `tsc --noEmit` is
clean again.

## Verification
- `pnpm -C packages/console exec vitest run` → 583 passed / 583 (99 files, 99
  passed). Baseline 581 + 2 new disconnect tests = 583.
- `pnpm -C packages/console exec tsc --noEmit` → clean, no output.
- The three pre-existing clobbering-pin tests (Settings, IdentityChip, Studio)
  all still pass (`vitest run -t "clobber"` → 3 passed, 580 skipped).

## Constraints respected
- No changes to `useGitHubBind.ts`, `ConnectGitHub.tsx`, `ConnectGitHubModal.tsx`,
  `IdentityChip.tsx`, `Studio.tsx`, `Shell.tsx`, `theme.css`, or `panels/Curate/`.
- ESM `.js` import extensions preserved.
