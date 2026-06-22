# Testbed On-Ramp Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agentgem` land the user in their current directory as a testbed in one click, replace the env-gated session-log scan with a persisted recents list, and delete the scan entirely.

**Architecture:** A read-only cwd probe (`suggestTestbed`) and a tiny JSON recents store (`~/.agentgem/recents.json`) feed a single front-door screen. Two new GET endpoints (`/testbed/suggestion`, `/testbed/recents`) replace the deleted `/testbed/projects` endpoint; the scaffold handler upserts a recents entry on every open. The UI's modal becomes a confirm-cwd-or-pick-recent screen with an inline flavor toggle, dropping both browser `prompt()` dialogs.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Zod schemas, `@agentback/rest` decorator controllers, vitest + supertest, vanilla JS in `src/public/index.html`.

## Global Constraints

- **ESM imports use `.js` specifiers** even for `.ts` sources (NodeNext). Copy this exactly.
- **Tests compile first:** `npm test` runs `tsc -b && vitest run` — vitest executes compiled tests from `dist/`. After deleting exports, if a stale-build error appears, run `rm -rf dist tsconfig.tsbuildinfo && npm test`.
- **`src/public/index.html` is not type-checked** by `tsc` and has no automated tests — verify it by running the server.
- **Flavor ids** are exactly `"claude" | "codex" | "hermes"` (`TestbedFlavorId`). Default flavor is `"claude"`.
- **Secrets:** unchanged — this plan does not touch import/MCP secret handling.
- **`resolveProject(p)`** canonicalizes a path to absolute; **`resolveDirs(dir?)`** resolves harness homes (keep — still used widely). New recents storage uses a separate `agentgemHome()` helper.

---

### Task 1: Recents store module + `agentgemHome()` helper

A pure JSON store for `~/.agentgem/recents.json`. No fs-existence checks here (the endpoint adds `exists`); functions take an explicit `home` dir so tests pass a temp dir with no env mutation.

**Files:**
- Modify: `src/resolveDir.ts` (add `agentgemHome`)
- Create: `src/gem/recents.ts`
- Test: `src/gem/__tests__/recents.test.ts`

**Interfaces:**
- Consumes: `TestbedFlavorId` from `./testbedFlavors.js`.
- Produces:
  - `agentgemHome(): string` — `process.env.AGENTGEM_HOME` if set/non-empty, else `os.homedir()`.
  - `interface RecentEntry { path: string; flavor: TestbedFlavorId; name: string; lastUsed: string }`
  - `readRecents(home: string): RecentEntry[]` — `[]` on missing/malformed.
  - `upsertRecent(home: string, e: { path: string; flavor: TestbedFlavorId; name: string }): RecentEntry[]` — stamps `lastUsed` with current ISO time, dedups by `path` (newest first), caps at 10, writes the file (best-effort; never throws), returns the new list.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/recents.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecents, upsertRecent } from "../recents.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agem-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("recents store", () => {
  it("returns [] when the file is missing", () => {
    expect(readRecents(home)).toEqual([]);
  });

  it("returns [] when the file is malformed", () => {
    mkdirSync(join(home, ".agentgem"), { recursive: true });
    writeFileSync(join(home, ".agentgem", "recents.json"), "not json{");
    expect(readRecents(home)).toEqual([]);
  });

  it("upsert writes an entry that read-back returns", () => {
    upsertRecent(home, { path: "/a", flavor: "claude", name: "a" });
    const got = readRecents(home);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ path: "/a", flavor: "claude", name: "a" });
    expect(typeof got[0].lastUsed).toBe("string");
  });

  it("dedups by path, keeping the latest at the front", () => {
    upsertRecent(home, { path: "/a", flavor: "claude", name: "a" });
    upsertRecent(home, { path: "/b", flavor: "codex", name: "b" });
    const list = upsertRecent(home, { path: "/a", flavor: "hermes", name: "a2" });
    expect(list.map((e) => e.path)).toEqual(["/a", "/b"]);
    expect(list[0]).toMatchObject({ flavor: "hermes", name: "a2" });
  });

  it("caps the list at 10 entries", () => {
    for (let i = 0; i < 12; i++) upsertRecent(home, { path: `/p${i}`, flavor: "claude", name: `p${i}` });
    const list = readRecents(home);
    expect(list).toHaveLength(10);
    expect(list[0].path).toBe("/p11"); // newest first
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- recents`
Expected: FAIL — `Cannot find module '../recents.js'`.

- [ ] **Step 3: Add `agentgemHome()` to `src/resolveDir.ts`**

Append after `resolveDirs`:

```typescript
// Base dir for agentgem's own state (recents, etc.): ~/.agentgem lives under this.
// AGENTGEM_HOME overrides the home root for tests / non-default setups.
export function agentgemHome(): string {
  const override = process.env.AGENTGEM_HOME;
  return override && override.length > 0 ? override : homedir();
}
```

(`homedir` is already imported at the top of the file.)

- [ ] **Step 4: Create `src/gem/recents.ts`**

```typescript
// src/gem/recents.ts
// Persisted "testbeds you've opened in agentgem" — a small JSON list under ~/.agentgem.
// Pure store: takes an explicit home dir, computes no fs-existence (the endpoint adds that).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestbedFlavorId } from "./testbedFlavors.js";

const CAP = 10;

export interface RecentEntry {
  path: string;
  flavor: TestbedFlavorId;
  name: string;
  lastUsed: string;
}

function recentsFile(home: string): string {
  return join(home, ".agentgem", "recents.json");
}

function isEntry(v: unknown): v is RecentEntry {
  const e = v as Record<string, unknown>;
  return !!e && typeof e.path === "string" && typeof e.flavor === "string"
    && typeof e.name === "string" && typeof e.lastUsed === "string";
}

export function readRecents(home: string): RecentEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(recentsFile(home), "utf8"));
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

// Move/insert `e` at the front (deduped by path), stamp lastUsed, cap, persist.
// Best-effort write: a non-writable ~/.agentgem must not break opening a testbed.
export function upsertRecent(home: string, e: { path: string; flavor: TestbedFlavorId; name: string }): RecentEntry[] {
  const entry: RecentEntry = { ...e, lastUsed: new Date().toISOString() };
  const rest = readRecents(home).filter((r) => r.path !== entry.path);
  const next = [entry, ...rest].slice(0, CAP);
  try {
    const abs = recentsFile(home);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch {
    console.warn(`agentgem: could not write recents to ${recentsFile(home)}`);
  }
  return next;
}

// existsSync is imported for callers that re-export; kept minimal here.
void existsSync;
```

Note: drop the `void existsSync;` line and the `existsSync` import if your linter flags the unused import — it is not used in this module. (Existence is computed in the controller.) Final import line should be: `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";`

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- recents`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/resolveDir.ts src/gem/recents.ts src/gem/__tests__/recents.test.ts
git commit -m "feat(testbed): persisted recents store + agentgemHome helper"
```

---

### Task 2: `suggestTestbed()` cwd probe

A read-only probe: does this folder look like a project, and which flavor?

**Files:**
- Modify: `src/gem/testbedFlavors.ts` (add `suggestTestbed` + `TestbedSuggestion` near `detectFlavor`, ~line 152)
- Test: `src/gem/__tests__/testbedFlavors.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `detectFlavor`, `flavorIds`, `TESTBED_FLAVORS` (all already in the file).
- Produces:
  - `interface TestbedSuggestion { looksLikeProject: boolean; flavor: TestbedFlavorId | null }`
  - `suggestTestbed(root: string): TestbedSuggestion` — `looksLikeProject` true if any flavor marker matches OR `.git/` exists; `flavor` is `detectFlavor(root)` (null when ambiguous/none, even if `looksLikeProject`).

- [ ] **Step 1: Write the failing test**

Add to `src/gem/__tests__/testbedFlavors.test.ts` (after the `detectFlavor` describe block, ~line 26). Also add `suggestTestbed` to the import on line 5:

```typescript
describe("suggestTestbed", () => {
  it("reports a claude project for a .claude marker", () => {
    mkdirSync(join(root, "p", ".claude"), { recursive: true });
    expect(suggestTestbed(join(root, "p"))).toEqual({ looksLikeProject: true, flavor: "claude" });
  });

  it("reports an adoptable project (flavor null) for a bare git repo", () => {
    mkdirSync(join(root, "g", ".git"), { recursive: true });
    expect(suggestTestbed(join(root, "g"))).toEqual({ looksLikeProject: true, flavor: null });
  });

  it("reports looksLikeProject with null flavor when markers are ambiguous", () => {
    mkdirSync(join(root, "amb", ".claude"), { recursive: true });
    mkdirSync(join(root, "amb", ".hermes"), { recursive: true });
    expect(suggestTestbed(join(root, "amb"))).toEqual({ looksLikeProject: true, flavor: null });
  });

  it("reports not-a-project for an empty folder", () => {
    mkdirSync(join(root, "empty"), { recursive: true });
    expect(suggestTestbed(join(root, "empty"))).toEqual({ looksLikeProject: false, flavor: null });
  });
});
```

Update line 5 import to include `suggestTestbed`:

```typescript
import { TESTBED_FLAVORS, detectFlavor, suggestTestbed, writeMcpCodexToml, discoverProjects } from "../testbedFlavors.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- testbedFlavors`
Expected: FAIL — `suggestTestbed is not a function` / not exported.

- [ ] **Step 3: Add `suggestTestbed` to `src/gem/testbedFlavors.ts`**

Insert immediately after `detectFlavor` (after line 152):

```typescript
// What the startup cwd probe needs: is this folder worth offering as a testbed,
// and (if unambiguous) which flavor. flavor stays null for ambiguous/marker-less
// git repos — the UI shows an inline flavor toggle in that case.
export interface TestbedSuggestion {
  looksLikeProject: boolean;
  flavor: TestbedFlavorId | null;
}

export function suggestTestbed(root: string): TestbedSuggestion {
  const anyMarker = flavorIds().some((id) => TESTBED_FLAVORS[id].detect(root));
  const looksLikeProject = anyMarker || existsSync(join(root, ".git"));
  return { looksLikeProject, flavor: detectFlavor(root) };
}
```

(`existsSync`, `join`, `flavorIds`, `TESTBED_FLAVORS`, `detectFlavor`, `TestbedFlavorId` are all already present in the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- testbedFlavors`
Expected: PASS (existing `detectFlavor` + `discoverProjects` blocks still pass; new `suggestTestbed` block passes).

- [ ] **Step 5: Commit**

```bash
git add src/gem/testbedFlavors.ts src/gem/__tests__/testbedFlavors.test.ts
git commit -m "feat(testbed): suggestTestbed cwd probe (looksLikeProject + flavor)"
```

---

### Task 3: New endpoints — `/testbed/suggestion`, `/testbed/recents`; scaffold upserts recents

Add the two GET endpoints and make the scaffold handler record a recent. The old `/testbed/projects` endpoint stays for now (deleted in Task 4) so the build stays green.

**Files:**
- Modify: `src/schemas.ts` (add suggestion + recents schemas; ~after line 333)
- Modify: `src/gem.controller.ts` (imports; new handlers; scaffold upsert)
- Test: `src/__tests__/gem.controller.test.ts` (add suggestion + recents tests)

**Interfaces:**
- Consumes: `suggestTestbed`, `TestbedSuggestion` (Task 2); `agentgemHome` (Task 1), `readRecents`, `upsertRecent`, `RecentEntry` (Task 1); existing `PickQuerySchema`, `resolveProject`.
- Produces:
  - `TestbedSuggestionQuerySchema = z.object({ cwd: z.string().optional() })`
  - `TestbedSuggestionResponseSchema = z.object({ cwd, looksLikeProject, flavor: nullable, name })`
  - `TestbedRecentsResponseSchema = z.object({ recents: array of { path, flavor, name, lastUsed, exists } })`
  - `GET /api/testbed/suggestion` → suggestion object
  - `GET /api/testbed/recents` → `{ recents }`

- [ ] **Step 1: Write the failing tests**

Add to `src/__tests__/gem.controller.test.ts` before the final closing `});` of the top-level describe (i.e. after the existing "recent projects" test, ~line 421):

```typescript
  it("suggestion: reports the cwd folder as a claude project", async () => {
    const proj = mkdtempSync(join(tmpdir(), "sug-"));
    mkdirSync(join(proj, ".claude"), { recursive: true });
    try {
      const r = await client.get(`/api/testbed/suggestion?cwd=${encodeURIComponent(proj)}`).expect(200);
      expect(r.body).toMatchObject({ looksLikeProject: true, flavor: "claude" });
      expect(r.body.cwd).toBe(proj);
      expect(typeof r.body.name).toBe("string");
    } finally { rmSync(proj, { recursive: true, force: true }); }
  });

  it("recents: scaffolding records a recent that /recents returns with exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "rec-"));
    const proj = mkdtempSync(join(tmpdir(), "recproj-"));
    const prev = process.env.AGENTGEM_HOME;
    process.env.AGENTGEM_HOME = home;
    try {
      await client.post("/api/testbed/scaffold")
        .send({ root: proj, name: "myagent", flavor: "claude" }).expect(200);
      const r = await client.get("/api/testbed/recents").expect(200);
      expect(r.body.recents[0]).toMatchObject({ path: proj, flavor: "claude", name: "myagent", exists: true });
    } finally {
      if (prev !== undefined) process.env.AGENTGEM_HOME = prev; else delete process.env.AGENTGEM_HOME;
      rmSync(home, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- gem.controller`
Expected: FAIL — `/api/testbed/suggestion` and `/api/testbed/recents` return 404 (routes not registered).

- [ ] **Step 3: Add schemas to `src/schemas.ts`**

Insert after `TestbedDetectResponseSchema` (line 333):

```typescript
// cwd probe for the front door. `cwd` overrides process.cwd() (tests); production omits it.
export const TestbedSuggestionQuerySchema = z.object({ cwd: z.string().optional() });
export const TestbedSuggestionResponseSchema = z.object({
  cwd: z.string(),
  looksLikeProject: z.boolean(),
  flavor: TestbedFlavorIdSchema.nullable(),
  name: z.string(),
});

// Persisted "testbeds opened in agentgem". `exists` is computed per-request (stale paths).
export const RecentEntrySchema = z.object({
  path: z.string(),
  flavor: TestbedFlavorIdSchema,
  name: z.string(),
  lastUsed: z.string(),
  exists: z.boolean(),
});
export const TestbedRecentsResponseSchema = z.object({ recents: z.array(RecentEntrySchema) });
```

- [ ] **Step 4: Update `src/gem.controller.ts` imports**

At the top of the file add node imports (the controller currently imports neither):

```typescript
import { existsSync } from "node:fs";
import { basename } from "node:path";
```

Add the new schema names to the existing `from "./schemas.js"` import block (line ~29, alongside `TestbedProjectsQuerySchema, TestbedProjectsResponseSchema,`):

```typescript
  TestbedSuggestionQuerySchema, TestbedSuggestionResponseSchema,
  TestbedRecentsResponseSchema,
```

Add `suggestTestbed` to the testbedFlavors import (line 41):

```typescript
import { detectFlavor, suggestTestbed, discoverProjects } from "./gem/testbedFlavors.js";
```

Add the recents/home imports. Update the resolveDir import (line 45) to include `agentgemHome`:

```typescript
import { resolveDirs, resolveProject, agentgemHome } from "./resolveDir.js";
import { readRecents, upsertRecent } from "./gem/recents.js";
```

- [ ] **Step 5: Add the two handlers + scaffold upsert**

Add these two handlers right after `testbedDetect` (after line 206):

```typescript
  @get("/testbed/suggestion", { query: TestbedSuggestionQuerySchema, response: TestbedSuggestionResponseSchema })
  async testbedSuggestion(input: { query: z.infer<typeof TestbedSuggestionQuerySchema> }): Promise<z.infer<typeof TestbedSuggestionResponseSchema>> {
    const cwd = resolveProject(input.query.cwd ?? process.cwd());
    const { looksLikeProject, flavor } = suggestTestbed(cwd);
    return { cwd, looksLikeProject, flavor, name: basename(cwd) };
  }

  @get("/testbed/recents", { query: PickQuerySchema, response: TestbedRecentsResponseSchema })
  async testbedRecents(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof TestbedRecentsResponseSchema>> {
    const recents = readRecents(agentgemHome()).map((r) => ({ ...r, exists: existsSync(r.path) }));
    return { recents };
  }
```

Replace the existing `scaffoldTestbed` handler (lines 216-219) with one that upserts a recent:

```typescript
  @post("/testbed/scaffold", { body: TestbedScaffoldRequestSchema, response: TestbedScaffoldResponseSchema })
  async scaffoldTestbed(input: { body: z.infer<typeof TestbedScaffoldRequestSchema> }): Promise<z.infer<typeof TestbedScaffoldResponseSchema>> {
    const root = resolveProject(input.body.root);
    const flavor = (input.body.flavor ?? "claude") as TestbedFlavorId;
    const res = scaffoldTestbed(root, input.body.name, flavor);
    upsertRecent(agentgemHome(), { path: root, flavor, name: input.body.name });
    return res;
  }
```

(`PickQuerySchema` is already imported — it backs `/registry/ready`. `TestbedFlavorId` is already imported.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- gem.controller`
Expected: PASS — both new tests pass; all existing controller tests (including the still-present `/testbed/projects` test) still pass.

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(testbed): /testbed/suggestion + /testbed/recents; scaffold records recents"
```

---

### Task 4: Delete the session-log scan

Remove the cross-repo Claude/Codex `.jsonl` scan and its endpoint/schemas/tests now that recents replaces it. Each sub-edit below keeps the build compiling only at the end, so do them together before testing.

**Files:**
- Modify: `src/gem/testbedFlavors.ts` (delete scan code; trim `TestbedFlavor` interface; trim fs imports)
- Modify: `src/gem.controller.ts` (delete `/testbed/projects` handler + `recentProjectsEnabled`; trim imports)
- Modify: `src/schemas.ts` (delete projects schemas)
- Modify: `src/gem/__tests__/testbedFlavors.test.ts` (delete `discoverProjects` block + import)
- Modify: `src/__tests__/gem.controller.test.ts` (delete the `/testbed/projects` test)

**Interfaces:**
- Produces: `TestbedFlavor` interface no longer has a `discoverProjects` member. No code outside this task referenced the removed symbols (verified by grep).

- [ ] **Step 1: Trim `src/gem/testbedFlavors.ts`**

1. Delete the `RawProject` interface (lines ~16-21) and the `DiscoveryDirs` type alias (lines ~13-14) and the `import type { resolveDirs } from "../resolveDir.js";` line.
2. Delete the `discoverProjects(dirs: DiscoveryDirs): RawProject[];` member from the `TestbedFlavor` interface (line ~36) and its `// Inverse of detect…` comment.
3. Delete the `discoverProjects:` property from each of the three flavor entries (`claude` line ~101, `codex` line ~117, `hermes` line ~132) and their adjacent `// ~/.claude…` / `// ~/.codex…` / `// Hermes sessions…` comments.
4. Delete the entire `// ── Project discovery …` section: `ProjectCandidate` interface, `discoverProjects` function, `readHead`, `firstLine`, `safeMtime`, `CWD_RE`, `cwdByFile`, `cachedCwd`, `readClaudeCwd`, `discoverClaudeProjects`, `newestJsonl`, `readCodexMetaCwd`, `discoverCodexProjects`, `walkJsonl` (lines ~154-320 — everything after `detectFlavor`/`suggestTestbed` to EOF).
5. Trim the fs import (line 5) to only what remains in use: `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";` (drop `closeSync, openSync, readdirSync, readSync, statSync`).

The file should now end with the `suggestTestbed` function from Task 2.

- [ ] **Step 2: Trim `src/gem.controller.ts`**

1. Delete the `@get("/testbed/projects" …)` handler and its `// Scanning the user's whole…` comment (lines ~208-214).
2. Delete the `recentProjectsEnabled()` function and its comment (lines ~286-289).
3. Remove `TestbedProjectsQuerySchema, TestbedProjectsResponseSchema,` from the `./schemas.js` import (line 29).
4. Change the testbedFlavors import to drop `discoverProjects`: `import { detectFlavor, suggestTestbed } from "./gem/testbedFlavors.js";`

- [ ] **Step 3: Trim `src/schemas.ts`**

Delete `TestbedProjectsQuerySchema`, `ProjectCandidateSchema`, `TestbedProjectsResponseSchema` and their comments (lines ~335-349).

- [ ] **Step 4: Trim the tests**

In `src/gem/__tests__/testbedFlavors.test.ts`:
- Remove `discoverProjects` from the import on line 5 → `import { TESTBED_FLAVORS, detectFlavor, suggestTestbed, writeMcpCodexToml } from "../testbedFlavors.js";`
- Delete the entire `describe("discoverProjects", …)` block (lines ~28-66, through its closing `});`). If `resolveDirs` is now unused in this file, remove its import on line 7.

In `src/__tests__/gem.controller.test.ts`:
- Delete the `it("recent projects: gated off by default…")` test (lines ~396-421).

- [ ] **Step 5: Clean build + run the full suite**

Run: `rm -rf dist tsconfig.tsbuildinfo && npm test`
Expected: PASS — full suite green, no references to removed symbols, no TS "unused"/"cannot find name" errors.

- [ ] **Step 6: Verify the endpoint is gone and no dangling refs**

Run: `grep -rn "discoverProjects\|TestbedProjects\|ProjectCandidate\|recentProjectsEnabled\|AGENTGEM_RECENT_PROJECTS\|RawProject" src --include="*.ts"`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/gem/testbedFlavors.ts src/gem.controller.ts src/schemas.ts src/gem/__tests__/testbedFlavors.test.ts src/__tests__/gem.controller.test.ts
git commit -m "refactor(testbed): delete cross-repo session-log scan (replaced by recents)"
```

---

### Task 5: Front-door UI — confirm cwd, pick recent, inline flavor toggle

Rewrite the testbed modal in `src/public/index.html`: a top block confirming the cwd suggestion (editable name + inline flavor toggle), then the recents list, then Browse. Remove both `prompt()` calls and the "suggestions are off" branch.

**Files:**
- Modify: `src/public/index.html` (markup lines 268-277; JS lines 298-351; event wiring lines 1015-1016)

**Interfaces:**
- Consumes: `GET /api/testbed/suggestion`, `GET /api/testbed/recents`, `GET /api/testbed/detect`, `GET /api/pick-folder`, `POST /api/testbed/scaffold`. Existing helpers `FLAVORS`, `setFlavor`, `setTestbed`, `load`, `esc`.
- Produces: front-door behavior; no exported symbols.

- [ ] **Step 1: Replace the modal markup**

Replace the `#recentModal` block (lines 268-277) with:

```html
<div id="recentModal" class="modal-bg" hidden>
  <div class="modal">
    <div class="modal-h"><strong class="t">Open a testbed</strong><button id="recentClose" class="ghost" style="margin-left:auto">✕ Close</button></div>
    <div class="modal-body" style="padding:14px">
      <div id="tbCwd" hidden style="padding:12px;border:1px solid var(--line);border-radius:8px;margin-bottom:14px">
        <div style="margin-bottom:6px">This folder looks like a <span id="tbCwdFlavor"></span> project</div>
        <div class="d" id="tbCwdPath" style="margin-bottom:8px;word-break:break-all"></div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label class="d">name</label>
          <input id="tbName" style="flex:1;min-width:120px" />
          <span id="tbFlavor" style="display:flex;gap:4px"></span>
          <button id="tbUse" style="margin-left:auto">Use this ▸</button>
        </div>
      </div>
      <div class="src" style="margin-bottom:6px">Recent <span class="d">(testbeds you've opened here)</span></div>
      <div id="recentList">Loading…</div>
    </div>
    <div class="modal-h" style="border-top:1px solid var(--line);border-bottom:0">
      <span class="d">Not this folder? Pick a recent one above, or browse.</span>
      <button id="recentBrowse" style="margin-left:auto">Browse folder…</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Replace the JS (`openOrCreateTestbed` through `browseForTestbed`)**

Replace lines 298-351 (from the `// Entry point…` comment through the end of `browseForTestbed`) with:

```javascript
// Front door: confirm the cwd suggestion up top, with recents + Browse below.
let candidate = null; // { path, flavor } currently shown in the top block

async function openOrCreateTestbed(){
  document.getElementById("recentModal").hidden = false;
  try {
    const s = await (await fetch("/api/testbed/suggestion")).json();
    if (s.looksLikeProject) renderCandidate(s.cwd, s.flavor, s.name);
    else renderCandidate(null);
  } catch { renderCandidate(null); }
  renderRecents();
}

// Fill (or hide) the top "use this folder" block. flavor null -> toggle starts unset.
function renderCandidate(path, flavor, name){
  const box = document.getElementById("tbCwd");
  if(!path){ box.hidden = true; candidate = null; return; }
  box.hidden = false;
  candidate = { path, flavor: flavor || null };
  document.getElementById("tbCwdPath").textContent = path;
  document.getElementById("tbName").value = name || path.replace(/^.*\//, "");
  renderFlavorToggle();
}

function renderFlavorToggle(){
  document.getElementById("tbCwdFlavor").textContent = candidate.flavor ? (FLAVORS[candidate.flavor]||{}).label || candidate.flavor : "—";
  const el = document.getElementById("tbFlavor");
  el.innerHTML = Object.entries(FLAVORS).map(([id,f])=>
    `<button type="button" class="ghost" data-f="${id}" aria-pressed="${candidate.flavor===id}"${candidate.flavor===id?' style="font-weight:700;text-decoration:underline"':''}>${esc(f.label)}</button>`
  ).join("");
  el.querySelectorAll("button").forEach(b=>{ b.onclick = ()=>{ candidate.flavor = b.dataset.f; renderFlavorToggle(); }; });
  document.getElementById("tbUse").disabled = !candidate.flavor;
}

async function confirmCandidate(){
  if(!candidate || !candidate.flavor) return;
  const name = document.getElementById("tbName").value.trim() || candidate.path.replace(/^.*\//, "");
  document.getElementById("recentModal").hidden = true;
  await useTestbed(candidate.path, candidate.flavor, name);
}

async function renderRecents(){
  const list = document.getElementById("recentList");
  list.innerHTML = "Loading…";
  let recents = [];
  try { recents = (await (await fetch("/api/testbed/recents")).json()).recents || []; } catch {}
  if(!recents.length){
    list.innerHTML = `<p class="note">No recent testbeds yet — confirm the folder above, or <b>Browse folder…</b>.</p>`;
    return;
  }
  list.innerHTML = recents.map((p,i)=>{
    const short = esc(p.name || p.path.replace(/^.*\//, "") || p.path);
    const fl = esc((FLAVORS[p.flavor]||FLAVORS.claude).label);
    const when = p.lastUsed ? esc(p.lastUsed.slice(0,10)) : "";
    const stale = p.exists ? "" : ` <span class="d" title="path no longer exists">· missing</span>`;
    return `<label class="row recent" data-i="${i}"${p.exists?"":' style="opacity:.5"'}><span><b>${short}</b> <span class="src">${fl}</span> <span class="d">${esc(p.path)}</span>${stale}</span><span class="d" style="margin-left:auto">${when}</span></label>`;
  }).join("");
  list.querySelectorAll("label.recent").forEach(row=>{
    row.onclick = ()=>{ const p = recents[+row.dataset.i]; if(!p.exists) return; document.getElementById("recentModal").hidden = true; useTestbed(p.path, p.flavor, p.name); };
  });
}

// Adopt a known project+flavor: scaffold is idempotent (writeIfAbsent) and records a recent.
async function useTestbed(path, flavor, name){
  setFlavor(flavor);
  name = name || path.replace(/^.*\//, "");
  await fetch("/api/testbed/scaffold", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ root: path, name, flavor }) });
  setTestbed(path);
  load();
}

// Browse routes the picked folder back through the same confirm block (no prompts).
async function browseForTestbed(){
  const pick = await (await fetch("/api/pick-folder")).json();
  if(!pick.path) return;
  const flavor = (await (await fetch(`/api/testbed/detect?root=${encodeURIComponent(pick.path)}`)).json()).flavor;
  renderCandidate(pick.path, flavor, pick.path.replace(/^.*\//, ""));
}
```

- [ ] **Step 3: Wire the new buttons**

Find the event wiring near line 1015-1016:

```javascript
document.getElementById("recentClose").onclick = () => document.getElementById("recentModal").hidden = true;
document.getElementById("recentBrowse").onclick = browseForTestbed;
```

Add a `tbUse` handler after them:

```javascript
document.getElementById("tbUse").onclick = confirmCandidate;
```

- [ ] **Step 4: Build and verify no stray references**

Run: `npm run build`
Expected: build succeeds (copies `index.html` into `dist/public`).

Run: `grep -n "testbed/projects\|AGENTGEM_RECENT_PROJECTS\|prompt(" src/public/index.html`
Expected: no output (no scan endpoint, no env hint, no `prompt()` calls).

- [ ] **Step 5: Manual verification (run the app)**

```bash
cd src/public/..  # ensure cwd is the agentgem repo root (a project)
node dist/index.js
```

In the browser at the printed UI URL:
- Click **Create / open testbed…** → the top block shows the repo path, flavor `Claude Code` preselected, an editable name, and an enabled **Use this ▸**.
- Click **Use this ▸** → the modal closes, inventory + Lapidary Ledger render, and the header chip shows the folder.
- Re-open the modal → the just-opened testbed now appears under **Recent**.
- Click **Browse folder…**, pick a non-marker folder → top block re-renders with a flavor toggle (none selected, **Use this** disabled until a flavor is chosen).

Stop the server (Ctrl-C).

- [ ] **Step 6: Commit**

```bash
git add src/public/index.html
git commit -m "feat(testbed): cwd-first front door — confirm/recents/inline flavor toggle, drop prompts"
```

---

## Self-Review

**Spec coverage:**
- §1 startup probe → Task 2 (`suggestTestbed`) + Task 3 (`/testbed/suggestion`, `name` via `basename`, `cwd` override). ✓
- §2 single front-door screen, inline flavor toggle, no `prompt()` → Task 5. ✓
- §3 persisted recents (`~/.agentgem/recents.json`, shape, dedup, cap 10, best-effort write, `exists` flag, upsert on every open) → Task 1 + Task 3 (`/testbed/recents`, scaffold upsert) + Task 5 (render). ✓
- §4 endpoints table → Task 3 (add) + Task 4 (delete `/testbed/projects`). ✓
- §5 deletions (scan code, env gate, schemas, UI branch, prompts, dead tests) → Task 4 + Task 5. ✓
- Error handling (malformed recents → `[]`, non-writable home → best-effort, probe throws → degrade) → Task 1 tests + Task 3 behavior. ✓ Note: per the design's simplification, missing recents are shown non-clickable with a badge (matching existing UX); there is no separate prune-on-click endpoint — the 10-cap self-cleans over time.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The `void existsSync;` note in Task 1 Step 4 explicitly tells the implementer to remove the unused import — resolved, not a placeholder.

**Type consistency:** `RecentEntry` (path/flavor/name/lastUsed) consistent across Task 1 store, Task 3 schema (`RecentEntrySchema` adds `exists`), and Task 5 render. `TestbedSuggestion` (looksLikeProject/flavor) consistent Task 2 → Task 3. `upsertRecent(home, {path,flavor,name})` signature matches its single caller in Task 3. `agentgemHome()` defined Task 1, used Task 3. Flavor ids consistent throughout.
