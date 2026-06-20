# Task 3 Report: Version selection + `resolveGraph`

## What was implemented

### New exports added to `src/gem/registry.ts`

1. **`selectVersion(item, range): string`** — picks the highest-sorting semver that satisfies `range`. Supports exact (`1.2.3`) and caret (`^1.2.3`) ranges only; throws `/no version/i` when no version matches.

2. **`interface ResolvedNode`** — `{ key, version, path, gemDigest, deps }` where `deps` are resolved `@scope/name` keys of direct dependencies.

3. **`resolveGraph(rootRefs, index): ResolvedNode[]`** — performs a DFS with:
   - **topological ordering**: deps before dependents
   - **diamond dedup**: `state` map marks nodes "done"; revisits are skipped
   - **cycle detection**: `state = "visiting"` while DFS is in progress; re-entering throws `/cycle/i`
   - **unknown item detection**: throws `/unknown item/i` if a ref's key isn't in the index
   - **version conflict detection**: `chosen` map records the first resolved version per key; a second resolution to a different version throws `/conflict/i`

4. **Internal helpers** (unexported): `parseSemver`, `cmpSemver`, `satisfies` — no external dependency.

### New test file: `src/gem/__tests__/registryResolve.test.ts`

6 test scenarios (8 assertions total), transcribed verbatim from the brief.

---

## TDD Evidence

### RED Phase

**Command:**
```
pnpm test
```

**Output (relevant lines):**
```
src/gem/__tests__/registryResolve.test.ts(3,10): error TS2305: Module '"../registry.js"' has no exported member 'resolveGraph'.
src/gem/__tests__/registryResolve.test.ts(3,24): error TS2305: Module '"../registry.js"' has no exported member 'selectVersion'.
src/gem/__tests__/registryResolve.test.ts(32,19): error TS7006: Parameter 'n' implicitly has an 'any' type.
...
ELIFECYCLE  Test failed.
```

**Why expected:** The test imports `resolveGraph` and `selectVersion` which did not yet exist in `registry.ts`. The `implicit any` errors on callbacks are a downstream effect of the missing type exports (TypeScript can't infer the callback parameter types). All errors resolve after implementation.

### GREEN Phase

**Command:**
```
pnpm test
```

**Output:**
```
✓ dist/gem/__tests__/registryResolve.test.js (8 tests) 3ms
...
Test Files  25 passed (25)
     Tests  185 passed (185)
  Duration  989ms
```

All 25 test files passed; no regressions.

---

## Files Changed

- `src/gem/registry.ts` — appended ~70 lines (semver helpers + `selectVersion` + `ResolvedNode` + `resolveGraph`); Task 1 code untouched
- `src/gem/__tests__/registryResolve.test.ts` — new file, 83 lines, verbatim from brief

---

## Self-Review

| Criterion | Status |
|---|---|
| All 6 test scenarios covered | ✓ |
| Caret semantics correct (`^1.x` = major lock, `^0.x` = minor lock, `^0.0.x` = exact) | ✓ |
| Cycle message matches `/cycle/i` | ✓ |
| Conflict message matches `/conflict/i` | ✓ |
| Unknown item message matches `/unknown item/i` | ✓ |
| No-version message matches `/no version/i` | ✓ |
| YAGNI: no merge/publish/network/install code added | ✓ |
| Task 1 code unmodified | ✓ |
| No external semver dependency added | ✓ |
| NodeNext ESM imports end in `.js` | ✓ |

## Concerns

None. The implementation faithfully transcribes the brief. The conflict detection is range-based (it compares resolved versions, not ranges), which means two different ranges that happen to resolve to the same version will not conflict — consistent with the brief's test where `@a/dep@1.0.0` vs `@a/dep@1.2.0` conflict precisely because they resolve to different versions.

---

## Fix wave 1

### What was changed

**`src/gem/registry.ts`**

1. **Fix 1a — `selectVersion` (line 48–53):** In the `range === "latest"` branch, added a guard that throws a descriptive error if `item.versions[item.latest]` is undefined:
   ```ts
   if (item.versions[item.latest] === undefined)
     throw new Error(`latest version '${item.latest}' is not present in the item's versions`);
   ```

2. **Fix 1b — `resolveGraph` › `visit` (line ~82):** After `const v = index.items[key].versions[version];`, added:
   ```ts
   if (v === undefined) throw new Error(`resolved version ${key}@${version} not found in the index`);
   ```
   This fires for any caller path (e.g. exact-range resolution) where the resolved version is absent from the index, surfacing a clear message instead of an opaque `TypeError`.

3. **Fix 2 — `satisfies` (line 36):** Removed the dead `if (range === "latest") return true;` line. `selectVersion` short-circuits `range === "latest"` before ever calling `satisfies`, making this branch unreachable.

**`src/gem/__tests__/registryResolve.test.ts`**

Added one test to the `resolveGraph` describe block:

```ts
it("throws when latest points to a version absent from versions", () => {
  const malformed: RegistryIndex = { formatVersion: 1, items: {
    "@a/x": { latest: "2.0.0", versions: { "1.0.0": { path: "p/x", gemDigest: "sha256:x", dependencies: [] } } },
  } };
  expect(() => resolveGraph(["@a/x"], malformed)).toThrow(/version/i);
});
```

### `pnpm test` command + passing output

```
pnpm test
```

```
> agentgem@0.1.0 test /Users/rfeng/Projects/ninemind/agentgem/.claude/worktrees/gem-registry
> tsc -b && vitest run

 RUN  v3.2.6 /Users/rfeng/Projects/ninemind/agentgem/.claude/worktrees/gem-registry

 ✓ dist/gem/__tests__/registryResolve.test.js (9 tests) 3ms
 ✓ dist/gem/__tests__/archiveFs.test.js (3 tests) 5ms
 ✓ dist/gem/__tests__/archive.test.js (12 tests) 5ms
 ✓ dist/gem/__tests__/introspectProject.test.js (2 tests) 8ms
 ✓ dist/gem/__tests__/introspect.redact.test.js (2 tests) 11ms
 ✓ dist/gem/__tests__/targets.test.js (29 tests) 7ms
 ✓ dist/gem/__tests__/run.test.js (8 tests) 22ms
 ✓ dist/gem/__tests__/testbed.test.js (10 tests) 30ms
 ✓ dist/gem/__tests__/workspaces.test.js (6 tests) 28ms
 ✓ dist/gem/__tests__/agentcoreRun.test.js (6 tests) 11ms
 ✓ dist/gem/__tests__/introspect.test.js (6 tests) 55ms
 ✓ dist/gem/__tests__/buildGem.test.js (11 tests) 4ms
 ✓ dist/gem/__tests__/archiveMeta.test.js (2 tests) 2ms
 ✓ dist/gem/__tests__/publish.test.js (6 tests) 2ms
 ✓ dist/gem/__tests__/checks.test.js (2 tests) 2ms
 ✓ dist/gem/__tests__/redact.test.js (7 tests) 2ms
 ✓ dist/gem/__tests__/archiveTar.test.js (3 tests) 4ms
 ✓ dist/gem/__tests__/registryRef.test.js (5 tests) 2ms
 ✓ dist/gem/__tests__/toml.test.js (3 tests) 2ms
 ✓ dist/__tests__/publish.network.test.js (5 tests) 3ms
 ✓ dist/gem/__tests__/deploy.test.js (4 tests) 3ms
 ✓ dist/__tests__/pickFolder.test.js (4 tests) 24ms
 ✓ dist/__tests__/schemas.test.js (16 tests) 36ms
 ✓ dist/gem/__tests__/mcpProxy.test.js (3 tests) 1ms
 ✓ dist/__tests__/gem.controller.test.js (22 tests) 169ms

 Test Files  25 passed (25)
      Tests  186 passed (186)
   Start at  16:46:41
   Duration  962ms (transform 368ms, setup 0ms, collect 1.85s, tests 440ms, environment 2ms, prepare 1.48s)
```
