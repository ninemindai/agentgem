# Task 4 Report: `mergeGems` (fetch, verify, fold)

## What Was Implemented

Appended to `src/gem/registry.ts`:
- `interface RegistrySource` — in-memory or network source adapter
- `interface Provenance` — tracks which items were merged and which artifacts were overridden
- `mergeGems(graph, source)` — async function that:
  1. Iterates `graph` in topological order (deps before dependents, guaranteed by `resolveGraph`)
  2. Fetches each node's archive via `source.fetchItem(node.path)`
  3. Runs `verifyLock` (lock file consistency) — throws on mismatch
  4. Recomputes `computeLock(files).gemDigest` and compares to `node.gemDigest` — throws `/digest/i` on disagreement
  5. Calls `readGemArchive` to get the `Gem`
  6. Folds artifacts by name with three rules:
     - Identical content (same `JSON.stringify`) → silent dedup
     - Dependent's artifact collides with an ancestor's → dependent overrides, recorded in `provenance.overrides`
     - Same-name/different-content between unrelated nodes → throws `/collision/i`
  7. Unions `requiredSecrets` by `${name}:${location}` key (dedup by name+location)
  8. Dedup `checks` by name (last wins, though order is topological)
  9. Builds a merged `Gem` and returns it with `provenance`

New test file: `src/gem/__tests__/registryMerge.test.ts`

## Dead-Line Cleanup Performed

The brief's first test case carried two dead placeholder lines:
```ts
const digest = (p: string) => JSON.parse((source as any), p); // placeholder, replaced below
```
and a stray `const digest = ...` reference. These were **omitted entirely** from the written test. Every `ResolvedNode` literal gets its `gemDigest` from `await digestOf(source, <path>)`, which is the helper at the bottom of the test file.

Additionally, the brief's implementation had a truncated line:
```ts
for (const s of gem.requiredSecrets) secrets.set(`${s.name}
```
This was completed as `secrets.set(\`${s.name}:${s.location}\`, s)` — matching the brief's description "union requiredSecrets (by name+location)".

## TDD Evidence

### RED (tsc compile error — expected)

```
$ pnpm test
src/gem/__tests__/registryMerge.test.ts(3,10): error TS2305: Module '"../registry.js"' has no exported member 'mergeGems'.
src/gem/__tests__/registryMerge.test.ts(4,29): error TS2305: Module '"../registry.js"' has no exported member 'RegistrySource'.
...
ELIFECYCLE  Test failed.
```

### GREEN (all tests pass)

```
$ pnpm test
 ✓ dist/gem/__tests__/registryMerge.test.js (4 tests) 4ms
 ...
 Test Files  26 passed (26)
      Tests  190 passed (190)
   Duration  1.02s
```

## Files Changed

- `src/gem/registry.ts` — appended ~65 lines (imports, interfaces, `mergeGems`)
- `src/gem/__tests__/registryMerge.test.ts` — new file (81 lines, 4 test cases)

## Self-Review Findings

1. **Ancestry computation correct** — `ancestorsOf` does a full transitive closure via the `directDeps` map (which uses `n.deps` from the `graph` input). Since `resolveGraph` guarantees deps appear before dependents, all ancestor sets are fully populated when each node is processed.

2. **Integrity checks both present** — `verifyLock` covers per-file hash consistency; `computeLock(files).gemDigest !== node.gemDigest` covers the registry index agreement check. Both must pass.

3. **Collision/override/dedup rules correct** — identical `JSON.stringify` → dedup; ancestor-in-path → override + record; unrelated → throw collision.

4. **Error messages match regexes** — `/digest/i` matched by "digest disagrees"; `/collision/i` matched by "artifact name collision".

5. **YAGNI** — no network code, no install/publish logic. Only what the spec requires.

6. **No modification to Tasks 1/3 code** — appended only.

7. **NodeNext ESM** — all relative imports end in `.js`.

## Concerns

None. The implementation is clean and all 190 tests pass.

## Fix wave 1

### Fix 1 — import placement (registry.ts)

Moved the three `import` lines that were appended after the `resolveGraph` function (previously lines 103–105) to the top of `src/gem/registry.ts` (now lines 1–3), ahead of all exported declarations. Change is placement-only — identical bytes, no logic altered, fully ESM-compliant (JS hoists imports regardless of position; this is a style/lint fix).

### Fix 2 — same-content dedup test (registryMerge.test.ts)

Added one test inside the `mergeGems` describe block in `src/gem/__tests__/registryMerge.test.ts`:

```ts
it("silently dedups same-name/same-content artifacts from unrelated siblings", async () => {
  const sharedContent = "# shared skill";
  const lGem: Gem = { name: "l", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "shared", source: "standalone", content: sharedContent }] };
  const rGem: Gem = { name: "r", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "shared", source: "standalone", content: sharedContent }] };
  const { source } = fakeSource({ "p/l": { gem: lGem, version: "1.0.0" }, "p/r": { gem: rGem, version: "1.0.0" } });
  const nodes: ResolvedNode[] = [
    { key: "@a/l", version: "1.0.0", path: "p/l", gemDigest: await digestOf(source, "p/l"), deps: [] },
    { key: "@a/r", version: "1.0.0", path: "p/r", gemDigest: await digestOf(source, "p/r"), deps: [] },
  ];
  const { gem, provenance } = await mergeGems(nodes, source);
  expect(gem.artifacts.filter((a) => a.name === "shared")).toHaveLength(1);
  expect(provenance.overrides).toEqual([]);
});
```

Two unrelated siblings (both `deps: []`) with the same artifact name and identical content. Asserts: no throw, exactly one artifact named `shared`, `provenance.overrides` is empty.

### Test evidence

Command: `pnpm test` (tsc -b && vitest run)

```
 ✓ dist/gem/__tests__/registryMerge.test.js (5 tests) 5ms
 ...
 Test Files  26 passed (26)
      Tests  191 passed (191)
   Start at  16:54:26
   Duration  949ms
```
