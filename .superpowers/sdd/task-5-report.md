# Task 5 Report: Migrate PublishToExplore onto the shared identity hook

## Status
DONE

## Files touched
- `packages/console/src/panels/Curate/PublishToExplore.tsx` — deleted the local
  `bindStatus`/`connecting`/`connectBusy`/`polling`/`codeCopied` state, the
  `bindStatusRoute` effect, and the local `connectGitHub`/`copyOpenAndWait`. Now
  consumes `useIdentity()` for status and `useGitHubBind(apiBase)` for the flow, and
  renders `<ConnectGitHub bind={bind} idleHint={…} />`. Scope prefill moved into an
  effect keyed on `[bindStatus?.bound, bindStatus?.login]`, keeping the `cur || …`
  guard.
- `packages/console/src/panels/Curate/PublishToExplore.test.tsx` — wrapped every
  render in a new `renderPublish()` helper (`<IdentityProvider apiBase="">`), made the
  device-flow test's `/api/bind/status` stub stateful (reflects the bind after
  `/api/bind/complete`), and added one new test for the scope-prefill guard.
- `packages/console/src/panels/Curate/Curate.test.tsx` — **collateral fix, not in the
  brief's file list.** `Curate/index.tsx` mounts `PublishToExplore` (unconditionally
  reading `useIdentity()`) whenever `showPublish` is true. Since `IdentityProvider`
  isn't mounted in `Shell.tsx` yet (that's Task 8), 3 of 17 `Curate.test.tsx` tests
  that open the publish form started throwing `useIdentity must be used inside
  <IdentityProvider>` after the migration. Added the same `renderCurate()` wrapper
  and replaced all 17 `render(<Curate apiBase="" />)` calls (they all pass identical
  props, so this was a safe mechanical replacement) — no `expect(...)` line changed.

No changes to `src/identity/`, `src/`, `Shell.tsx`, `panels/Settings/`,
`panels/Setup/`, or `panels/Play/`.

## Commands run (exact)

```
pnpm -C packages/console exec vitest run src/panels/Curate/PublishToExplore.test.tsx
pnpm -C packages/console exec vitest run src/panels/Curate/Curate.test.tsx
pnpm -C packages/console exec vitest run
pnpm -C packages/console exec tsc --noEmit
```

(`pnpm -C packages/console vitest …` does not resolve in this worktree, per the
brief — used `exec` throughout.)

## Step 1 — wrap in IdentityProvider, before migrating (brief predicted FAIL)

Wrapped all `render(<PublishToExplore …/>)` calls in `renderPublish()` while the
component still owned its own `bindStatus` state (not reading context). Ran:

```
$ pnpm -C packages/console exec vitest run src/panels/Curate/PublishToExplore.test.tsx

 RUN  v3.2.6 .../packages/console
 ✓ src/panels/Curate/PublishToExplore.test.tsx (6 tests) 110ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

**This did not fail**, unlike the brief's prediction. Reason: at this point the
component still fetched its own `bindStatus` directly and never called `useIdentity()`
— wrapping it in a provider it doesn't consume is a no-op. The brief's "watch it fail"
assumption holds once the component is actually migrated to read the context (see
next run), so I proceeded to Step 3 rather than treating this as a blocker.

## Step 3/4 — migrate, run again (this DID reproduce the documented trap)

After migrating to `useIdentity()` + `useGitHubBind()`, first run without fixing the
stub:

```
$ pnpm -C packages/console exec vitest run src/panels/Curate/PublishToExplore.test.tsx

 ❯ src/panels/Curate/PublishToExplore.test.tsx:107:11
    105|     fireEvent.click(screen.getByRole("button", { name: /copy code & op…
    106|     expect(openSpy).toHaveBeenCalledWith("https://github.com/login/dev…
    107|     await waitFor(() => expect(screen.getByText(/verified as @octocat/…
       |           ^
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
```

Exactly the trap described in the assignment: the device-flow test's
`/api/bind/status` stub returned `{ bound: false }` unconditionally, so
`useGitHubBind`'s post-success `await refresh()` re-fetched stale `unbound`, and the
`verified as @octocat` assertion never appeared.

**Fix applied (per instructions — no optimistic write in production code):** made
that one stub stateful — a `bound` flag flips to `true` inside the
`/api/bind/complete` handler, and `/api/bind/status` reads it. `PublishToExplore.tsx`
uses plain `useGitHubBind(apiBase)` (no `onBound`), so `useIdentity`'s `refresh()` is
the sole source of truth — the Task-4 clobbering bug (optimistic `setStatus` racing
`refresh()` and dropping `avatarUrl`/`sessionActive`) is not reintroduced.

Re-ran:

```
$ pnpm -C packages/console exec vitest run src/panels/Curate/PublishToExplore.test.tsx

 RUN  v3.2.6 .../packages/console
 ✓ src/panels/Curate/PublishToExplore.test.tsx (6 tests) 115ms
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

## Added test: scope-prefill guard

The brief called out that the `cur || …` guard needed dedicated coverage. Added:

> "prefills scope from a verified login, but never clobbers a scope the user already
> typed"

— delays `/api/bind/status` behind a controlled promise, types `@mine` into the scope
field *before* the identity resolves (the realistic race), resolves it, waits for
"Verified as @octocat", and asserts the scope field still reads `@mine`.

**Verified the new test actually catches the regression it targets:** temporarily
changed `setScope((cur) => cur || …)` to `setScope(…)` (unconditional overwrite) and
re-ran just that test:

```
$ pnpm -C packages/console exec vitest run src/panels/Curate/PublishToExplore.test.tsx -t "clobbers"

 × PublishToExplore > prefills scope from a verified login, but never clobbers a scope the user already typed
   AssertionError: expected '@octocat' to be '@mine'
 Test Files  1 failed (1)
      Tests  1 failed | 6 skipped (7)
```

Restored the guard; full file green again (7 tests, see below).

## Full test file, final run

```
$ pnpm -C packages/console exec vitest run src/panels/Curate/PublishToExplore.test.tsx

 RUN  v3.2.6 .../packages/console
 ✓ src/panels/Curate/PublishToExplore.test.tsx (7 tests) 118ms
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

## Collateral: Curate.test.tsx

Running the broader suite surfaced 3 failures in `Curate.test.tsx` (the parent panel
that mounts `PublishToExplore`) — confirmed via `git stash` that these 17 tests were
all green *before* this change, so this was a real regression introduced by the
migration, not pre-existing:

```
$ pnpm -C packages/console exec vitest run src/panels/Curate/Curate.test.tsx
 × Curate > playbook hand-off with lessons pre-selects instruction keys so buildSelection includes them
 × Curate > a ready contribution (Share my setup) pre-selects its keys and opens the Publish form
 × Curate > root-only playbook hand-off distills in Curate, then opens the prefilled Publish form
 Test Files  1 failed (1)
      Tests  3 failed | 14 passed (17)

Error: useIdentity must be used inside <IdentityProvider>
  ❯ useIdentity src/identity/IdentityProvider.tsx:27:19
  ❯ PublishToExplore src/panels/Curate/PublishToExplore.tsx:29:34
```

`Curate.tsx` renders `PublishToExplore` whenever `showPublish` is true (3 of the 17
tests reach that state); `IdentityProvider` isn't mounted at `Shell.tsx` yet — that's
Task 8's job, out of scope here — so the previously-inert `useIdentity()` call now
throws in isolation. `panels/Curate/` is in this task's edit scope (not excluded), so
I fixed it the same way as `PublishToExplore.test.tsx`: added a `renderCurate()`
helper wrapping `<IdentityProvider apiBase="">`, mechanically replaced all 17
`render(<Curate apiBase="" />)` calls (identical props on every call site), touched no
`expect(...)`. Re-ran:

```
$ pnpm -C packages/console exec vitest run src/panels/Curate/Curate.test.tsx

 RUN  v3.2.6 .../packages/console
 ✓ src/panels/Curate/Curate.test.tsx (17 tests) 238ms
 Test Files  1 passed (1)
      Tests  17 passed (17)
```

## Full console suite

```
$ pnpm -C packages/console exec vitest run
...
 Test Files  2 failed | 94 passed (96)
      Tests  541 passed (541)
```

The 2 failing suites are `src/pages.test.ts` and
`src/panels/Observe/Observe.test.tsx`, both failing at the Vite transform stage on
`Cannot find module '@agentgem/insight/observeAggregate'` — pre-existing, documented
in `.superpowers/sdd/progress.md` under Task 1 ("pre-existing full-suite failures
(Observe, pages.test.ts) from unbuilt @agentgem/insight + @agentgem/play workspace
pkgs. Build them before Task 10."). Unrelated to `panels/Curate/`. All 541 individual
tests that did run passed, zero regressions elsewhere.

## Typecheck

```
$ pnpm -C packages/console exec tsc --noEmit
src/panels/Observe/index.tsx(6,34): error TS2307: Cannot find module '@agentgem/insight/observeAggregate' or its corresponding type declarations.
src/panels/Observe/useObserveData.ts(3,34): error TS2307: Cannot find module '@agentgem/insight/observeAggregate' or its corresponding type declarations.
src/panels/Play/mcpHostTools.ts(6,32): error TS2307: Cannot find module '@agentgem/play' or its corresponding type declarations.
src/panels/Sessions/index.tsx(4,34): error TS2307: Cannot find module '@agentgem/insight/observeAggregate' or its corresponding type declarations.
```

Same 4 pre-existing errors as Task 4's report, none under `panels/Curate/`. Zero new
errors.

## Diff of PublishToExplore.test.tsx — proof no `expect(...)` changed

```diff
@@ -1,6 +1,10 @@
 import { describe, it, expect, vi, afterEach } from "vitest";
 import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
-import { PublishToExplore } from "./PublishToExplore.js";
+import { PublishToExplore, type PublishToExploreProps } from "./PublishToExplore.js";
+import { IdentityProvider } from "../../identity/IdentityProvider.js";
+
+const renderPublish = (props: PublishToExploreProps) =>
+  render(<IdentityProvider apiBase=""><PublishToExplore {...props} /></IdentityProvider>);
 
 afterEach(() => { cleanup(); vi.restoreAllMocks(); });
@@ -9,14 +13,12 @@ const res = (body: unknown) =>
 
 describe("PublishToExplore", () => {
   it("renders the form with scope, name, version inputs and auto-provenance", () => {
-    render(
-      <PublishToExplore
-        apiBase=""
-        selected={new Set(["skills::ship-loop"])}
-        skillCount={2}
-        lessonCount={1}
-      />
-    );
+    renderPublish({
+      apiBase: "",
+      selected: new Set(["skills::ship-loop"]),
+      skillCount: 2,
+      lessonCount: 1,
+    });
     expect(screen.getByLabelText("scope")).toBeTruthy();
     expect(screen.getByLabelText("name")).toBeTruthy();
     expect(screen.getByLabelText("version")).toBeTruthy();
@@ -39,14 +41,12 @@ describe("PublishToExplore", () => {
       throw new Error(`unexpected: ${u}`);
     }));
 
-    render(
-      <PublishToExplore
-        apiBase=""
-        selected={new Set(["skills::ship-loop"])}
-        skillCount={1}
-        lessonCount={0}
-      />
-    );
+    renderPublish({
+      apiBase: "",
+      selected: new Set(["skills::ship-loop"]),
+      skillCount: 1,
+      lessonCount: 0,
+    });
     fireEvent.change(screen.getByLabelText("scope"), { target: { value: "@me" } });
     fireEvent.change(screen.getByLabelText("name"), { target: { value: "my-playbook" } });
     const btn = await screen.findByRole("button", { name: /^publish$/i });
@@ -67,14 +67,12 @@ describe("PublishToExplore", () => {
       }
       throw new Error(`unexpected: ${u}`);
     }));
-    render(
-      <PublishToExplore
-        apiBase=""
-        selected={new Set(["skills::x"])}
-        skillCount={1}
-        lessonCount={0}
-      />
-    );
+    renderPublish({
+      apiBase: "",
+      selected: new Set(["skills::x"]),
+      skillCount: 1,
+      lessonCount: 0,
+    });
     fireEvent.change(screen.getByLabelText("scope"), { target: { value: "@me" } });
     fireEvent.change(screen.getByLabelText("name"), { target: { value: "p" } });
     const btn = await screen.findByRole("button", { name: /^publish$/i });
@@ -85,17 +83,21 @@ describe("PublishToExplore", () => {
 
   it("device flow: Connect shows the code first; copy-&-open then opens the browser and verifies", async () => {
     const seen: string[] = [];
+    // Stateful: once /api/bind/complete reports bound, the NEXT /api/bind/status call
+    // (the hook's post-success refresh()) must reflect it — otherwise this stub can't
+    // tell a correct refresh()-driven update from a stale/clobbered one.
+    let bound = false;
     vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
       const u = String(url);
-      if (u.includes("/api/bind/status")) return res({ bound: false });
+      if (u.includes("/api/bind/status")) return res(bound ? { bound: true, login: "octocat" } : { bound: false });
       if (u.includes("/api/bind/start")) { seen.push("start"); return res({ configured: true, userCode: "6DD8-7DC5", verificationUri: "https://github.com/login/device", deviceCode: "dc", interval: 5 }); }
-      if (u.includes("/api/bind/complete")) { seen.push("complete"); return res({ bound: true, login: "octocat" }); }
+      if (u.includes("/api/bind/complete")) { seen.push("complete"); bound = true; return res({ bound: true, login: "octocat" }); }
       throw new Error(`unexpected: ${u}`);
     }));
     const openSpy = vi.fn();
     vi.stubGlobal("open", openSpy);
 
-    render(<PublishToExplore apiBase="" selected={new Set(["skills::x"])} skillCount={1} lessonCount={0} />);
+    renderPublish({ apiBase: "", selected: new Set(["skills::x"]), skillCount: 1, lessonCount: 0 });
     fireEvent.click(await screen.findByRole("button", { name: /connect github/i }));
 
     // Code is shown, and the poll has NOT started yet (no /complete call, browser not opened).
@@ -120,9 +122,7 @@ describe("PublishToExplore", () => {
       }
       throw new Error(`unexpected: ${u}`);
     }));
-    render(
-      <PublishToExplore apiBase="" selected={new Set(["skills::x"])} skillCount={1} lessonCount={0} />
-    );
+    renderPublish({ apiBase: "", selected: new Set(["skills::x"]), skillCount: 1, lessonCount: 0 });
     // Connect GitHub is offered but optional — sharing is not gated on it.
     expect(await screen.findByRole("button", { name: /connect github/i })).toBeTruthy();
     fireEvent.change(screen.getByLabelText("scope"), { target: { value: "@me" } });
@@ -134,7 +134,26 @@ describe("PublishToExplore", () => {
   });
 
   it("prefills the name field from defaultName", () => {
-    render(<PublishToExplore apiBase="" selected={new Set()} skillCount={3} lessonCount={0} defaultName="my-setup" />);
+    renderPublish({ apiBase: "", selected: new Set(), skillCount: 3, lessonCount: 0, defaultName: "my-setup" });
     expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("my-setup");
   });
+
+  it("prefills scope from a verified login, but never clobbers a scope the user already typed", async () => {
+    // The identity status resolves AFTER the user has typed a scope — the classic
+    // race between the async bind-status fetch and user input. The `cur || …` guard
+    // must keep the typed value.
+    let resolveStatus!: (v: unknown) => void;
+    const statusPending = new Promise<unknown>((resolve) => { resolveStatus = resolve; });
+    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
+      const u = String(url);
+      if (u.includes("/api/bind/status")) return statusPending.then(() => res({ bound: true, login: "octocat" }));
+      throw new Error(`unexpected: ${u}`);
+    }));
+    renderPublish({ apiBase: "", selected: new Set(["skills::x"]), skillCount: 1, lessonCount: 0 });
+
+    fireEvent.change(screen.getByLabelText("scope"), { target: { value: "@mine" } });
+    resolveStatus(undefined);
+    await waitFor(() => expect(screen.getByText(/verified as @octocat/i)).toBeTruthy());
+    expect((screen.getByLabelText("scope") as HTMLInputElement).value).toBe("@mine");
+  });
 });
```

Grep-verified: `git diff … | grep -E "^[+-].*expect\("` on both `PublishToExplore.test.tsx`
and `Curate.test.tsx` returns **only additions** (the one new test's two `expect(...)`
lines) — zero pre-existing `expect(...)` lines were removed or modified.

## Self-review

- Deleted exactly the state/effect/handlers the brief named; nothing else in
  `PublishToExplore.tsx` was touched (submit handler, result view, copy-URL, form
  fields all byte-identical).
- `ConnectGitHub` renders with `bind={bind}` (plain `useGitHubBind(apiBase)`, no
  `onBound`) — did **not** repeat the Task-4 optimistic-write bug. Confirmed by
  reading `useGitHubBind.ts`: it calls `refresh()` then would call `onBound` only if
  passed; since we don't pass it, `useIdentity`'s own state is the only writer.
  `bindStatus` in `PublishToExplore` comes straight from `useIdentity()`, never
  locally shadowed.
- The `verificationUri`-vs-`verificationUriComplete` behavior change is real and
  intentional (shared hook uses `??`); did not touch the assertion that depends on it
  (line ~108, unchanged).
- The `Curate.test.tsx` fix is a mechanical, scope-limited wrapper addition — verified
  with `git stash` that those 3 tests were failing only because of this change, not
  pre-existing, and confirmed the fix doesn't touch any assertion.
- Ran the full console suite and typecheck; the only failures/errors present were
  already documented as pre-existing in `progress.md` and unrelated to `panels/Curate/`.
- Did not touch `src/identity/`, `src/`, `Shell.tsx`, `panels/Settings/`,
  `panels/Setup/`, or `panels/Play/`.

## Concerns for final review
- `Curate.test.tsx` wrapping is outside the brief's explicit file list. I judged it
  in-scope because (a) `panels/Curate/` isn't in the excluded-paths list, (b) leaving
  it broken means the migration shipped a regression the plan's own "run full suite"
  step would have caught anyway, and (c) the fix is mechanical and touches zero
  assertions. Flagging in case the plan intended Task 8 (Shell mount) to be the one
  that resolves this instead — if so, this fix is redundant but harmless (once
  `IdentityProvider` wraps `Shell`, `Curate.test.tsx`'s own wrapper still works
  identically, just nested one level deeper than necessary).
