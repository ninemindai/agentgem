# Gem Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a gem a persistent local home under `~/.agentgem/workspaces/<name>/` — the canonical archive at root (source of truth) plus `.targets/<target>/` rendered harness layouts (derived) — with create/list/read/render/delete ops and a UI switcher.

**Architecture:** A new orchestration module `src/gem/workspaces.ts` composes the existing pure core (`writePackArchive`, `readPackArchive`, `materialize`, `compatibility`) and owns workspace disk layout. Two small surgical changes to the archive layer make it fit: `readArchiveDir` ignores top-level dot-entries (so `.targets/` doesn't corrupt archive reads), and `writePackArchive` stops double-appending extensions. Five REST/MCP ops + a UI switcher sit on top.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod v4, `@agentback/*` (rest/openapi controllers), Vitest (tests run from compiled `dist/`), `node:fs`/`node:os`/`node:path`. No new dependencies.

## Global Constraints

- **ESM imports use `.js` extensions** even from `.ts` sources (NodeNext).
- **Tests run from `dist/`**: `npm test` = `tsc -b && vitest run`. Focused: `npm test -- -t "<pattern>"`. A `tsc` error fails the run.
- **The pure core stays pure**: `archive.ts` and `targets.ts` do no disk/network/env beyond what they already do (`archive.ts` = `node:crypto` + `node:zlib` for tar only). ALL workspace filesystem code lives in `workspaces.ts` (and the existing `archiveFs.ts`).
- **Reuse, don't duplicate**: import `materialize`, `compatibility`, `TARGET_REGISTRY`, `TargetId`, `SkippedArtifact`, `safePathSegment` from `./targets.js`; `writePackArchive`/`readPackArchive` from `./archive.js`; `writeArchiveDir`/`readArchiveDir` from `./archiveFs.js`.
- **Managed root**: `workspacesRoot()` = `${process.env.AGENTGEM_HOME ?? join(homedir(), ".agentgem")}/workspaces`. Tests set `AGENTGEM_HOME` to a temp dir.
- **Name is untrusted**: a workspace name must equal its `safePathSegment` form (no separators, no `..`); otherwise throw. This is stricter than silent sanitization and prevents two names colliding to one dir.
- **Secret-safety**: workspaces persist an already-redacted archive; no secret value touches disk. Assert in tests.
- **`.targets/<target>/` is derived**: a render clears the target subdir first, then writes the verbatim `materialize(gem, target)` FileTree.

---

### Task 1: No double-extension in archive body filenames

**Files:**
- Modify: `src/gem/archive.ts` (the `writePackArchive` body-path lines)
- Test: `src/gem/__tests__/archive.test.ts`

**Interfaces:**
- Consumes: existing `writePackArchive` (Task 2 of the archive feature).
- Produces: instructions/mcp/hook/check body paths no longer double an extension the sanitized name already carries.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/gem/__tests__/archive.test.ts (inside the writePackArchive describe block)
it("does not double the extension when an artifact name already ends in it", () => {
  const p = gem([
    { type: "instructions", name: "CLAUDE.md", content: "be kind" },
    { type: "mcp_server", name: "ctx.json", transport: "http", config: { url: "https://x/sse" } },
  ]);
  const { files } = writePackArchive(p);
  expect(files["instructions/CLAUDE.md"]).toBe("be kind");        // not instructions/CLAUDE.md.md
  expect(files["instructions/CLAUDE.md.md"]).toBeUndefined();
  expect(files["mcp/ctx.json"]).toBeDefined();                    // not mcp/ctx.json.json
  expect(files["mcp/ctx.json.json"]).toBeUndefined();
  expect(readPackArchive(files)).toEqual(p);                      // still round-trips
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "does not double the extension"`
Expected: FAIL — file is at `instructions/CLAUDE.md.md`, so `files["instructions/CLAUDE.md"]` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/gem/archive.ts`, inside `writePackArchive`, add a small helper near the top of the function body (after `const artifacts: ManifestArtifactEntry[] = [];`):

```ts
  const withExt = (s: string, ext: string) => (s.endsWith(ext) ? s : s + ext);
```

Then change the four body-path lines to use it:

```ts
// instructions:
const path = `instructions/${withExt(seg, ".md")}`;
// mcp_server:
const path = `mcp/${withExt(seg, ".json")}`;
// hook:
const path = `hooks/${withExt(seg, ".json")}`;
// checks loop:
const path = `checks/${withExt(safePathSegment(c.name), ".json")}`;
```

(Leave the skill path `skills/${seg}/SKILL.md` unchanged — it is directory-based and cannot double.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "does not double the extension"` then `npm test -- -t "writePackArchive"` and `npm test -- -t "readPackArchive"`
Expected: PASS (round-trip identity still green).

- [ ] **Step 5: Commit**

```bash
git add src/gem/archive.ts src/gem/__tests__/archive.test.ts
git commit -m "fix(archive): don't double an extension the artifact name already has"
```

---

### Task 2: `readArchiveDir` ignores top-level dot-entries

**Files:**
- Modify: `src/gem/archiveFs.ts`
- Test: `src/gem/__tests__/archiveFs.test.ts`

**Interfaces:**
- Consumes: existing `readArchiveDir`/`writeArchiveDir` (archive feature Task 5).
- Produces: `readArchiveDir(root)` skips any top-level entry whose name starts with `.` (e.g. `.targets/`, `.git/`), so an archive read from a workspace dir is not polluted by derived files.

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/archiveFs.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeArchiveDir, readArchiveDir } from "../archiveFs.js";

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "afs-")); tmps.push(d); return d; };
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

describe("readArchiveDir", () => {
  it("round-trips a written tree", () => {
    const root = tmp();
    const tree = { "gem.json": "{}", "skills/x/SKILL.md": "# x" };
    writeArchiveDir(root, tree);
    expect(readArchiveDir(root)).toEqual(tree);
  });

  it("skips top-level dot-entries (e.g. .targets/)", () => {
    const root = tmp();
    const tree = { "gem.json": "{}", "skills/x/SKILL.md": "# x" };
    writeArchiveDir(root, tree);
    mkdirSync(join(root, ".targets", "eve"), { recursive: true });
    writeFileSync(join(root, ".targets", "eve", "agent.ts"), "derived");
    expect(readArchiveDir(root)).toEqual(tree); // .targets content not present
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "skips top-level dot-entries"`
Expected: FAIL — result includes `.targets/eve/agent.ts`.

- [ ] **Step 3: Write minimal implementation**

In `src/gem/archiveFs.ts`, change the `walk` closure inside `readArchiveDir` to skip top-level dot-entries:

```ts
export function readArchiveDir(root: string): FileTree {
  const files: FileTree = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (d === root && entry.startsWith(".")) continue; // skip .targets/, .git/, etc. (archive files are never dot-prefixed)
      const abs = join(d, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else files[relative(root, abs).split(sep).join("/")] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return files;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "readArchiveDir"`
Expected: PASS (both round-trip and dot-skip).

- [ ] **Step 5: Commit**

```bash
git add src/gem/archiveFs.ts src/gem/__tests__/archiveFs.test.ts
git commit -m "feat(archive): readArchiveDir skips top-level dot-entries (.targets/)"
```

---

### Task 3: `workspaces.ts` — lifecycle module

**Files:**
- Create: `src/gem/workspaces.ts`
- Test: `src/gem/__tests__/workspaces.test.ts`

**Interfaces:**
- Consumes: `Gem` from `./types.js`; `TargetId`, `SkippedArtifact`, `materialize`, `compatibility`, `TARGET_REGISTRY`, `safePathSegment` from `./targets.js`; `writePackArchive`, `readPackArchive` from `./archive.js`; `writeArchiveDir`, `readArchiveDir` from `./archiveFs.js`.
- Produces:
  - `workspacesRoot(): string`, `workspaceName(name): string` (throws on bad), `workspaceDir(name): string`
  - `WorkspaceSummary`, `WorkspaceDetail`, `RenderResult` interfaces
  - `createWorkspace(name, gem, opts?)`, `listWorkspaces()`, `readWorkspace(name)`, `renderTarget(name, target)`, `deleteWorkspace(name)`

- [ ] **Step 1: Write the failing test**

```ts
// src/gem/__tests__/workspaces.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  workspacesRoot, workspaceDir, createWorkspace, listWorkspaces, readWorkspace, renderTarget, deleteWorkspace,
} from "../workspaces.js";
import type { Gem, PackArtifact } from "../types.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { delete process.env.AGENTGEM_HOME; rmSync(home, { recursive: true, force: true }); });

const gem = (artifacts: PackArtifact[]): Gem => ({ name: "demo", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [] });
const skill = (n: string, content = "# body"): PackArtifact => ({ type: "skill", name: n, source: "standalone", content });
const instr = (): PackArtifact => ({ type: "instructions", name: "soul", content: "be kind" });

describe("workspaces", () => {
  it("workspacesRoot honors AGENTGEM_HOME", () => {
    expect(workspacesRoot()).toBe(join(home, "workspaces"));
  });

  it("workspaceDir rejects names with separators or traversal", () => {
    expect(() => workspaceDir("../escape")).toThrow(/invalid workspace name/i);
    expect(() => workspaceDir("a/b")).toThrow(/invalid workspace name/i);
    expect(workspaceDir("my-gem")).toBe(join(home, "workspaces", "my-gem"));
  });

  it("create writes the archive; list and read report it", () => {
    const s = createWorkspace("mp", gem([skill("review"), instr()]));
    expect(s.name).toBe("mp");
    expect(s.artifactCounts.skill).toBe(1);
    expect(s.renderedTargets).toEqual([]);
    expect(existsSync(join(home, "workspaces", "mp", "gem.json"))).toBe(true);

    const list = listWorkspaces();
    expect(list.map((w) => w.name)).toEqual(["mp"]);

    const detail = readWorkspace("mp");
    expect(detail.files["skills/review/SKILL.md"]).toBe("# body");
    expect(detail.compatibility.claude.supported).toBeGreaterThan(0);
  });

  it("create throws on a duplicate name", () => {
    createWorkspace("dup", gem([skill("a")]));
    expect(() => createWorkspace("dup", gem([skill("b")]))).toThrow(/already exists/i);
  });

  it("renderTarget writes .targets/<target>/ and clears stale files on re-render", () => {
    createWorkspace("rw", gem([skill("review"), instr()]));
    const r = renderTarget("rw", "eve");
    expect(r.target).toBe("eve");
    expect(r.files["agent/skills/review.md"]).toBe("# body");
    expect(existsSync(join(home, "workspaces", "rw", ".targets", "eve", "agent", "skills", "review.md"))).toBe(true);
    expect(readWorkspace("rw").renderedTargets).toEqual(["eve"]);

    // re-render claude after also rendering eve: stale eve files must not leak into claude
    renderTarget("rw", "claude");
    const claudeDir = join(home, "workspaces", "rw", ".targets", "claude");
    expect(existsSync(join(claudeDir, "skills", "review", "SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "agent"))).toBe(false);
  });

  it("delete removes the workspace; listing an empty root is []", () => {
    createWorkspace("gone", gem([skill("a")]));
    deleteWorkspace("gone");
    expect(existsSync(join(home, "workspaces", "gone"))).toBe(false);
    expect(listWorkspaces()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "workspaces"`
Expected: FAIL — `Cannot find module '../workspaces.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/gem/workspaces.ts
// A gem's persistent local home: the canonical archive at the workspace root (source of truth) plus
// .targets/<target>/ rendered harness layouts (derived). Orchestration over the pure archive/materialize
// core; this module owns all workspace filesystem I/O.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import type { Gem } from "./types.js";
import type { TargetId, SkippedArtifact } from "./targets.js";
import { materialize, compatibility, TARGET_REGISTRY, safePathSegment } from "./targets.js";
import { writePackArchive, readPackArchive } from "./archive.js";
import { writeArchiveDir, readArchiveDir } from "./archiveFs.js";

const TARGETS_DIR = ".targets";

export interface WorkspaceSummary {
  name: string;
  packName: string;
  version: string;
  artifactCounts: { skill: number; mcp_server: number; instructions: number; hook: number };
  checks: number;
  renderedTargets: TargetId[];
}
export interface WorkspaceDetail extends WorkspaceSummary {
  files: Record<string, string>;
  compatibility: Record<TargetId, { supported: number; skipped: number }>;
}
export interface RenderResult {
  target: TargetId;
  files: Record<string, string>;
  skipped: SkippedArtifact[];
  path: string;
}

export function workspacesRoot(): string {
  const home = process.env.AGENTGEM_HOME ?? join(homedir(), ".agentgem");
  return join(home, "workspaces");
}

// A workspace name must already be a safe single path segment — reject anything else (no separators,
// no `.`/`..`), so two distinct requests never collide to one directory and nothing escapes the root.
export function workspaceName(name: string): string {
  const seg = safePathSegment(name);
  if (seg !== name) throw new Error(`invalid workspace name '${name}' — use only [A-Za-z0-9._-], no separators`);
  return seg;
}
export function workspaceDir(name: string): string {
  return join(workspacesRoot(), workspaceName(name));
}

function countArtifacts(entries: { type: string }[]): WorkspaceSummary["artifactCounts"] {
  const c = { skill: 0, mcp_server: 0, instructions: 0, hook: 0 };
  for (const e of entries) if (e.type in c) (c as Record<string, number>)[e.type]++;
  return c;
}

function renderedTargets(dir: string): TargetId[] {
  const t = join(dir, TARGETS_DIR);
  if (!existsSync(t)) return [];
  return readdirSync(t).filter((n) => statSync(join(t, n)).isDirectory() && n in TARGET_REGISTRY) as TargetId[];
}

function summary(name: string, manifestJson: string, dir: string): WorkspaceSummary {
  const m = JSON.parse(manifestJson) as { name: string; version: string; artifacts: { type: string }[]; checks: unknown[] };
  return {
    name,
    packName: m.name,
    version: m.version,
    artifactCounts: countArtifacts(m.artifacts),
    checks: m.checks.length,
    renderedTargets: renderedTargets(dir),
  };
}

export function createWorkspace(name: string, gem: Gem, opts: { version?: string } = {}): WorkspaceSummary {
  const dir = workspaceDir(name);
  if (existsSync(dir)) throw new Error(`workspace '${name}' already exists`);
  const { files } = writePackArchive(gem, { version: opts.version });
  mkdirSync(dir, { recursive: true });
  writeArchiveDir(dir, files);
  return summary(workspaceName(name), files["gem.json"], dir);
}

export function listWorkspaces(): WorkspaceSummary[] {
  const root = workspacesRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => statSync(join(root, n)).isDirectory() && existsSync(join(root, n, "gem.json")))
    .map((n) => summary(n, readFileSync(join(root, n, "gem.json"), "utf8"), join(root, n)));
}

export function readWorkspace(name: string): WorkspaceDetail {
  const dir = workspaceDir(name);
  if (!existsSync(join(dir, "gem.json"))) throw new Error(`no workspace '${name}'`);
  const files = readArchiveDir(dir);               // skips .targets/ (Task 2)
  const gem = readPackArchive(files);             // verifies the lock
  return { ...summary(workspaceName(name), files["gem.json"], dir), files, compatibility: compatibility(gem) };
}

export function renderTarget(name: string, target: TargetId): RenderResult {
  const dir = workspaceDir(name);
  if (!existsSync(join(dir, "gem.json"))) throw new Error(`no workspace '${name}'`);
  const gem = readPackArchive(readArchiveDir(dir));
  const { files, skipped } = materialize(gem, target);
  const out = join(dir, TARGETS_DIR, target);
  rmSync(out, { recursive: true, force: true });   // clear stale renders
  mkdirSync(out, { recursive: true });
  writeArchiveDir(out, files);
  return { target, files, skipped, path: out };
}

export function deleteWorkspace(name: string): void {
  const dir = workspaceDir(name);
  if (!existsSync(dir)) throw new Error(`no workspace '${name}'`);
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "workspaces"`
Expected: PASS (all six cases).

- [ ] **Step 5: Commit**

```bash
git add src/gem/workspaces.ts src/gem/__tests__/workspaces.test.ts
git commit -m "feat(workspaces): create/list/read/render/delete lifecycle module"
```

---

### Task 4: Workspace Zod schemas

**Files:**
- Modify: `src/schemas.ts`
- Test: `src/__tests__/schemas.test.ts`

**Interfaces:**
- Consumes: existing `PackSelectionSchema`, `TargetIdSchema`, `SkippedArtifactSchema`.
- Produces: `WorkspaceSummarySchema`, `WorkspaceDetailSchema`, `RenderResultSchema`, `CreateWorkspaceRequestSchema`, `WorkspaceQuerySchema`, `RenderRequestSchema`, `WorkspaceNameRequestSchema`, `ListWorkspacesResponseSchema`, `DeleteWorkspaceResponseSchema`.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/schemas.test.ts
import {
  WorkspaceSummarySchema, CreateWorkspaceRequestSchema, RenderRequestSchema, RenderResultSchema,
} from "../schemas.js";

describe("workspace schemas", () => {
  it("validates a workspace summary", () => {
    expect(WorkspaceSummarySchema.safeParse({
      name: "mp", packName: "demo", version: "0.1.0",
      artifactCounts: { skill: 1, mcp_server: 0, instructions: 1, hook: 0 }, checks: 0, renderedTargets: ["eve"],
    }).success).toBe(true);
  });
  it("create requires name+selection; render requires name+target", () => {
    expect(CreateWorkspaceRequestSchema.safeParse({ name: "mp", selection: { all: true } }).success).toBe(true);
    expect(CreateWorkspaceRequestSchema.safeParse({ selection: { all: true } }).success).toBe(false);
    expect(RenderRequestSchema.safeParse({ name: "mp", target: "eve" }).success).toBe(true);
    expect(RenderRequestSchema.safeParse({ name: "mp", target: "nope" }).success).toBe(false);
    expect(RenderResultSchema.safeParse({ target: "eve", files: {}, skipped: [], path: "/x" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "workspace schemas"`
Expected: FAIL — `WorkspaceSummarySchema` is undefined.

- [ ] **Step 3: Write minimal implementation**

Append to `src/schemas.ts` (after the archive schemas):

```ts
// ── Workspaces ──
export const WorkspaceSummarySchema = z.object({
  name: z.string(),
  packName: z.string(),
  version: z.string(),
  artifactCounts: z.object({ skill: z.number(), mcp_server: z.number(), instructions: z.number(), hook: z.number() }),
  checks: z.number(),
  renderedTargets: z.array(TargetIdSchema),
});
export const WorkspaceDetailSchema = WorkspaceSummarySchema.extend({
  files: z.record(z.string(), z.string()),
  compatibility: z.record(TargetIdSchema, z.object({ supported: z.number(), skipped: z.number() })),
});
export const RenderResultSchema = z.object({
  target: TargetIdSchema,
  files: z.record(z.string(), z.string()),
  skipped: z.array(SkippedArtifactSchema),
  path: z.string(),
});
export const CreateWorkspaceRequestSchema = z.object({
  name: z.string(),
  selection: PackSelectionSchema,
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  version: z.string().optional(),
});
export const WorkspaceQuerySchema = z.object({ name: z.string() });
export const RenderRequestSchema = z.object({ name: z.string(), target: TargetIdSchema });
export const WorkspaceNameRequestSchema = z.object({ name: z.string() });
export const ListWorkspacesResponseSchema = z.object({ workspaces: z.array(WorkspaceSummarySchema) });
export const DeleteWorkspaceResponseSchema = z.object({ deleted: z.string() });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "workspace schemas"` then `npm test -- -t "schemas"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/__tests__/schemas.test.ts
git commit -m "feat(schemas): workspace request/response schemas"
```

---

### Task 5: Workspace controller ops

**Files:**
- Modify: `src/gem.controller.ts`
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Consumes: the workspace module (Task 3) and schemas (Task 4); existing `buildPack`, `resolveDirs`, `introspectAll`.
- Produces (uses `@get`/`@post` only — no path params or DELETE verb, for framework compatibility):
  - `POST /api/workspaces` (create) · `GET /api/workspaces` (list) · `GET /api/workspace` (read, `?name=`) · `POST /api/workspace/render` (render) · `POST /api/workspace/delete` (delete)

- [ ] **Step 1: Write the failing test**

```ts
// append to src/__tests__/gem.controller.test.ts
import { mkdtempSync as mkd } from "node:fs"; // reuse existing imports; shown only to signal dependency
describe("workspace ops", () => {
  it("create -> list -> render(eve) -> read -> delete", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsh-"));
    process.env.AGENTGEM_HOME = home;
    try {
      const c = await client.post("/api/workspaces")
        .send({ dir, name: "mp", selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true } })
        .expect(200);
      expect(c.body.name).toBe("mp");
      expect(c.body.artifactCounts.skill).toBe(1);

      const l = await client.get("/api/workspaces").expect(200);
      expect(l.body.workspaces.map((w: { name: string }) => w.name)).toEqual(["mp"]);

      const r = await client.post("/api/workspace/render").send({ name: "mp", target: "eve" }).expect(200);
      expect(r.body.files["agent/skills/review.md"]).toContain("# Review");

      const d = await client.get("/api/workspace?name=mp").expect(200);
      expect(d.body.renderedTargets).toEqual(["eve"]);
      expect(JSON.stringify(d.body)).not.toContain("ghp_secret"); // redaction survives

      const del = await client.post("/api/workspace/delete").send({ name: "mp" }).expect(200);
      expect(del.body.deleted).toBe("mp");
      expect((await client.get("/api/workspaces").expect(200)).body.workspaces).toEqual([]);
    } finally {
      delete process.env.AGENTGEM_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

(Reuse the file's existing `mkdtempSync`, `join`, `tmpdir`, `rmSync` imports — do not add the aliased `mkd` line; it only signals the dependency.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- -t "workspace ops"`
Expected: FAIL — routes 404 / methods missing.

- [ ] **Step 3: Write minimal implementation**

In `src/gem.controller.ts`, add imports:

```ts
import { createWorkspace, listWorkspaces, readWorkspace, renderTarget, deleteWorkspace } from "./gem/workspaces.js";
import type { TargetId } from "./gem/targets.js";
```

Add to the `./schemas.js` import list: `CreateWorkspaceRequestSchema, WorkspaceQuerySchema, RenderRequestSchema, WorkspaceNameRequestSchema, WorkspaceSummarySchema, WorkspaceDetailSchema, RenderResultSchema, ListWorkspacesResponseSchema, DeleteWorkspaceResponseSchema`.

(`TargetId` may already be imported from a prior task — if so, don't duplicate the import.)

Add these methods inside the class (e.g. after `archive`):

```ts
  @post("/workspaces", { body: CreateWorkspaceRequestSchema, response: WorkspaceSummarySchema })
  async createWorkspace(input: { body: z.infer<typeof CreateWorkspaceRequestSchema> }): Promise<z.infer<typeof WorkspaceSummarySchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildPack(inventory, input.body.selection, { name: input.body.name, createdFrom: dirs.claudeDir });
    return createWorkspace(input.body.name, gem, { version: input.body.version });
  }

  @get("/workspaces", { query: PickQuerySchema, response: ListWorkspacesResponseSchema })
  async listWorkspaces(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof ListWorkspacesResponseSchema>> {
    return { workspaces: listWorkspaces() };
  }

  @get("/workspace", { query: WorkspaceQuerySchema, response: WorkspaceDetailSchema })
  async readWorkspace(input: { query: z.infer<typeof WorkspaceQuerySchema> }): Promise<z.infer<typeof WorkspaceDetailSchema>> {
    return readWorkspace(input.query.name);
  }

  @post("/workspace/render", { body: RenderRequestSchema, response: RenderResultSchema })
  async renderWorkspace(input: { body: z.infer<typeof RenderRequestSchema> }): Promise<z.infer<typeof RenderResultSchema>> {
    return renderTarget(input.body.name, input.body.target as TargetId);
  }

  @post("/workspace/delete", { body: WorkspaceNameRequestSchema, response: DeleteWorkspaceResponseSchema })
  async deleteWorkspace(input: { body: z.infer<typeof WorkspaceNameRequestSchema> }): Promise<z.infer<typeof DeleteWorkspaceResponseSchema>> {
    deleteWorkspace(input.body.name);
    return { deleted: input.body.name };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- -t "workspace ops"` then `npm test`
Expected: PASS (full suite green).

- [ ] **Step 5: Commit**

```bash
git add src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(api): workspace ops — create/list/read/render/delete"
```

---

### Task 6: UI — workspace switcher + per-target tabs

**Files:**
- Modify: `src/public/index.html`

**Interfaces:**
- Consumes: the five workspace endpoints (Task 5); existing `buildSelectionBody()`, the file-tree preview, and the content modal.
- Produces: a workspace switcher (list + "New workspace…") and, when a workspace is open, per-target tabs that render and show the `.targets/<target>/` file tree.

This is UI wiring with no unit-test harness (the project has no DOM test setup); verify by driving the running app (Step 4).

- [ ] **Step 1: Add the workspace bar markup**

Add, just below the existing `name` bar (`<div class="bar"><input id="name" …`), a workspace bar:

```html
    <div class="bar" id="wsBar">
      <select id="wsSelect" title="open a saved workspace" style="flex:1"><option value="">— no workspace —</option></select>
      <button id="wsNew" class="ghost" title="save the current selection as a new workspace">New workspace…</button>
      <button id="wsDelete" class="ghost" title="delete the open workspace" hidden>Delete</button>
    </div>
    <div class="bar" id="wsTargets" hidden></div>
    <div id="wsTree"></div>
```

- [ ] **Step 2: Add the workspace controller script**

Add before the closing `</script>` (reusing `esc`, `buildSelectionBody`, and the modal):

```js
let wsCurrent = "";
async function wsRefresh(){
  const r = await (await fetch("/api/workspaces")).json();
  const sel = document.getElementById("wsSelect");
  sel.innerHTML = `<option value="">— no workspace —</option>` + (r.workspaces || [])
    .map(w => `<option value="${esc(w.name)}"${w.name === wsCurrent ? " selected" : ""}>${esc(w.name)} · ${w.artifactCounts.skill + w.artifactCounts.mcp_server + w.artifactCounts.instructions + w.artifactCounts.hook} artifacts</option>`).join("");
  document.getElementById("wsDelete").hidden = !wsCurrent;
}
async function wsOpen(name){
  wsCurrent = name;
  const targets = document.getElementById("wsTargets"), tree = document.getElementById("wsTree");
  if (!name){ targets.hidden = true; targets.innerHTML = ""; tree.innerHTML = ""; document.getElementById("wsDelete").hidden = true; return; }
  const d = await (await fetch("/api/workspace?name=" + encodeURIComponent(name))).json();
  targets.hidden = false;
  targets.innerHTML = `<strong style="flex:1">Target layout</strong>` + Object.keys(d.compatibility)
    .map(t => `<button type="button" class="ghost wstab" data-t="${esc(t)}">${esc(t)}${(d.renderedTargets || []).includes(t) ? " ●" : ""}</button>`).join("");
  tree.innerHTML = `<p class="d">Pick a target to render its project layout.</p>`;
  document.getElementById("wsDelete").hidden = false;
}
async function wsRender(target){
  const tree = document.getElementById("wsTree");
  tree.innerHTML = `<p class="d">Rendering ${esc(target)}…</p>`;
  const r = await (await fetch("/api/workspace/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: wsCurrent, target }) })).json();
  window.__wsFiles = r.files || {};
  const paths = Object.keys(window.__wsFiles).sort();
  tree.innerHTML = `<div class="pgroup"><h3>${esc(target)} · ${paths.length} files <span class="d">${esc(r.path || "")}</span></h3>`
    + paths.map(p => `<button type="button" class="prow" data-wspath="${esc(p)}"><span class="pn">${esc(p)}</span></button>`).join("") + `</div>`;
  await wsRefresh();
}
document.getElementById("wsSelect").addEventListener("change", e => wsOpen(e.target.value));
document.getElementById("wsNew").addEventListener("click", async () => {
  const name = prompt("Workspace name (letters, digits, . _ - only):", document.getElementById("name").value || "gem");
  if (!name) return;
  const res = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...buildSelectionBody(), name }) });
  if (!res.ok){ alert("Could not create workspace (name taken or invalid)."); return; }
  await wsRefresh(); await wsOpen(name); document.getElementById("wsSelect").value = name;
});
document.getElementById("wsDelete").addEventListener("click", async () => {
  if (!wsCurrent || !confirm(`Delete workspace "${wsCurrent}"? This removes its folder and rendered targets.`)) return;
  await fetch("/api/workspace/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: wsCurrent }) });
  await wsOpen(""); await wsRefresh();
});
document.getElementById("wsTargets").addEventListener("click", e => { const b = e.target.closest(".wstab"); if (b) wsRender(b.dataset.t); });
document.getElementById("wsTree").addEventListener("click", e => {
  const b = e.target.closest("[data-wspath]"); if (!b) return;
  const p = b.dataset.wspath, body = (window.__wsFiles || {})[p] || "";
  document.getElementById("modal-title").textContent = p;
  document.getElementById("modal-sub").textContent = wsCurrent;
  document.getElementById("modal-body").textContent = body;
  document.getElementById("modal").hidden = false;
});
wsRefresh();
```

(If the modal open/close uses helper functions rather than toggling `.hidden` directly, mirror the existing `view`-click handler's modal-open code instead of the three `getElementById` lines above.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: `tsc -b` clean; `index.html` copied to `dist/public`.

- [ ] **Step 4: Drive the running app (manual verification)**

```bash
# seed a fake ~/.claude and a temp AGENTGEM_HOME, start the server, exercise the flow
SRC=$(mktemp -d); export AGENTGEM_HOME=$(mktemp -d)
mkdir -p "$SRC/skills/review"; printf '%s\n' '---' 'name: review' 'description: Review' '---' '# Review' > "$SRC/skills/review/SKILL.md"
PORT=4319 node dist/index.js &  SRV=$!
sleep 1
# create + render via the same endpoints the UI calls
curl -s localhost:4319/api/workspaces -H 'content-type: application/json' -d "{\"dir\":\"$SRC\",\"name\":\"wsdemo\",\"selection\":{\"skills\":[\"review\"]}}" >/dev/null
curl -s localhost:4319/api/workspace/render -H 'content-type: application/json' -d '{"name":"wsdemo","target":"eve"}' | python3 -c 'import sys,json;print("eve files:",list(json.load(sys.stdin)["files"]))'
curl -s "localhost:4319/api/workspaces" | python3 -c 'import sys,json;print("list:",[w["name"]+" rendered="+str(w["renderedTargets"]) for w in json.load(sys.stdin)["workspaces"]])'
kill $SRV; rm -rf "$SRC" "$AGENTGEM_HOME"; unset AGENTGEM_HOME
```

Expected: render returns `agent/skills/review.md` etc.; list shows `wsdemo rendered=['eve']`. (At gstack verify time, also load `/`, click **New workspace…**, then the **eve** tab, and confirm the file tree appears.)

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git commit -m "feat(ui): workspace switcher + per-target layout tabs"
```

---

## Deferred from this plan (named follow-ups)

- **Editing a workspace archive** (mutate bodies → recompute lock) — the manifest-editor subsystem; v1 is create-only.
- **Auto-render on change** (filesystem watch) — explicit render only.
- **Deploy from a workspace** — the deploy-registry follow-up.
- **`.gitignore` for `.targets/`** auto-written into a workspace — trivial add later if workspaces get `git init`'d.

---

## Self-Review

**Spec coverage:**
- §1.1 archive+`.targets` split → Task 3 `renderTarget` writes `.targets/<t>/` ✓
- §1.2 managed root → `workspacesRoot()` + `AGENTGEM_HOME` (Task 3) ✓
- §1.3 orchestration only → `workspaces.ts` composes existing core ✓
- §1.4 explicit render → render op/tab (Tasks 3,5,6) ✓
- §1.5 `readArchiveDir` dot-skip → Task 2 ✓
- §1.6 create-only → Task 3 throws on duplicate ✓
- §1.7 name sanitize+confine → Task 3 `workspaceName` throws; tested ✓
- §1.8 secret-safe → controller test asserts no `ghp_secret` (Task 5) ✓
- §2 layout → Tasks 3 (archive write) + render `.targets` ✓
- §3 module API → Task 3 ✓
- §4 five ops → Task 5 (query/body instead of `:name` path params — framework-compat deviation, noted) ✓
- §5 readArchiveDir change → Task 2 ✓
- §6 double-extension fix → Task 1 ✓
- §7 module changes → Tasks 1–6 ✓
- §8 testing → unit (1,2,3), schema (4), controller (5), page-drive (6) ✓

**Placeholder scan:** No TBD/TODO; each code step has complete code; each run step has command + expected result. ✓

**Type consistency:** `WorkspaceSummary`/`WorkspaceDetail`/`RenderResult` defined in Task 3 and mirrored as Zod schemas in Task 4 (same field names/types); `renderTarget(name, target)` and `RenderRequestSchema {name,target}` agree; controller routes (Task 5) match the endpoints the UI calls (Task 6: `/api/workspaces`, `/api/workspace`, `/api/workspace/render`, `/api/workspace/delete`). `safePathSegment`/`materialize`/`compatibility`/`TARGET_REGISTRY` imported from `./targets.js` consistently. ✓
