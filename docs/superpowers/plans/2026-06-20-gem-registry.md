# Gem Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distribute composable Gems through a single GitHub-backed registry repo — publish a Gem as a versioned item, resolve `registryDependencies` client-side, merge into one Gem, and install it by materializing into a harness or landing it in the workspace.

**Architecture:** Approach A — "a capability is just a small Gem." Reuse the existing content-addressed archive (`writeGemArchive`/`readGemArchive`/`verifyLock`) as the registry item, and `materialize()` for placement. New code is a thin distribution layer: a pure module (`src/gem/registry.ts`) for refs / resolution / merge / publish-install orchestration, an isolated GitHub network client (`src/gem/registryGithub.ts`), plus REST + MCP surface. Pure logic is injected with a `RegistrySource`/`RegistryPublisher` so all of it tests against in-memory FileTree maps — the same split as `deploy.ts` ↔ `../publish.js`.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), vitest, zod, `@agentback/openapi` (REST) + `@agentback/mcp` (tools). No new runtime dependencies — semver matching is a small internal helper (caret + exact only).

## Global Constraints

- **Module system:** NodeNext ESM. Every relative import ends in `.js` (e.g. `import { x } from "./registry.js"`).
- **Naming:** the distributed unit is a **Gem**. Archive files are `gem.json` / `gem.lock`; the digest is `gemDigest`. Never reintroduce "Pack".
- **Secrets:** never serialize or transmit secret values. `requiredSecrets` carries names + locations only; archives are already redacted at capture.
- **Integrity is mandatory:** every fetched archive runs `verifyLock`, and its recomputed `gemDigest` must equal the index's `gemDigest`, before its artifacts are used.
- **Determinism:** preserve `writeGemArchive`'s stable ordering; do not introduce nondeterministic ordering anywhere a digest is computed.
- **Ref grammar:** `@scope/name` or `@scope/name@<range>`; `<range>` is exact semver or caret (`^x.y.z`); bare ref ⇒ `latest`. `scope`/`name` match `^[a-z0-9-]+$`.
- **Env config:** `AGENTGEM_REGISTRY_REPO` (`owner/repo`), `AGENTGEM_REGISTRY_REF` (default `main`), `GITHUB_TOKEN` (required only for private repos / publishing).
- **Network isolation:** all HTTP lives in `registryGithub.ts` behind an injected `fetch`-like function. No other module performs network I/O.

---

### Task 1: Ref parsing + registry types

**Files:**
- Create: `src/gem/registry.ts`
- Test: `src/gem/__tests__/registryRef.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseRef(input: string): ParsedRef` where `ParsedRef = { key: string; scope: string; name: string; range: string }` (`key` is `"@scope/name"`; `range` is `"latest"` or `"x.y.z"` or `"^x.y.z"`).
  - `interface RegistryItemVersion { path: string; gemDigest: string; dependencies: string[] }`
  - `interface RegistryItem { latest: string; versions: Record<string, RegistryItemVersion> }`
  - `interface RegistryIndex { formatVersion: number; items: Record<string, RegistryItem> }`
  - `const REGISTRY_FORMAT_VERSION = 1`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/registryRef.test.ts
import { describe, it, expect } from "vitest";
import { parseRef } from "../registry.js";

describe("parseRef", () => {
  it("parses a bare ref as latest", () => {
    expect(parseRef("@acme/github-search")).toEqual({
      key: "@acme/github-search", scope: "acme", name: "github-search", range: "latest",
    });
  });
  it("parses an exact version", () => {
    expect(parseRef("@acme/github-search@1.2.0").range).toBe("1.2.0");
  });
  it("parses a caret range", () => {
    expect(parseRef("@acme/http-base@^1.0.0").range).toBe("^1.0.0");
  });
  it("rejects a ref without a scope", () => {
    expect(() => parseRef("github-search")).toThrow(/scope/i);
  });
  it("rejects illegal characters", () => {
    expect(() => parseRef("@Acme/Foo")).toThrow(/invalid/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gem/__tests__/registryRef.test.ts`
Expected: FAIL — `parseRef` is not exported from `../registry.js` (module/function not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/gem/registry.ts
export const REGISTRY_FORMAT_VERSION = 1;

export interface RegistryItemVersion { path: string; gemDigest: string; dependencies: string[] }
export interface RegistryItem { latest: string; versions: Record<string, RegistryItemVersion> }
export interface RegistryIndex { formatVersion: number; items: Record<string, RegistryItem> }

export interface ParsedRef { key: string; scope: string; name: string; range: string }

const SEG = /^[a-z0-9-]+$/;

export function parseRef(input: string): ParsedRef {
  const at = input.indexOf("@", 1); // a version "@" can only appear after the leading "@scope/name"
  const body = at > 0 ? input.slice(0, at) : input;
  const range = at > 0 ? input.slice(at + 1) : "latest";
  if (!body.startsWith("@")) throw new Error(`invalid ref '${input}': must start with a scope, e.g. @scope/name`);
  const slash = body.indexOf("/");
  if (slash < 0) throw new Error(`invalid ref '${input}': missing scope separator '/'`);
  const scope = body.slice(1, slash);
  const name = body.slice(slash + 1);
  if (!SEG.test(scope) || !SEG.test(name)) throw new Error(`invalid ref '${input}': scope/name must match [a-z0-9-]`);
  if (range !== "latest" && !/^\^?\d+\.\d+\.\d+$/.test(range)) throw new Error(`invalid ref '${input}': bad version range '${range}'`);
  return { key: `@${scope}/${name}`, scope, name, range };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gem/__tests__/registryRef.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/registry.ts src/gem/__tests__/registryRef.test.ts
git commit -m "feat(registry): ref grammar + registry index types"
```

---

### Task 2: Manifest `dependencies` + `readGemMeta`

**Files:**
- Modify: `src/gem/archive.ts` (the `GemManifest` interface ~line 68, `writeGemArchive` opts ~line 80 and manifest construction ~line 129; add `readGemMeta` after `readGemArchive`)
- Test: `src/gem/__tests__/archiveMeta.test.ts`

**Interfaces:**
- Consumes: existing `writeGemArchive(gem, { version? })`, `FileTree`.
- Produces:
  - `writeGemArchive(gem, { version?, dependencies? })` — `dependencies?: string[]` now written into `gem.json`.
  - `readGemMeta(files: FileTree): { name: string; version: string; dependencies: string[]; gemDigest: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/archiveMeta.test.ts
import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemMeta } from "../archive.js";
import type { Gem } from "../types.js";

const gem: Gem = {
  name: "github-search", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search" }],
};

describe("archive dependencies + readGemMeta", () => {
  it("records dependencies in the manifest and reads them back", () => {
    const { files } = writeGemArchive(gem, { version: "1.2.0", dependencies: ["@acme/http-base@^1.0.0"] });
    const meta = readGemMeta(files);
    expect(meta).toEqual({
      name: "github-search",
      version: "1.2.0",
      dependencies: ["@acme/http-base@^1.0.0"],
      gemDigest: expect.stringMatching(/^sha256:[0-9a-f]+$/),
    });
  });
  it("defaults dependencies to [] when absent (backward-compatible)", () => {
    const { files } = writeGemArchive(gem, { version: "0.1.0" });
    expect(readGemMeta(files).dependencies).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gem/__tests__/archiveMeta.test.ts`
Expected: FAIL — `readGemMeta` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/gem/archive.ts`, add `dependencies?` to the manifest interface:

```ts
interface GemManifest {
  formatVersion: number;
  name: string;
  version: string;
  createdFrom: string;
  artifacts: ManifestArtifactEntry[];
  requiredSecrets: Gem["requiredSecrets"];
  checks: ManifestCheckEntry[];
  dependencies?: string[];
}
```

Change the `writeGemArchive` signature and manifest construction:

```ts
export function writeGemArchive(gem: Gem, opts: { version?: string; dependencies?: string[] } = {}): ArchiveResult {
```

```ts
  const manifest: GemManifest = {
    formatVersion: ARCHIVE_FORMAT_VERSION,
    name: gem.name,
    version: opts.version ?? "0.1.0",
    createdFrom: gem.createdFrom,
    artifacts,
    requiredSecrets: gem.requiredSecrets,
    checks,
    ...(opts.dependencies && opts.dependencies.length ? { dependencies: opts.dependencies } : {}),
  };
```

Add `readGemMeta` after `readGemArchive`:

```ts
export function readGemMeta(files: FileTree): { name: string; version: string; dependencies: string[]; gemDigest: string } {
  const manifestRaw = files["gem.json"];
  if (manifestRaw === undefined) throw new Error("archive missing gem.json");
  const lockRaw = files["gem.lock"];
  if (lockRaw === undefined) throw new Error("archive missing gem.lock");
  const manifest = JSON.parse(manifestRaw) as GemManifest;
  const lock = JSON.parse(lockRaw) as GemLock;
  return { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies ?? [], gemDigest: lock.gemDigest };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gem/__tests__/archiveMeta.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full archive suite to confirm no regression**

Run: `npx vitest run src/gem/__tests__/archive.test.ts`
Expected: PASS (existing tests unaffected — `dependencies` is additive).

- [ ] **Step 6: Commit**

```bash
git add src/gem/archive.ts src/gem/__tests__/archiveMeta.test.ts
git commit -m "feat(archive): optional manifest dependencies + readGemMeta"
```

---

### Task 3: Version selection + `resolveGraph`

**Files:**
- Modify: `src/gem/registry.ts`
- Test: `src/gem/__tests__/registryResolve.test.ts`

**Interfaces:**
- Consumes: `parseRef`, `RegistryIndex`, `RegistryItem` (Task 1).
- Produces:
  - `selectVersion(item: RegistryItem, range: string): string`
  - `interface ResolvedNode { key: string; version: string; path: string; gemDigest: string; deps: string[] }` (`deps` are resolved `"@scope/name"` keys)
  - `resolveGraph(rootRefs: string[], index: RegistryIndex): ResolvedNode[]` — topological order, dependencies before dependents.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/registryResolve.test.ts
import { describe, it, expect } from "vitest";
import { resolveGraph, selectVersion } from "../registry.js";
import type { RegistryIndex } from "../registry.js";

const idx: RegistryIndex = {
  formatVersion: 1,
  items: {
    "@a/root": { latest: "1.0.0", versions: { "1.0.0": { path: "items/a/root/1.0.0", gemDigest: "sha256:r", dependencies: ["@a/dep@^1.0.0"] } } },
    "@a/dep":  { latest: "1.2.0", versions: {
      "1.0.0": { path: "items/a/dep/1.0.0", gemDigest: "sha256:d0", dependencies: [] },
      "1.2.0": { path: "items/a/dep/1.2.0", gemDigest: "sha256:d2", dependencies: [] },
    } },
  },
};

describe("selectVersion", () => {
  it("picks the highest caret match", () => {
    expect(selectVersion(idx.items["@a/dep"], "^1.0.0")).toBe("1.2.0");
  });
  it("matches an exact version", () => {
    expect(selectVersion(idx.items["@a/dep"], "1.0.0")).toBe("1.0.0");
  });
  it("throws when nothing satisfies the range", () => {
    expect(() => selectVersion(idx.items["@a/dep"], "^2.0.0")).toThrow(/no version/i);
  });
});

describe("resolveGraph", () => {
  it("orders dependencies before dependents", () => {
    const g = resolveGraph(["@a/root"], idx);
    expect(g.map((n) => n.key)).toEqual(["@a/dep", "@a/root"]);
    expect(g.find((n) => n.key === "@a/dep")!.version).toBe("1.2.0");
  });
  it("dedupes a diamond into one node per key", () => {
    const diamond: RegistryIndex = { formatVersion: 1, items: {
      "@a/top": { latest: "1.0.0", versions: { "1.0.0": { path: "p/top", gemDigest: "sha256:t", dependencies: ["@a/l@^1.0.0", "@a/r@^1.0.0"] } } },
      "@a/l":   { latest: "1.0.0", versions: { "1.0.0": { path: "p/l", gemDigest: "sha256:l", dependencies: ["@a/base@^1.0.0"] } } },
      "@a/r":   { latest: "1.0.0", versions: { "1.0.0": { path: "p/r", gemDigest: "sha256:rr", dependencies: ["@a/base@^1.0.0"] } } },
      "@a/base":{ latest: "1.0.0", versions: { "1.0.0": { path: "p/base", gemDigest: "sha256:b", dependencies: [] } } },
    } };
    const keys = resolveGraph(["@a/top"], diamond).map((n) => n.key);
    expect(keys.filter((k) => k === "@a/base")).toHaveLength(1);
    expect(keys.indexOf("@a/base")).toBeLessThan(keys.indexOf("@a/top"));
  });
  it("throws on a dependency cycle", () => {
    const cyclic: RegistryIndex = { formatVersion: 1, items: {
      "@a/x": { latest: "1.0.0", versions: { "1.0.0": { path: "p/x", gemDigest: "sha256:x", dependencies: ["@a/y@^1.0.0"] } } },
      "@a/y": { latest: "1.0.0", versions: { "1.0.0": { path: "p/y", gemDigest: "sha256:y", dependencies: ["@a/x@^1.0.0"] } } },
    } };
    expect(() => resolveGraph(["@a/x"], cyclic)).toThrow(/cycle/i);
  });
  it("throws on an unknown item", () => {
    expect(() => resolveGraph(["@a/missing"], idx)).toThrow(/unknown item/i);
  });
  it("throws on incompatible ranges for the same item", () => {
    const conflict: RegistryIndex = { formatVersion: 1, items: {
      "@a/top": { latest: "1.0.0", versions: { "1.0.0": { path: "p/top", gemDigest: "sha256:t", dependencies: ["@a/dep@1.0.0", "@a/mid@^1.0.0"] } } },
      "@a/mid": { latest: "1.0.0", versions: { "1.0.0": { path: "p/mid", gemDigest: "sha256:m", dependencies: ["@a/dep@1.2.0"] } } },
      "@a/dep": { latest: "1.2.0", versions: {
        "1.0.0": { path: "p/dep0", gemDigest: "sha256:d0", dependencies: [] },
        "1.2.0": { path: "p/dep2", gemDigest: "sha256:d2", dependencies: [] },
      } },
    } };
    expect(() => resolveGraph(["@a/top"], conflict)).toThrow(/conflict/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gem/__tests__/registryResolve.test.ts`
Expected: FAIL — `selectVersion`/`resolveGraph` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/gem/registry.ts`:

```ts
// ── minimal semver (exact + caret only; no external dep) ──
function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`invalid semver '${v}'`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function cmpSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
function satisfies(version: string, range: string): boolean {
  if (range === "latest") return true;
  if (!range.startsWith("^")) return cmpSemver(version, range) === 0;
  const base = range.slice(1);
  const [bMaj, bMin] = parseSemver(base);
  const [vMaj, vMin] = parseSemver(version);
  if (cmpSemver(version, base) < 0) return false;       // must be >= base
  if (bMaj > 0) return vMaj === bMaj;                    // ^1.2.3 := >=1.2.3 <2.0.0
  if (bMin > 0) return vMaj === 0 && vMin === bMin;      // ^0.2.3 := >=0.2.3 <0.3.0
  return cmpSemver(version, base) === 0;                 // ^0.0.3 := exact
}

export function selectVersion(item: RegistryItem, range: string): string {
  if (range === "latest") return item.latest;
  const matches = Object.keys(item.versions).filter((v) => satisfies(v, range));
  if (matches.length === 0) throw new Error(`no version of item satisfies '${range}'`);
  return matches.sort(cmpSemver)[matches.length - 1];
}

export interface ResolvedNode { key: string; version: string; path: string; gemDigest: string; deps: string[] }

export function resolveGraph(rootRefs: string[], index: RegistryIndex): ResolvedNode[] {
  const chosen = new Map<string, { version: string; by: string }>(); // key -> selection

  const choose = (ref: string, requestedBy: string): { key: string; version: string } => {
    const { key, range } = parseRef(ref);
    const item = index.items[key];
    if (!item) throw new Error(`unknown item '${key}' (requested by ${requestedBy})`);
    const version = selectVersion(item, range);
    const prev = chosen.get(key);
    if (prev && prev.version !== version) {
      throw new Error(`version conflict for ${key}: ${prev.by} wants ${prev.version}, ${requestedBy} wants ${version}`);
    }
    if (!prev) chosen.set(key, { version, by: requestedBy });
    return { key, version };
  };

  const order: ResolvedNode[] = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (key: string, version: string, trail: string[]): void => {
    const s = state.get(key);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`dependency cycle: ${[...trail, key].join(" -> ")}`);
    state.set(key, "visiting");
    const v = index.items[key].versions[version];
    const depKeys: string[] = [];
    for (const depRef of v.dependencies) {
      const { key: dKey, version: dVer } = choose(depRef, `${key}@${version}`);
      depKeys.push(dKey);
      visit(dKey, dVer, [...trail, key]);
    }
    order.push({ key, version, path: v.path, gemDigest: v.gemDigest, deps: depKeys });
    state.set(key, "done");
  };

  for (const ref of rootRefs) {
    const { key, version } = choose(ref, "(root)");
    visit(key, version, []);
  }
  return order;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gem/__tests__/registryResolve.test.ts`
Expected: PASS (all cases — selection, ordering, diamond dedup, cycle, unknown, conflict).

- [ ] **Step 5: Commit**

```bash
git add src/gem/registry.ts src/gem/__tests__/registryResolve.test.ts
git commit -m "feat(registry): version selection + dependency graph resolution"
```

---

### Task 4: `mergeGems` (fetch, verify, fold)

**Files:**
- Modify: `src/gem/registry.ts`
- Test: `src/gem/__tests__/registryMerge.test.ts`

**Interfaces:**
- Consumes: `ResolvedNode` (Task 3); `readGemArchive`, `computeLock`, `verifyLock`, `FileTree` from `./archive.js`; `Gem`, `GemArtifact`, `SecretRequirement` from `./types.js`.
- Produces:
  - `interface RegistrySource { id: string; label: string; ready(): boolean; getIndex(): Promise<RegistryIndex>; fetchItem(path: string): Promise<FileTree> }`
  - `interface Provenance { items: { key: string; version: string }[]; overrides: { artifact: string; winner: string; loser: string }[] }`
  - `mergeGems(graph: ResolvedNode[], source: RegistrySource): Promise<{ gem: Gem; provenance: Provenance }>`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/registryMerge.test.ts
import { describe, it, expect } from "vitest";
import { mergeGems } from "../registry.js";
import type { ResolvedNode, RegistrySource } from "../registry.js";
import { writeGemArchive } from "../archive.js";
import type { Gem } from "../types.js";
import type { FileTree } from "../targets.js";

// Build an in-memory source: item path -> archive FileTree, prefixed under the item path.
function fakeSource(items: Record<string, { gem: Gem; version: string }>): { source: RegistrySource; nodes: ResolvedNode[] } {
  const store: Record<string, FileTree> = {};
  const digest: Record<string, string> = {};
  for (const [path, { gem, version }] of Object.entries(items)) {
    const { files } = writeGemArchive(gem, { version });
    store[path] = files;
    digest[path] = JSON.parse(files["gem.lock"]).gemDigest;
  }
  const source: RegistrySource = {
    id: "fake", label: "fake", ready: () => true,
    async getIndex() { return { formatVersion: 1, items: {} }; },
    async fetchItem(path) { return store[path]; },
  };
  return { source, nodes: [], digest } as any;
}

const dep: Gem = { name: "http-base", createdFrom: "/d", checks: [], requiredSecrets: [{ name: "TOKEN", artifact: "http", location: "headers.authorization" }],
  artifacts: [{ type: "skill", name: "http", source: "standalone", content: "# HTTP base" }] };
const root: Gem = { name: "github-search", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search" }] };

describe("mergeGems", () => {
  it("merges dependency + dependent artifacts and unions requiredSecrets", async () => {
    const { source } = fakeSource({ "p/dep": { gem: dep, version: "1.0.0" }, "p/root": { gem: root, version: "1.0.0" } });
    const digest = (p: string) => JSON.parse((source as any), p); // placeholder, replaced below
    const nodes: ResolvedNode[] = [
      { key: "@a/http-base", version: "1.0.0", path: "p/dep", gemDigest: await digestOf(source, "p/dep"), deps: [] },
      { key: "@a/github-search", version: "1.0.0", path: "p/root", gemDigest: await digestOf(source, "p/root"), deps: ["@a/http-base"] },
    ];
    const { gem, provenance } = await mergeGems(nodes, source);
    expect(gem.artifacts.map((a) => a.name).sort()).toEqual(["http", "search"]);
    expect(gem.requiredSecrets).toEqual([{ name: "TOKEN", artifact: "http", location: "headers.authorization" }]);
    expect(provenance.items.map((i) => i.key)).toEqual(["@a/http-base", "@a/github-search"]);
  });

  it("lets a dependent override an ancestor's same-named artifact", async () => {
    const baseGem: Gem = { name: "b", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "review", source: "standalone", content: "# base review" }] };
    const overrideGem: Gem = { name: "o", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "review", source: "standalone", content: "# local review" }] };
    const { source } = fakeSource({ "p/base": { gem: baseGem, version: "1.0.0" }, "p/over": { gem: overrideGem, version: "1.0.0" } });
    const nodes: ResolvedNode[] = [
      { key: "@a/base", version: "1.0.0", path: "p/base", gemDigest: await digestOf(source, "p/base"), deps: [] },
      { key: "@a/over", version: "1.0.0", path: "p/over", gemDigest: await digestOf(source, "p/over"), deps: ["@a/base"] },
    ];
    const { gem, provenance } = await mergeGems(nodes, source);
    const review = gem.artifacts.find((a) => a.name === "review")!;
    expect((review as any).content).toContain("local review");
    expect(provenance.overrides).toEqual([{ artifact: "review", winner: "@a/over", loser: "@a/base" }]);
  });

  it("errors on a same-name/different-content collision between unrelated siblings", async () => {
    const lGem: Gem = { name: "l", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "dup", source: "standalone", content: "# left" }] };
    const rGem: Gem = { name: "r", createdFrom: "/d", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "dup", source: "standalone", content: "# right" }] };
    const { source } = fakeSource({ "p/l": { gem: lGem, version: "1.0.0" }, "p/r": { gem: rGem, version: "1.0.0" } });
    const nodes: ResolvedNode[] = [
      { key: "@a/l", version: "1.0.0", path: "p/l", gemDigest: await digestOf(source, "p/l"), deps: [] },
      { key: "@a/r", version: "1.0.0", path: "p/r", gemDigest: await digestOf(source, "p/r"), deps: [] },
    ];
    await expect(mergeGems(nodes, source)).rejects.toThrow(/collision/i);
  });

  it("rejects an archive whose digest disagrees with the resolved node", async () => {
    const { source } = fakeSource({ "p/root": { gem: root, version: "1.0.0" } });
    const nodes: ResolvedNode[] = [{ key: "@a/github-search", version: "1.0.0", path: "p/root", gemDigest: "sha256:WRONG", deps: [] }];
    await expect(mergeGems(nodes, source)).rejects.toThrow(/digest/i);
  });
});

async function digestOf(source: RegistrySource, path: string): Promise<string> {
  const files = await source.fetchItem(path);
  return JSON.parse(files["gem.lock"]).gemDigest;
}
```

> Note: delete the two dead placeholder lines (`const digest = ...` / `const digest = (p) =>`) the test's first case carried over from scaffolding — the real helper is `digestOf` at the bottom. Keep only `digestOf`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gem/__tests__/registryMerge.test.ts`
Expected: FAIL — `mergeGems` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/gem/registry.ts`:

```ts
import type { Gem, GemArtifact, SecretRequirement, GemCheck } from "./types.js";
import { readGemArchive, computeLock, verifyLock } from "./archive.js";
import type { FileTree } from "./targets.js";

export interface RegistrySource {
  id: string; label: string;
  ready(): boolean;
  getIndex(): Promise<RegistryIndex>;
  fetchItem(path: string): Promise<FileTree>;
}
export interface Provenance {
  items: { key: string; version: string }[];
  overrides: { artifact: string; winner: string; loser: string }[];
}

const artifactContentKey = (a: GemArtifact): string => JSON.stringify(a);

export async function mergeGems(graph: ResolvedNode[], source: RegistrySource): Promise<{ gem: Gem; provenance: Provenance }> {
  // ancestor sets: which keys is `key` (transitively) built on? deps appear before dependents in `graph`.
  const directDeps = new Map(graph.map((n) => [n.key, n.deps]));
  const ancestorsOf = (key: string): Set<string> => {
    const out = new Set<string>(); const stack = [...(directDeps.get(key) ?? [])];
    while (stack.length) { const k = stack.pop()!; if (!out.has(k)) { out.add(k); stack.push(...(directDeps.get(k) ?? [])); } }
    return out;
  };

  const byName = new Map<string, { artifact: GemArtifact; owner: string; contentKey: string }>();
  const secrets = new Map<string, SecretRequirement>();
  const checks = new Map<string, GemCheck>();
  const provenance: Provenance = { items: [], overrides: [] };

  for (const node of graph) {
    const files = await source.fetchItem(node.path);
    const v = verifyLock(files, JSON.parse(files["gem.lock"]));
    if (!v.ok) throw new Error(`integrity failure for ${node.key}@${node.version}: lock mismatch [${v.mismatches.join(",")}]`);
    if (computeLock(files).gemDigest !== node.gemDigest) {
      throw new Error(`integrity failure for ${node.key}@${node.version}: digest disagrees with the registry index`);
    }
    const gem = readGemArchive(files);
    provenance.items.push({ key: node.key, version: node.version });

    for (const artifact of gem.artifacts) {
      const contentKey = artifactContentKey(artifact);
      const prev = byName.get(artifact.name);
      if (!prev) { byName.set(artifact.name, { artifact, owner: node.key, contentKey }); continue; }
      if (prev.contentKey === contentKey) continue;                       // identical via two paths → dedup
      if (ancestorsOf(node.key).has(prev.owner)) {                        // dependent overrides ancestor
        byName.set(artifact.name, { artifact, owner: node.key, contentKey });
        provenance.overrides.push({ artifact: artifact.name, winner: node.key, loser: prev.owner });
        continue;
      }
      throw new Error(`artifact name collision: '${artifact.name}' defined by unrelated items ${prev.owner} and ${node.key}`);
    }
    for (const s of gem.requiredSecrets) secrets.set(`${s.name} ${s.location}`, s);
    for (const c of gem.checks) checks.set(c.name, c);
  }

  const rootKey = graph.length ? graph[graph.length - 1].key : "(empty)";
  const rootVer = graph.length ? graph[graph.length - 1].version : "0.0.0";
  const merged: Gem = {
    name: rootKey.split("/").pop() ?? "gem",
    createdFrom: `registry:${rootKey}@${rootVer}`,
    artifacts: [...byName.values()].map((e) => e.artifact),
    checks: [...checks.values()],
    requiredSecrets: [...secrets.values()],
  };
  return { gem: merged, provenance };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gem/__tests__/registryMerge.test.ts`
Expected: PASS (merge, override, sibling collision, digest mismatch).

- [ ] **Step 5: Commit**

```bash
git add src/gem/registry.ts src/gem/__tests__/registryMerge.test.ts
git commit -m "feat(registry): integrity-checked merge with override + collision rules"
```

---

### Task 5: `updateIndex` + `publishGem`

**Files:**
- Modify: `src/gem/registry.ts`
- Test: `src/gem/__tests__/registryPublish.test.ts`

**Interfaces:**
- Consumes: `writeGemArchive`, `readGemMeta` (Task 2); `RegistryIndex` (Task 1); `Gem`.
- Produces:
  - `interface RegistryPublisher { putCommit(files: FileTree, message: string): Promise<{ commit: string }> }`
  - `updateIndex(index, e: { key: string; version: string; path: string; gemDigest: string; dependencies: string[] }): RegistryIndex`
  - `publishGem(args: { gem: Gem; scope: string; name?: string; version: string; dependencies?: string[]; index: RegistryIndex; publisher: RegistryPublisher }): Promise<{ ref: string; version: string; gemDigest: string; commit: string; path: string }>`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/registryPublish.test.ts
import { describe, it, expect } from "vitest";
import { publishGem, updateIndex } from "../registry.js";
import type { RegistryIndex, RegistryPublisher } from "../registry.js";
import type { FileTree } from "../targets.js";
import type { Gem } from "../types.js";

const gem: Gem = { name: "github-search", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search" }] };

function capturingPublisher(): { publisher: RegistryPublisher; commits: { files: FileTree; message: string }[] } {
  const commits: { files: FileTree; message: string }[] = [];
  return { commits, publisher: { async putCommit(files, message) { commits.push({ files, message }); return { commit: "abc123" }; } } };
}

const empty: RegistryIndex = { formatVersion: 1, items: {} };

describe("publishGem", () => {
  it("writes the item archive + an updated index in one commit", async () => {
    const { publisher, commits } = capturingPublisher();
    const r = await publishGem({ gem, scope: "acme", version: "1.0.0", index: empty, publisher });
    expect(r.ref).toBe("@acme/github-search");
    expect(r.path).toBe("items/acme/github-search/1.0.0");
    expect(commits).toHaveLength(1);
    expect(commits[0].files["items/acme/github-search/1.0.0/gem.json"]).toBeDefined();
    const idx = JSON.parse(commits[0].files["registry.json"]) as RegistryIndex;
    expect(idx.items["@acme/github-search"].latest).toBe("1.0.0");
    expect(idx.items["@acme/github-search"].versions["1.0.0"].gemDigest).toBe(r.gemDigest);
  });

  it("is idempotent when re-publishing identical content at the same version", async () => {
    const { publisher } = capturingPublisher();
    const first = await publishGem({ gem, scope: "acme", version: "1.0.0", index: empty, publisher });
    const idx = updateIndex(empty, { key: "@acme/github-search", version: "1.0.0", path: first.path, gemDigest: first.gemDigest, dependencies: [] });
    await expect(publishGem({ gem, scope: "acme", version: "1.0.0", index: idx, publisher })).resolves.toMatchObject({ gemDigest: first.gemDigest });
  });

  it("refuses to overwrite an existing version with different content", async () => {
    const { publisher } = capturingPublisher();
    const idx = updateIndex(empty, { key: "@acme/github-search", version: "1.0.0", path: "items/acme/github-search/1.0.0", gemDigest: "sha256:OLD", dependencies: [] });
    await expect(publishGem({ gem, scope: "acme", version: "1.0.0", index: idx, publisher })).rejects.toThrow(/immutable|already published/i);
  });

  it("bumps latest only when the new version is higher", () => {
    let idx = updateIndex(empty, { key: "@a/x", version: "1.0.0", path: "p", gemDigest: "sha256:a", dependencies: [] });
    idx = updateIndex(idx, { key: "@a/x", version: "1.2.0", path: "p", gemDigest: "sha256:b", dependencies: [] });
    expect(idx.items["@a/x"].latest).toBe("1.2.0");
    idx = updateIndex(idx, { key: "@a/x", version: "1.1.0", path: "p", gemDigest: "sha256:c", dependencies: [] });
    expect(idx.items["@a/x"].latest).toBe("1.2.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gem/__tests__/registryPublish.test.ts`
Expected: FAIL — `publishGem`/`updateIndex` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/gem/registry.ts` (add `writeGemArchive, readGemMeta` to the existing `./archive.js` import):

```ts
import { writeGemArchive, readGemMeta } from "./archive.js";

export interface RegistryPublisher {
  putCommit(files: FileTree, message: string): Promise<{ commit: string }>;
}

export function updateIndex(
  index: RegistryIndex,
  e: { key: string; version: string; path: string; gemDigest: string; dependencies: string[] },
): RegistryIndex {
  const items = { ...index.items };
  const existing = items[e.key];
  const versions = { ...(existing?.versions ?? {}) };
  versions[e.version] = { path: e.path, gemDigest: e.gemDigest, dependencies: e.dependencies };
  const latest = existing && cmpSemver(existing.latest, e.version) >= 0 ? existing.latest : e.version;
  items[e.key] = { latest, versions };
  return { formatVersion: REGISTRY_FORMAT_VERSION, items };
}

export async function publishGem(args: {
  gem: Gem; scope: string; name?: string; version: string; dependencies?: string[];
  index: RegistryIndex; publisher: RegistryPublisher;
}): Promise<{ ref: string; version: string; gemDigest: string; commit: string; path: string }> {
  const name = args.name ?? args.gem.name;
  if (!SEG.test(args.scope) || !SEG.test(name)) throw new Error(`invalid scope/name '@${args.scope}/${name}': must match [a-z0-9-]`);
  parseSemver(args.version); // validate
  const key = `@${args.scope}/${name}`;
  const path = `items/${args.scope}/${name}/${args.version}`;

  const { files } = writeGemArchive(args.gem, { version: args.version, dependencies: args.dependencies });
  const { gemDigest, dependencies } = readGemMeta(files);

  const prior = args.index.items[key]?.versions[args.version];
  if (prior && prior.gemDigest !== gemDigest) {
    throw new Error(`${key}@${args.version} is already published and immutable (digest ${prior.gemDigest})`);
  }

  const nextIndex = updateIndex(args.index, { key, version: args.version, path, gemDigest, dependencies });
  const commitFiles: FileTree = { "registry.json": JSON.stringify(nextIndex, null, 2) };
  for (const [rel, content] of Object.entries(files)) commitFiles[`${path}/${rel}`] = content;

  const { commit } = await args.publisher.putCommit(commitFiles, `publish ${key}@${args.version}`);
  return { ref: key, version: args.version, gemDigest, commit, path };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gem/__tests__/registryPublish.test.ts`
Expected: PASS (commit shape, idempotent re-publish, immutability, latest bump).

- [ ] **Step 5: Commit**

```bash
git add src/gem/registry.ts src/gem/__tests__/registryPublish.test.ts
git commit -m "feat(registry): publishGem with immutable versions + index update"
```

---

### Task 6: `resolveInstall` (plan + merged gem + materialize preview)

**Files:**
- Modify: `src/gem/registry.ts`
- Test: `src/gem/__tests__/registryInstall.test.ts`

**Interfaces:**
- Consumes: `resolveGraph`, `mergeGems`, `RegistrySource` (Tasks 3–4); `materialize`, `TargetId` from `./targets.js`; `SecretRequirement`.
- Produces:
  - `interface InstallPlan { items: { key: string; version: string }[]; totalArtifacts: number; requiredSecrets: SecretRequirement[]; overrides: Provenance["overrides"]; materialize?: { files: FileTree; skipped: { artifact: string; type: string; reason: string }[] } }`
  - `resolveInstall(args: { refs: string[]; mode: "materialize" | "workspace"; target?: TargetId; source: RegistrySource }): Promise<{ plan: InstallPlan; gem: Gem }>`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/registryInstall.test.ts
import { describe, it, expect } from "vitest";
import { resolveInstall } from "../registry.js";
import type { RegistrySource, RegistryIndex } from "../registry.js";
import { writeGemArchive } from "../archive.js";
import type { Gem } from "../types.js";
import type { FileTree } from "../targets.js";

const root: Gem = { name: "github-search", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search" }] };

function sourceFor(gem: Gem, version: string): RegistrySource {
  const { files } = writeGemArchive(gem, { version });
  const gemDigest = JSON.parse(files["gem.lock"]).gemDigest;
  const index: RegistryIndex = { formatVersion: 1, items: {
    "@acme/github-search": { latest: version, versions: { [version]: { path: "p/root", gemDigest, dependencies: [] } } },
  } };
  const store: Record<string, FileTree> = { "p/root": files };
  return { id: "fake", label: "fake", ready: () => true, async getIndex() { return index; }, async fetchItem(p) { return store[p]; } };
}

describe("resolveInstall", () => {
  it("returns a plan with a materialize preview for the chosen harness", async () => {
    const source = sourceFor(root, "1.0.0");
    const { plan, gem } = await resolveInstall({ refs: ["@acme/github-search"], mode: "materialize", target: "claude", source });
    expect(plan.items).toEqual([{ key: "@acme/github-search", version: "1.0.0" }]);
    expect(plan.totalArtifacts).toBe(1);
    expect(plan.materialize!.files["skills/search/SKILL.md"]).toContain("# Search");
    expect(gem.artifacts).toHaveLength(1);
  });

  it("omits the materialize preview in workspace mode", async () => {
    const source = sourceFor(root, "1.0.0");
    const { plan } = await resolveInstall({ refs: ["@acme/github-search"], mode: "workspace", source });
    expect(plan.materialize).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gem/__tests__/registryInstall.test.ts`
Expected: FAIL — `resolveInstall` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/gem/registry.ts` (add `materialize` + `TargetId` to the existing `./targets.js` import, which currently only brings in `FileTree`):

```ts
import { materialize } from "./targets.js";
import type { TargetId } from "./targets.js";

export interface InstallPlan {
  items: { key: string; version: string }[];
  totalArtifacts: number;
  requiredSecrets: SecretRequirement[];
  overrides: Provenance["overrides"];
  materialize?: { files: FileTree; skipped: { artifact: string; type: string; reason: string }[] };
}

export async function resolveInstall(args: {
  refs: string[]; mode: "materialize" | "workspace"; target?: TargetId; source: RegistrySource;
}): Promise<{ plan: InstallPlan; gem: Gem }> {
  const index = await args.source.getIndex();
  const graph = resolveGraph(args.refs, index);
  const { gem, provenance } = await mergeGems(graph, args.source);

  const plan: InstallPlan = {
    items: provenance.items,
    totalArtifacts: gem.artifacts.length,
    requiredSecrets: gem.requiredSecrets,
    overrides: provenance.overrides,
  };
  if (args.mode === "materialize") {
    if (!args.target) throw new Error("materialize mode requires a target harness id");
    plan.materialize = materialize(gem, args.target);
  }
  return { plan, gem };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gem/__tests__/registryInstall.test.ts`
Expected: PASS (materialize preview present for `claude`; absent for workspace mode).

- [ ] **Step 5: Commit**

```bash
git add src/gem/registry.ts src/gem/__tests__/registryInstall.test.ts
git commit -m "feat(registry): resolveInstall — plan + merged gem + materialize preview"
```

---

### Task 7: GitHub network client + source/publisher factories

**Files:**
- Create: `src/gem/registryGithub.ts`
- Test: `src/gem/__tests__/registryGithub.test.ts`

**Interfaces:**
- Consumes: `RegistryIndex`, `RegistrySource`, `RegistryPublisher` from `./registry.js`; `FileTree` from `./targets.js`.
- Produces:
  - `type Http = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text: () => Promise<string> }>`
  - `githubRegistrySource(cfg: GithubCfg, http?: Http): RegistrySource`
  - `githubRegistryPublisher(cfg: GithubCfg, http?: Http): RegistryPublisher`
  - `registryConfigFromEnv(): GithubCfg | null` where `GithubCfg = { repo: string; ref: string; token?: string }`
  - `registryReady(): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/registryGithub.test.ts
import { describe, it, expect } from "vitest";
import { githubRegistrySource } from "../registryGithub.js";
import type { Http } from "../registryGithub.js";

// Minimal fake GitHub Contents API: directory listings return arrays; files return { content (base64) }.
function fakeHttp(tree: Record<string, string>): Http {
  return async (url) => {
    const m = /\/contents\/([^?]*)/.exec(url)!;
    const path = decodeURIComponent(m[1]);
    if (path === "registry.json" || tree[path] !== undefined) {
      return { status: 200, async text() { return JSON.stringify({ content: Buffer.from(tree[path]).toString("base64"), encoding: "base64" }); } };
    }
    // directory: return entries whose path is directly under `path`
    const entries = Object.keys(tree)
      .filter((p) => p.startsWith(path + "/"))
      .map((p) => ({ type: "file", path: p }));
    return { status: 200, async text() { return JSON.stringify(entries); } };
  };
}

describe("githubRegistrySource", () => {
  it("fetches and parses the index", async () => {
    const tree = { "registry.json": JSON.stringify({ formatVersion: 1, items: { "@a/x": { latest: "1.0.0", versions: {} } } }) };
    const src = githubRegistrySource({ repo: "o/r", ref: "main" }, fakeHttp(tree));
    const idx = await src.getIndex();
    expect(idx.items["@a/x"].latest).toBe("1.0.0");
  });

  it("fetches an item directory into a FileTree keyed by path relative to the item", async () => {
    const tree = {
      "items/a/x/1.0.0/gem.json": "{}",
      "items/a/x/1.0.0/skills/s/SKILL.md": "# S",
    };
    const src = githubRegistrySource({ repo: "o/r", ref: "main" }, fakeHttp(tree));
    const files = await src.fetchItem("items/a/x/1.0.0");
    expect(files["gem.json"]).toBe("{}");
    expect(files["skills/s/SKILL.md"]).toBe("# S");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/gem/__tests__/registryGithub.test.ts`
Expected: FAIL — module `../registryGithub.js` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/gem/registryGithub.ts
// Isolated GitHub network client. All HTTP goes through the injected `http` fn so logic stays testable.
// Fetch uses the Contents API (token-optional → public + private uniform). Publish builds one atomic
// commit via the Git Data API (blobs → tree → commit → update ref).
import type { RegistryIndex, RegistrySource, RegistryPublisher } from "./registry.js";
import type { FileTree } from "./targets.js";

export interface GithubCfg { repo: string; ref: string; token?: string }
export type Http = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text: () => Promise<string> }>;

const API = "https://api.github.com";
const defaultHttp: Http = async (url, init) => {
  const res = await fetch(url, init as RequestInit);
  return { status: res.status, text: () => res.text() };
};

function headers(cfg: GithubCfg): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "agentgem" };
  if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
  return h;
}
async function ghJson(http: Http, cfg: GithubCfg, path: string, init?: { method?: string; body?: string }): Promise<unknown> {
  const res = await http(`${API}/repos/${cfg.repo}/${path}`, { ...init, headers: headers(cfg) });
  const body = await res.text();
  if (res.status >= 300) throw new Error(`GitHub ${init?.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

export function githubRegistrySource(cfg: GithubCfg, http: Http = defaultHttp): RegistrySource {
  const contents = (p: string) => ghJson(http, cfg, `contents/${encodeURIComponent(p).replace(/%2F/g, "/")}?ref=${encodeURIComponent(cfg.ref)}`);
  return {
    id: "github", label: `GitHub ${cfg.repo}`,
    ready: () => cfg.repo.length > 0,
    async getIndex(): Promise<RegistryIndex> {
      const node = (await contents("registry.json")) as { content: string; encoding: string };
      return JSON.parse(Buffer.from(node.content, "base64").toString("utf8")) as RegistryIndex;
    },
    async fetchItem(itemPath: string): Promise<FileTree> {
      const files: FileTree = {};
      const walk = async (p: string): Promise<void> => {
        const node = await contents(p);
        if (Array.isArray(node)) {
          for (const e of node as { type: string; path: string }[]) await walk(e.path);
        } else {
          const f = node as { content: string };
          files[p.slice(itemPath.length + 1)] = Buffer.from(f.content, "base64").toString("utf8");
        }
      };
      await walk(itemPath);
      return files;
    },
  };
}

export function githubRegistryPublisher(cfg: GithubCfg, http: Http = defaultHttp): RegistryPublisher {
  if (!cfg.token) throw new Error("publishing requires GITHUB_TOKEN");
  return {
    async putCommit(files: FileTree, message: string): Promise<{ commit: string }> {
      const ref = (await ghJson(http, cfg, `git/ref/heads/${cfg.ref}`)) as { object: { sha: string } };
      const base = ref.object.sha;
      const baseCommit = (await ghJson(http, cfg, `git/commits/${base}`)) as { tree: { sha: string } };
      const tree = await Promise.all(Object.entries(files).map(async ([path, content]) => {
        const blob = (await ghJson(http, cfg, "git/blobs", { method: "POST", body: JSON.stringify({ content, encoding: "utf-8" }) })) as { sha: string };
        return { path, mode: "100644", type: "blob", sha: blob.sha };
      }));
      const newTree = (await ghJson(http, cfg, "git/trees", { method: "POST", body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }) })) as { sha: string };
      const commit = (await ghJson(http, cfg, "git/commits", { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [base] }) })) as { sha: string };
      await ghJson(http, cfg, `git/refs/heads/${cfg.ref}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
      return { commit: commit.sha };
    },
  };
}

export function registryConfigFromEnv(): GithubCfg | null {
  const repo = process.env.AGENTGEM_REGISTRY_REPO;
  if (!repo) return null;
  return { repo, ref: process.env.AGENTGEM_REGISTRY_REF ?? "main", token: process.env.GITHUB_TOKEN };
}
export function registryReady(): boolean {
  return registryConfigFromEnv() !== null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/gem/__tests__/registryGithub.test.ts`
Expected: PASS (index parse; item directory walk into a relative FileTree).

- [ ] **Step 5: Commit**

```bash
git add src/gem/registryGithub.ts src/gem/__tests__/registryGithub.test.ts
git commit -m "feat(registry): GitHub Contents/Git-Data client + env config"
```

---

### Task 8: zod schemas for the registry endpoints

**Files:**
- Modify: `src/schemas.ts` (add registry schemas near the deploy/publish schemas)
- Test: `src/__tests__/schemas.test.ts` (add a registry describe block)

**Interfaces:**
- Consumes: `zod` (already imported in `schemas.ts`); the existing `GemSelectionSchema` (for publish-from-introspection inputs).
- Produces (all `z.ZodType` exports): `RegistryReadyResponseSchema`, `RegistryIndexResponseSchema`, `RegistryResolveRequestSchema`, `RegistryResolveResponseSchema`, `RegistryInstallRequestSchema`, `RegistryInstallResponseSchema`, `RegistryPublishRequestSchema`, `RegistryPublishResponseSchema`.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/__tests__/schemas.test.ts
import {
  RegistryResolveRequestSchema, RegistryInstallRequestSchema, RegistryPublishRequestSchema,
} from "../schemas.js";

describe("registry schemas", () => {
  it("accepts a resolve request with refs + target", () => {
    expect(RegistryResolveRequestSchema.parse({ refs: ["@acme/x"], mode: "materialize", target: "claude" }).refs).toEqual(["@acme/x"]);
  });
  it("rejects an install request with an empty refs array", () => {
    expect(() => RegistryInstallRequestSchema.parse({ refs: [], mode: "workspace" })).toThrow();
  });
  it("requires scope + version on a publish request", () => {
    expect(() => RegistryPublishRequestSchema.parse({ refs: [] })).toThrow();
    expect(RegistryPublishRequestSchema.parse({ workspace: "w", scope: "acme", version: "1.0.0" }).scope).toBe("acme");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/schemas.test.ts`
Expected: FAIL — the registry schemas are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/schemas.ts`:

```ts
export const RegistryReadyResponseSchema = z.object({ ready: z.boolean() });

const RegistryItemVersionSchema = z.object({ path: z.string(), gemDigest: z.string(), dependencies: z.array(z.string()) });
export const RegistryIndexResponseSchema = z.object({
  formatVersion: z.number(),
  items: z.record(z.object({ latest: z.string(), versions: z.record(RegistryItemVersionSchema) })),
});

const TargetIdSchema = z.enum(["claude", "codex", "agents", "hermes", "eve", "flue", "openai-sandbox", "agentcore"]);

export const RegistryResolveRequestSchema = z.object({
  refs: z.array(z.string()).min(1),
  mode: z.enum(["materialize", "workspace"]),
  target: TargetIdSchema.optional(),
});
const InstallPlanSchema = z.object({
  items: z.array(z.object({ key: z.string(), version: z.string() })),
  totalArtifacts: z.number(),
  requiredSecrets: z.array(z.object({ name: z.string(), artifact: z.string(), location: z.string() })),
  overrides: z.array(z.object({ artifact: z.string(), winner: z.string(), loser: z.string() })),
  materialize: z.object({
    files: z.record(z.string()),
    skipped: z.array(z.object({ artifact: z.string(), type: z.string(), reason: z.string() })),
  }).optional(),
});
export const RegistryResolveResponseSchema = z.object({ plan: InstallPlanSchema });

export const RegistryInstallRequestSchema = z.object({
  refs: z.array(z.string()).min(1),
  mode: z.enum(["materialize", "workspace"]),
  target: TargetIdSchema.optional(),
  dest: z.string().optional(),          // required when mode = "materialize"
  workspaceName: z.string().optional(), // optional override when mode = "workspace"
});
export const RegistryInstallResponseSchema = z.object({
  plan: InstallPlanSchema,
  applied: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("materialize"), dest: z.string(), written: z.array(z.string()) }),
    z.object({ mode: z.literal("workspace"), workspace: z.string() }),
  ]),
});

export const RegistryPublishRequestSchema = z.object({
  workspace: z.string(),       // publish a Gem that already lives in the workspace store
  scope: z.string(),
  name: z.string().optional(),
  version: z.string(),
  dependencies: z.array(z.string()).optional(),
});
export const RegistryPublishResponseSchema = z.object({
  ref: z.string(), version: z.string(), gemDigest: z.string(), commit: z.string(), path: z.string(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/schemas.test.ts`
Expected: PASS (resolve accepts; empty refs rejected; publish requires scope+version).

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/__tests__/schemas.test.ts
git commit -m "feat(schemas): registry resolve/install/publish request+response schemas"
```

---

### Task 9: REST endpoints (`/registry/*`)

**Files:**
- Modify: `src/gem.controller.ts` (imports at top; new endpoints before `pickFolder`)
- Test: `src/__tests__/gem.controller.test.ts` (add a registry block)

**Interfaces:**
- Consumes: everything from `./gem/registry.js` and `./gem/registryGithub.js`; `readWorkspace` from `./gem/workspaces.js`; `writeArchiveDir` from `./gem/archiveFs.js`.
- Produces: REST methods `registryReady`, `registryIndex`, `registryResolve`, `registryInstall`, `registryPublish`.

- [ ] **Step 1: Write the failing test**

```ts
// add to src/__tests__/gem.controller.test.ts
import { GemController } from "../gem.controller.js";

describe("registry endpoints", () => {
  it("reports not-ready when AGENTGEM_REGISTRY_REPO is unset", async () => {
    const prev = process.env.AGENTGEM_REGISTRY_REPO;
    delete process.env.AGENTGEM_REGISTRY_REPO;
    try {
      const res = await new GemController().registryReady({ query: {} });
      expect(res).toEqual({ ready: false });
    } finally {
      if (prev !== undefined) process.env.AGENTGEM_REGISTRY_REPO = prev;
    }
  });

  it("rejects install before the registry is configured", async () => {
    const prev = process.env.AGENTGEM_REGISTRY_REPO;
    delete process.env.AGENTGEM_REGISTRY_REPO;
    try {
      await expect(new GemController().registryInstall({ body: { refs: ["@a/x"], mode: "workspace" } }))
        .rejects.toThrow(/registry is not configured/i);
    } finally {
      if (prev !== undefined) process.env.AGENTGEM_REGISTRY_REPO = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/gem.controller.test.ts`
Expected: FAIL — `registryReady`/`registryInstall` methods don't exist.

- [ ] **Step 3: Write minimal implementation**

Add imports near the other `./gem/*` imports in `src/gem.controller.ts`:

```ts
import { resolveInstall, mergeGems, resolveGraph, publishGem } from "./gem/registry.js";
import { githubRegistrySource, githubRegistryPublisher, registryConfigFromEnv } from "./gem/registryGithub.js";
import {
  RegistryReadyResponseSchema, RegistryIndexResponseSchema,
  RegistryResolveRequestSchema, RegistryResolveResponseSchema,
  RegistryInstallRequestSchema, RegistryInstallResponseSchema,
  RegistryPublishRequestSchema, RegistryPublishResponseSchema,
} from "./schemas.js";
```

Add a private helper + the endpoints just before `pickFolder()`:

```ts
  // Resolve the configured registry source, or throw a clear error the UI can surface.
  private registrySource() {
    const cfg = registryConfigFromEnv();
    if (!cfg) throw new Error("the registry is not configured — set AGENTGEM_REGISTRY_REPO");
    return { cfg, source: githubRegistrySource(cfg) };
  }

  @get("/registry/ready", { query: PickQuerySchema, response: RegistryReadyResponseSchema })
  async registryReady(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof RegistryReadyResponseSchema>> {
    return { ready: registryConfigFromEnv() !== null };
  }

  @get("/registry/index", { query: PickQuerySchema, response: RegistryIndexResponseSchema })
  async registryIndex(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof RegistryIndexResponseSchema>> {
    return this.registrySource().source.getIndex();
  }

  @post("/registry/resolve", { body: RegistryResolveRequestSchema, response: RegistryResolveResponseSchema })
  async registryResolve(input: { body: z.infer<typeof RegistryResolveRequestSchema> }): Promise<z.infer<typeof RegistryResolveResponseSchema>> {
    const { source } = this.registrySource();
    const { plan } = await resolveInstall({ refs: input.body.refs, mode: input.body.mode, target: input.body.target as TargetId | undefined, source });
    return { plan };
  }

  // Apply: materialize into `dest`, or land the merged Gem in the workspace store.
  @post("/registry/install", { body: RegistryInstallRequestSchema, response: RegistryInstallResponseSchema })
  async registryInstall(input: { body: z.infer<typeof RegistryInstallRequestSchema> }): Promise<z.infer<typeof RegistryInstallResponseSchema>> {
    const { source } = this.registrySource();
    const { plan, gem } = await resolveInstall({ refs: input.body.refs, mode: input.body.mode, target: input.body.target as TargetId | undefined, source });
    if (input.body.mode === "materialize") {
      if (!input.body.dest) throw new Error("materialize mode requires `dest`");
      writeArchiveDir(input.body.dest, plan.materialize!.files);
      return { plan, applied: { mode: "materialize", dest: input.body.dest, written: Object.keys(plan.materialize!.files) } };
    }
    const name = input.body.workspaceName ?? gem.name;
    createWorkspace(name, gem);
    return { plan, applied: { mode: "workspace", workspace: name } };
  }

  // OUTWARD-FACING: gated network publish. Reads a Gem from the workspace, writes its archive +
  // updated index in one commit. Requires GITHUB_TOKEN (enforced by the publisher).
  @post("/registry/publish", { body: RegistryPublishRequestSchema, response: RegistryPublishResponseSchema })
  async registryPublish(input: { body: z.infer<typeof RegistryPublishRequestSchema> }): Promise<z.infer<typeof RegistryPublishResponseSchema>> {
    const { cfg, source } = this.registrySource();
    const gem = readGemArchive(readWorkspace(input.body.workspace).files); // WorkspaceDetail exposes .files, not .gem
    const index = await source.getIndex();
    return publishGem({
      gem, scope: input.body.scope, name: input.body.name, version: input.body.version,
      dependencies: input.body.dependencies, index, publisher: githubRegistryPublisher(cfg),
    });
  }
```

Update the `./gem/workspaces.js` import to include `readWorkspace` (it already imports `createWorkspace`; confirm `readWorkspace` is present — add it if not). Confirm `WorkspaceDetail.gem` exists; if the field is named differently, use that name.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gem.controller.test.ts`
Expected: PASS (ready=false when unset; install throws "registry is not configured").

- [ ] **Step 5: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: no errors (confirms imports/types line up across controller, registry, schemas).

- [ ] **Step 6: Commit**

```bash
git add src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(api): /registry ready·index·resolve·install·publish endpoints"
```

---

### Task 10: MCP tools

**Files:**
- Modify: `src/gem.tools.ts`
- Test: `src/__tests__/gemTools.registry.test.ts`

**Interfaces:**
- Consumes: `resolveInstall`, `publishGem` from `./gem/registry.js`; `githubRegistrySource`, `githubRegistryPublisher`, `registryConfigFromEnv` from `./gem/registryGithub.js`; `readWorkspace` from `./gem/workspaces.js`.
- Produces: MCP tools `registry_index`, `registry_resolve`, `registry_install`, `registry_publish` on `GemTools`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/gemTools.registry.test.ts
import { describe, it, expect } from "vitest";
import { GemTools } from "../gem.tools.js";

describe("registry MCP tools", () => {
  it("registry_resolve errors clearly when the registry is unconfigured", async () => {
    const prev = process.env.AGENTGEM_REGISTRY_REPO;
    delete process.env.AGENTGEM_REGISTRY_REPO;
    try {
      await expect(new GemTools().registryResolve({ refs: ["@a/x"], mode: "workspace" }))
        .rejects.toThrow(/registry is not configured/i);
    } finally {
      if (prev !== undefined) process.env.AGENTGEM_REGISTRY_REPO = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/gemTools.registry.test.ts`
Expected: FAIL — `registryResolve` tool method doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Add imports to `src/gem.tools.ts`:

```ts
import { resolveInstall, publishGem } from "./gem/registry.js";
import type { TargetId } from "./gem/targets.js";
import { githubRegistrySource, githubRegistryPublisher, registryConfigFromEnv } from "./gem/registryGithub.js";
import { readWorkspace } from "./gem/workspaces.js";
import { readGemArchive } from "./gem/archive.js";
```

Add the input schemas (near the other `z.object(...)` inputs at the top of the file):

```ts
const RegistryRefsInput = z.object({ refs: z.array(z.string()).min(1), mode: z.enum(["materialize", "workspace"]), target: z.string().optional() });
const RegistryPublishInput = z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), dependencies: z.array(z.string()).optional() });
```

Add a module-level helper + the tool methods inside the `GemTools` class:

```ts
function registrySourceOrThrow() {
  const cfg = registryConfigFromEnv();
  if (!cfg) throw new Error("the registry is not configured — set AGENTGEM_REGISTRY_REPO");
  return { cfg, source: githubRegistrySource(cfg) };
}
```

```ts
  @tool("registry_index", { description: "List the gems available in the configured registry (names, versions, dependencies).", input: z.object({}) })
  async registryIndex() {
    return registrySourceOrThrow().source.getIndex();
  }

  @tool("registry_resolve", { description: "Resolve registry refs into an install plan (items, artifacts, required secrets, and a materialize preview for a target). No writes.", input: RegistryRefsInput })
  async registryResolve(input: z.infer<typeof RegistryRefsInput>) {
    const { source } = registrySourceOrThrow();
    const { plan } = await resolveInstall({ refs: input.refs, mode: input.mode, target: input.target as TargetId | undefined, source });
    return plan;
  }

  @tool("registry_install", { description: "Resolve + merge registry refs, returning the merged Gem and install plan. (Disk/workspace placement is performed via the REST /registry/install endpoint.)", input: RegistryRefsInput })
  async registryInstall(input: z.infer<typeof RegistryRefsInput>) {
    const { source } = registrySourceOrThrow();
    const { plan, gem } = await resolveInstall({ refs: input.refs, mode: input.mode, target: input.target as TargetId | undefined, source });
    return { plan, gem };
  }

  @tool("registry_publish", { description: "Publish a workspace Gem to the registry as @scope/name@version (requires GITHUB_TOKEN).", input: RegistryPublishInput })
  async registryPublish(input: z.infer<typeof RegistryPublishInput>) {
    const { cfg, source } = registrySourceOrThrow();
    const gem = readGemArchive(readWorkspace(input.workspace).files); // WorkspaceDetail exposes .files, not .gem
    const index = await source.getIndex();
    return publishGem({ gem, scope: input.scope, name: input.name, version: input.version, dependencies: input.dependencies, index, publisher: githubRegistryPublisher(cfg) });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gemTools.registry.test.ts`
Expected: PASS (clear "registry is not configured" error).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/gem.tools.ts src/__tests__/gemTools.registry.test.ts
git commit -m "feat(mcp): registry index/resolve/install/publish tools"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task(s) |
| --- | --- |
| §1 refs & index format | 1 (refs, index types), 5 (index write), 8 (index schema) |
| §2 manifest `dependencies` + `readGemMeta` | 2 |
| §3 `RegistrySource`/`RegistryPublisher` + GitHub client | 4 (source iface), 5 (publisher iface), 7 (GitHub impl + env) |
| §4 `resolveGraph` + `mergeGems` (version select, cycle, dedup, override, sibling collision, secret/check union, integrity) | 3, 4 |
| §5 publish flow (immutability, latest bump, atomic commit) | 5, 7, 9 |
| §6 install flow + dry-run/diff trust surface | 6 (plan + materialize preview), 9 (apply: dest write / workspace) |
| §7 API + MCP surface (5 endpoints + tools) | 8, 9, 10 |
| §8 testing (pure + integrity + injected client) | every task is TDD; integrity in 4; injected client in 4–7 |

No gaps: every spec section maps to at least one task.

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Task 4's test carries one explicit cleanup note (two dead scaffolding lines to delete) called out inline rather than left ambiguous.

**Type consistency:** `ResolvedNode` uses `deps` (not `dependencies`) consistently in Tasks 3, 4, 6. `RegistrySource`/`RegistryPublisher` signatures match across Tasks 4, 5, 7, 9, 10. `InstallPlan` shape matches between Task 6 (TS) and Task 8 (`InstallPlanSchema`). The publish path (Tasks 9, 10) reconstructs the Gem with `readGemArchive(readWorkspace(name).files)` — verified against `workspaces.ts`, where `WorkspaceDetail` exposes `.files` (the archive FileTree) and `compatibility`, not a `.gem` field. `readWorkspace` and `readGemArchive` are both already imported in `gem.controller.ts`; Task 10 adds the `readGemArchive` import to `gem.tools.ts`.
