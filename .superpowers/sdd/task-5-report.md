# Task 5 Report — Curate Review + Publish to Explore

## STEP 0 Findings

`inventoryRoute` → `introspectAll` → `introspectConfig` in `packages/capture/src/introspect.ts` did not read from `~/.agentgem/distilled/`. Option (a) was applied: added distilled-draft reading directly inside `introspectConfig`, after existing skill/instruction population but before the return statement.

## introspect.ts Change

**File:** `packages/capture/src/introspect.ts`

Two additions:
1. Added `dirname` to the `node:path` import; added `agentgemHome` to the `@agentgem/model` import.
2. Inserted a block at the end of `introspectConfig` (just before `return`):
   - `distilledBase`: if `opts.claudeDir` was supplied, derive via `dirname(opts.claudeDir)` (same pattern as the existing `claudeDir`-relative dirs); otherwise call `agentgemHome()`.
   - `distilledRoot = join(distilledBase, ".agentgem", "distilled")`.
   - Calls `readSkillsDir(distilledRoot, "distilled-draft")` — reuses the existing helper; each `<distilledRoot>/<name>/SKILL.md` becomes a `SkillArtifact` with `source: "distilled-draft"`.
   - Reads `<distilledRoot>/lessons/<name>.md` files as `InstructionsArtifact` entries.
   - Both are appended *after* all other sources, so `dedupByName` (first-wins) keeps an installed standalone skill and only adds the draft if no name collision exists.

## PublishToExplore Component

**File:** `packages/console/src/panels/Curate/PublishToExplore.tsx`

Props: `apiBase`, `selected` (Set<string>), `skillCount`, `lessonCount`.

Form flow:
1. User fills scope (e.g. `@me`), name, version (defaults `1.0.0`).
2. Auto-computed provenance string: `"distilled from N skill(s) and M lesson(s)"`.
3. On submit: `createWorkspaceRoute.call(client, { body: { name, selection } })` — saves the selection.
4. Then: `playbookPublishRoute.call(client, { body: { workspace, scope, name, version, provenance } })` — publishes to registry and mints share card.
5. On success: shows `exploreRef` and clickable `shareUrl` with copy button.
6. On error: `ClientError.body` (raw response body string) is preferred over the generic status-line message, since it's more specific (e.g. "registry down").

## Curate index.tsx Wiring

**File:** `packages/console/src/panels/Curate/index.tsx`

- Added `consumePendingPlaybook` to the `pendingAnalyze` import.
- Added `PublishToExplore` import.
- Added `showPublish` / `publishCounts` state.
- Extended the existing `useEffect` to also consume `consumePendingPlaybook()`: if a pending playbook is present, pre-populates the selection with the draft skill keys, switches to the compose tab, and sets `showPublish = true`.
- Added `<PublishToExplore ... />` in the compose tab JSX, rendered between the `<Checks />` block and the item list, conditional on `showPublish`.

## TDD Steps

**RED:** `pnpm exec vitest run src/panels/Curate/PublishToExplore.test.tsx`
→ FAIL — `PublishToExplore.js` not found (module not found at import).

**GREEN:** After creating `PublishToExplore.tsx`:
```
✓ src/panels/Curate/PublishToExplore.test.tsx (3 tests) 53ms
```

One test required a fix: the error test expected `/registry down|error/i`. The `ClientError` thrown on non-2xx throws a message `POST /api/playbook/publish failed with 500` (no "error", no "registry down"). Fixed by preferring `err.body` (the raw response body string, `"registry down"`) over the generic message.

## Backend Regression Test Summary

`pnpm exec tsc -b` — clean (no errors).

`pnpm exec vitest run` — **163 test files passed, 3 skipped** (Linux boundary + NATS integration, expected). 1066 tests passed, 5 skipped. Zero failures.

## Fix: include lessons

### Instructions-inclusion mechanism

`buildSelection(keys: Set<string>): GemSelection` in `packages/console/src/panels/Curate/selection.ts` iterates over all selected keys (formatted as `groupKey::name`). If any key has the `instructions` group prefix, it sets `includeInstructions: true` on the returned `GemSelection` object. The flag is all-or-nothing on the server side — there is no per-instruction filtering.

The playbook consume block in `index.tsx` called `setKeys` with only `selKey("skills", k)` entries for each skill. Because no `instructions::*` key was ever added to the selection, `buildSelection` never set `includeInstructions: true`, so lessons were omitted from every workspace save and Explore publish.

### Change made

**File:** `packages/console/src/panels/Curate/index.tsx`

In the mount `useEffect` block that calls `consumePendingPlaybook()`, the `setKeys` call was updated to spread both skill keys and lesson keys:

```tsx
// Before:
setKeys(new Set(playbook.skills.map(k => selKey("skills", k))));

// After:
setKeys(new Set([
  ...playbook.skills.map(k => selKey("skills", k)),
  ...playbook.lessons.map(k => selKey("instructions", k)),
]));
```

This uses the exact same `selKey("instructions", k)` pattern already used everywhere else in Curate, so `buildSelection` immediately picks up `includeInstructions: true` for any non-empty `lessons` array.

**File:** `packages/console/src/panels/Curate/Curate.test.tsx`

Added a new test `"playbook hand-off with lessons pre-selects instruction keys so buildSelection includes them"` that:
1. Calls `setPendingPlaybook({ root: "/proj", skills: ["ship-loop"], lessons: ["lesson-one"] })` before render.
2. Renders `<Curate>` with a mock inventory that includes the lesson as an `instructions` artifact.
3. Asserts `"2 selected"` (1 skill + 1 instruction) — would have been `"1 selected"` without the fix.
4. Saves the workspace and asserts the request body: `{ selection: { skills: ["ship-loop"], includeInstructions: true } }` — without the fix `includeInstructions` would be absent.

### RED → GREEN test evidence

**Command:** `cd /Users/rfeng/Projects/ninemind/agentgem-playbook/packages/console && pnpm exec vitest run`

**Before fix (RED):** The new test would fail — `"1 selected"` assertion mismatch and no `includeInstructions` in the workspace body.

**After fix (GREEN):**
```
✓ src/panels/Curate/Curate.test.tsx (13 tests) 407ms
Test Files  44 passed (44)
Tests  238 passed (238)
```

Typecheck: `pnpm run typecheck` — clean, no errors.

Commit: `d382dfc fix(console): include distilled lessons in the playbook review + published gem`

## Self-Review / Concerns

1. **Scope is caller-supplied**: the publish form accepts a free-text scope — no account-binding yet. The component renders a note ("Scope is caller-supplied — account-binding coming."). This is intentional per the spec.
2. **showPublish is one-way**: once shown, `showPublish` is not reset. This is fine for the hand-off pattern (navigate to Curate → publish → done); revisit if users need a dismiss button.
3. **distilled-draft last, dedup first-wins**: draft skills won't shadow installed ones. This is intentional (the standalone installation takes precedence) but means a user can't "preview" a draft that conflicts with an existing skill. Acceptable for now.
4. **Error body preference**: using `err.body` over `err.message` gives a better UX (shows "registry down" rather than "POST ... failed with 500") but could expose raw server error details. Since this is a local console, acceptable.
