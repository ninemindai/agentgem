# Inventory Deferred Bodies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in `?body=defer` to `GET /api/inventory` that replaces artifact bodies with a canonical entity-path `id`, plus `GET /api/artifact/content?id=` to resolve one body on demand — shrinking the payload from 6.13 MB to ~0.16 MB.

**Architecture:** A new `packages/model/src/entityPath.ts` mints and parses `workspace/<collection>/<source>/<name>` ids — the first conformer of the approved entity-address scheme. The controller mints ids and strips bodies; a REST dispatch hook adds `Cache-Control: no-cache` so the existing ETag answers `304`. Curate, Setup, and `mcpHostTools` opt in and lazy-load bodies by id.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod v4, `@agentback/openapi` + `@agentback/rest`, vitest (runs against compiled `dist/`), React 19.

**Spec:** `docs/superpowers/specs/2026-07-09-inventory-defer-body-design.md`

## Global Constraints

- **Worktree:** `/Users/rfeng/Projects/ninemind/agentgem-defer-body`, branch `feat/inventory-defer-body`, based on `origin/main`.
- **Tests run against compiled `dist/`.** Root `vitest.config.ts` includes only `dist/**/__tests__/**/*.test.js`. You MUST run `pnpm exec tsc -b` before `vitest`, and target the **`dist/`** path, not `src/`.
- **CI does not run `packages/*/src/__tests__`.** CI is `pnpm build && pnpm test`; `pnpm test` is `tsc -b && vitest run` over root `dist/` only. Any test that must gate CI goes in root `src/__tests__/`.
- **Console tests are NOT in CI.** Run them explicitly: `pnpm -C packages/console exec vitest run <file>`.
- **ESM import specifiers end in `.js`** even for `.ts` sources (e.g. `import { x } from "./entityPath.js"`).
- **Never loosen `SkillArtifactSchema` / `SubagentArtifactSchema` / `InstructionsArtifactSchema`.** They are members of `GemArtifactSchema` (`src/schemas.ts:111-119`), the gem-archive contract. Task 2 adds *separate* inventory-only variants.
- **Do NOT add `/api/artifact/content` to `PUBLIC_READ_PATHS`** (`src/originGuard.ts:36`). It serves local artifact bodies and must stay same-origin.
- Commit after every task. Never commit directly to `main`.

## Three amendments to the spec, decided while mapping the code

These refine the approved spec. They are load-bearing; do not "fix" them back.

1. **`id` is minted only on `skills`, `subagents`, `instructions`.** The spec said "every artifact gains `id`". But `hook` and `mcp_server` have no `content`, so they have nothing to address, and the entity scheme's workspace collections are exactly these three. Minting paths for body-less types would be speculative surface.

2. **`defer` strips bodies from the GLOBAL lists only; `inventory.projects[]` is untouched.** `introspectAll` fills `projects[]` when `?projects=` is passed (Setup does this). The entity scheme's `workspace/*` addresses **local, gem-less** artifacts and has no project-scoped path. Rather than invent one, project artifacts keep their bodies inline. `ProjectInventorySchema` is unchanged. Setup renders a project artifact from its inline `content` and a global one by lazy-loading its `id`.

3. **Curate's expand button gating changes.** Today it renders only `if (i.detail)` (`Curate/index.tsx:370`). Under `defer` there is no `detail`, so the button would vanish. Gating becomes `i.detail || i.id` — "has a body to load", not "has a body loaded".

## File Structure

| File | Responsibility |
|---|---|
| `packages/model/src/entityPath.ts` *(create)* | Mint + parse `workspace/*` entity paths. Pure, no I/O. |
| `packages/model/src/index.ts` *(modify)* | Re-export `entityPath.js` from the barrel. |
| `src/__tests__/entityPath.test.ts` *(create)* | entityPath tests — in **root** so CI runs them. |
| `src/schemas.ts` *(modify)* | `body` query enum; inventory-only artifact variants with `id` + optional `content`; artifact-content query/response. |
| `src/gem.controller.ts` *(modify)* | Mint ids, strip bodies on `defer`, serve `GET /api/artifact/content`. |
| `src/gemCache.ts` *(create)* | `Cache-Control: no-cache` dispatch hook for the two routes. |
| `src/index.ts` *(modify)* | Bind the hook. |
| `src/__tests__/gem.controller.test.ts` *(modify)* | Server route tests. |
| `src/__tests__/gemCache.test.ts` *(create)* | Header + `satisfies` guard test. |
| `packages/console/src/api/routes.ts` *(modify)* | `body` query, `id` on `ArtifactSchema`, `artifactContentRoute`. |
| `packages/console/src/panels/Curate/data.ts` *(modify)* | `LedgerItem.id`; `detail` from config only. |
| `packages/console/src/panels/Curate/index.tsx` *(modify)* | `Promise.all`, `body=defer`, lazy body on expand. |
| `packages/console/src/panels/Setup/index.tsx` *(modify)* | `body=defer`, lazy body on modal open. |
| `packages/console/src/panels/Play/mcpHostTools.ts` *(modify)* | Pass `body=defer`. |

---

### Task 1: `entityPath.ts` — mint and parse workspace artifact ids

**Files:**
- Create: `packages/model/src/entityPath.ts`
- Modify: `packages/model/src/index.ts`
- Test: `src/__tests__/entityPath.test.ts` (root — CI only runs root `dist/`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `WORKSPACE_COLLECTIONS: readonly ["skills","subagents","instructions"]`
  - `type WorkspaceCollection = "skills" | "subagents" | "instructions"`
  - `workspaceArtifactPath(a: { type: string; name: string; source?: string }): string | null`
  - `parseWorkspaceArtifactPath(id: string): { collection: WorkspaceCollection; source?: string; name: string } | null`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/entityPath.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { workspaceArtifactPath, parseWorkspaceArtifactPath, WORKSPACE_COLLECTIONS } from "@agentgem/model";

describe("workspaceArtifactPath", () => {
  it("mints a four-segment path for a skill", () => {
    expect(workspaceArtifactPath({ type: "skill", name: "agentback", source: "standalone" }))
      .toBe("workspace/skills/standalone/agentback");
  });

  it("percent-encodes a plugin source containing ':' and '@'", () => {
    expect(workspaceArtifactPath({ type: "subagent", name: "code-reviewer", source: "plugin:feature-dev@claude-plugins-official" }))
      .toBe("workspace/subagents/plugin%3Afeature-dev%40claude-plugins-official/code-reviewer");
  });

  // `codex:rules/default.rules` is a REAL instruction name. Unencoded, its '/' splits the path.
  it("mints a three-segment path for a source-less instruction, encoding a '/' in the name", () => {
    expect(workspaceArtifactPath({ type: "instructions", name: "codex:rules/default.rules" }))
      .toBe("workspace/instructions/codex%3Arules%2Fdefault.rules");
  });

  it("returns null for a body-less type (hooks and mcp servers have nothing to address)", () => {
    expect(workspaceArtifactPath({ type: "hook", name: "pre", source: "user" })).toBeNull();
    expect(workspaceArtifactPath({ type: "mcp_server", name: "gh", source: "user" })).toBeNull();
  });

  it("returns null for a skill with no source (a four-segment path needs one)", () => {
    expect(workspaceArtifactPath({ type: "skill", name: "orphan" })).toBeNull();
  });
});

describe("parseWorkspaceArtifactPath", () => {
  it("round-trips every artifact shape", () => {
    const cases = [
      { type: "skill", name: "agentback", source: "standalone" },
      { type: "subagent", name: "code-reviewer", source: "plugin:feature-dev@claude-plugins-official" },
      { type: "instructions", name: "codex:rules/default.rules" },
      { type: "instructions", name: "CLAUDE.md" },
    ];
    for (const a of cases) {
      const id = workspaceArtifactPath(a)!;
      expect(id, `mint failed for ${a.name}`).toBeTruthy();
      const back = parseWorkspaceArtifactPath(id);
      expect(back?.name, `name round-trip for ${id}`).toBe(a.name);
      expect(back?.source).toBe(a.source);
    }
  });

  it("distinguishes two plugins shipping the same bare name", () => {
    const a = workspaceArtifactPath({ type: "skill", name: "review", source: "plugin:alpha@m" })!;
    const b = workspaceArtifactPath({ type: "skill", name: "review", source: "plugin:beta@m" })!;
    expect(a).not.toBe(b);
    expect(parseWorkspaceArtifactPath(a)?.source).toBe("plugin:alpha@m");
    expect(parseWorkspaceArtifactPath(b)?.source).toBe("plugin:beta@m");
  });

  // Returns null, never throws — the route answers 404 for a hand-typed URL, not 500.
  it("returns null for malformed ids instead of throwing", () => {
    expect(parseWorkspaceArtifactPath("")).toBeNull();
    expect(parseWorkspaceArtifactPath("gems/@acme/tetris")).toBeNull();
    expect(parseWorkspaceArtifactPath("workspace/gadgets/a/b")).toBeNull();
    expect(parseWorkspaceArtifactPath("workspace/skills/only-three")).toBeNull();
    expect(parseWorkspaceArtifactPath("workspace/instructions/a/b")).toBeNull();
    expect(parseWorkspaceArtifactPath("workspace/skills/src/%ZZ")).toBeNull(); // bad %-escape
  });

  it("exports the declared collections", () => {
    expect([...WORKSPACE_COLLECTIONS]).toEqual(["skills", "subagents", "instructions"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-defer-body
pnpm install --frozen-lockfile
pnpm exec tsc -b
```

Expected: `tsc -b` FAILS with `error TS2305: Module '"@agentgem/model"' has no exported member 'workspaceArtifactPath'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/model/src/entityPath.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/model/src/entityPath.ts
//
// Canonical entity paths, per docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md
// (on the unmerged `docs/entity-address-scheme` branch). This is that scheme's FIRST conformer and
// deliberately implements only the `workspace/*` collections it needs — other collections get added
// by whoever conforms them next, rather than shipping builders with no caller.
//
// Two deviations from the written scheme, both forced by real data:
//  - A `source` segment. Plugin artifact names are BARE (`code-reviewer` from
//    `plugin:feature-dev@…`), so `workspace/skills/<name>` cannot distinguish two plugins shipping
//    one name. Rule 2 of the scheme — nesting expresses containment — makes a source a container.
//  - Percent-encoded segments. The instruction `codex:rules/default.rules` already contains a '/',
//    which would otherwise split the path.
//
// `instructions` carry no `source` (introspect yields type/name/content only), so their path has
// THREE segments where skills and subagents have four. The parser branches on the collection rather
// than inferring from segment count, and rather than inventing a fake `source: "local"` to keep the
// shape rectangular. This asymmetry is intentional; it is not a bug to be cleaned up.

export const WORKSPACE_COLLECTIONS = ["skills", "subagents", "instructions"] as const;
export type WorkspaceCollection = (typeof WORKSPACE_COLLECTIONS)[number];

/** Artifact `type` -> workspace collection. Body-less types (hook, mcp_server) are absent by design. */
const COLLECTION_OF: Record<string, WorkspaceCollection> = {
  skill: "skills",
  subagent: "subagents",
  instructions: "instructions",
};

/** Canonical id for a local, gem-less artifact. null when the type has no body to address. */
export function workspaceArtifactPath(a: { type: string; name: string; source?: string }): string | null {
  const collection = COLLECTION_OF[a.type];
  if (!collection) return null;
  if (collection === "instructions") return `workspace/instructions/${encodeURIComponent(a.name)}`;
  if (!a.source) return null; // a four-segment path needs a source segment
  return `workspace/${collection}/${encodeURIComponent(a.source)}/${encodeURIComponent(a.name)}`;
}

/** Inverse of workspaceArtifactPath. Returns null — never throws — so a bad id is a 404, not a 500. */
export function parseWorkspaceArtifactPath(
  id: string,
): { collection: WorkspaceCollection; source?: string; name: string } | null {
  const seg = id.split("/");
  if (seg[0] !== "workspace") return null;
  const collection = seg[1] as WorkspaceCollection;
  if (!WORKSPACE_COLLECTIONS.includes(collection)) return null;
  try {
    if (collection === "instructions") {
      if (seg.length !== 3) return null;
      return { collection, name: decodeURIComponent(seg[2]) };
    }
    if (seg.length !== 4) return null;
    return { collection, source: decodeURIComponent(seg[2]), name: decodeURIComponent(seg[3]) };
  } catch {
    return null; // decodeURIComponent throws URIError on a malformed %-escape
  }
}
```

Add to `packages/model/src/index.ts`, after the `export * from "./resolveDir.js";` line:

```ts
export * from "./entityPath.js";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/entityPath.test.js
```

Expected: `Tests 7 passed (7)`.

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/entityPath.ts packages/model/src/index.ts src/__tests__/entityPath.test.ts
git commit -m "feat(model): canonical workspace entity paths

First conformer of the approved entity-address scheme. Adds a source segment
(plugin artifact names are bare) and percent-encodes segments (the instruction
codex:rules/default.rules contains a '/'). instructions have no source, so their
path is three segments; the parser branches on collection rather than guessing."
```

---

### Task 2: Server — `?body=defer`, ids, and `GET /api/artifact/content`

**Files:**
- Modify: `src/schemas.ts:19-60` (add inventory variants), `:479` (`DirQuerySchema`)
- Modify: `src/gem.controller.ts:386-389` (inventory), add `artifactContent` handler
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Consumes: `workspaceArtifactPath`, `parseWorkspaceArtifactPath` from `@agentgem/model` (Task 1).
- Produces:
  - `GET /api/inventory?body=defer|full` (default `full`)
  - `GET /api/artifact/content?id=<entity-path>&dir=<optional>` → `{ id, content }`, 404 on unknown/unparseable
  - Controller method names **`inventory`** and **`artifactContent`** (Task 3 keys a hook on these exact names)

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("GemController", …)` block in `src/__tests__/gem.controller.test.ts`, directly after the `GET /api/inventory returns redacted inventory` test:

```ts
  it("GET /api/inventory mints an entity-path id on body-bearing artifacts", async () => {
    const r = await client.get(`/api/inventory?dir=${encodeURIComponent(dir)}`).expect(200);
    expect(r.body.skills[0].id).toBe("workspace/skills/standalone/review");
    expect(r.body.skills[0].content).toBeTypeOf("string"); // default is body=full
    // Body-less types have nothing to address.
    expect(r.body.mcpServers[0].id).toBeUndefined();
  });

  it("GET /api/inventory?body=defer omits content but keeps the id", async () => {
    const r = await client.get(`/api/inventory?dir=${encodeURIComponent(dir)}&body=defer`).expect(200);
    expect(r.body.skills[0].id).toBe("workspace/skills/standalone/review");
    expect(r.body.skills[0].content).toBeUndefined();
    expect(r.body.skills[0].name).toBe("review"); // metadata survives
    expect(JSON.stringify(r.body)).not.toContain("SKILL-BODY");
  });

  it("GET /api/artifact/content?id= resolves a body by its id", async () => {
    const id = "workspace/skills/standalone/review";
    const r = await client.get(`/api/artifact/content?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent(id)}`).expect(200);
    expect(r.body.id).toBe(id);
    expect(r.body.content).toContain("SKILL-BODY");
  });

  it("GET /api/artifact/content 404s on an unknown or unparseable id", async () => {
    await client.get(`/api/artifact/content?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent("workspace/skills/standalone/nope")}`).expect(404);
    await client.get(`/api/artifact/content?dir=${encodeURIComponent(dir)}&id=${encodeURIComponent("gems/@acme/tetris")}`).expect(404);
  });

  // The gem ARCHIVE contract must stay strict. This is the guard that stops a future
  // refactor from loosening the shared schema to make the inventory variant simpler.
  it("GemArtifactSchema still requires content", async () => {
    const { SkillArtifactSchema } = await import("../schemas.js");
    expect(SkillArtifactSchema.safeParse({ type: "skill", name: "x", source: "standalone" }).success).toBe(false);
  });
```

The fixture skill's body must contain the marker `SKILL-BODY`. Find where the test's `dir` fixture writes `SKILL.md` (search `writeFileSync` near the top of the file) and ensure its content includes `SKILL-BODY`; if it already writes a body, append that marker.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js -t "entity-path id"
```

Expected: FAIL — `expected undefined to be "workspace/skills/standalone/review"`.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `src/schemas.ts`, immediately after `SubagentArtifactSchema` (ends ~line 60), add:

```ts
// Inventory-only artifact variants. `GET /api/inventory` mints an `id` (the canonical entity path)
// and, under ?body=defer, omits `content`. These are SEPARATE schemas on purpose: the base
// SkillArtifactSchema/SubagentArtifactSchema/InstructionsArtifactSchema are members of
// GemArtifactSchema — the gem-archive contract — where `content` must stay required.
export const InventorySkillSchema = SkillArtifactSchema.extend({ id: z.string(), content: z.string().optional() });
export const InventorySubagentSchema = SubagentArtifactSchema.extend({ id: z.string(), content: z.string().optional() });
export const InventoryInstructionsSchema = InstructionsArtifactSchema.extend({ id: z.string(), content: z.string().optional() });
```

**3b.** In `src/schemas.ts`, change `InventorySchema` (~line 168) to use them. `ProjectInventorySchema` is **unchanged** — project artifacts keep inline bodies and get no id (the entity scheme has no project-scoped path):

```ts
export const InventorySchema = z.object({
  skills: z.array(InventorySkillSchema),
  mcpServers: z.array(McpServerArtifactSchema),
  instructions: z.array(InventoryInstructionsSchema),
  hooks: z.array(HookArtifactSchema),
  subagents: z.array(InventorySubagentSchema),
  projects: z.array(ProjectInventorySchema).optional(),
});
```

**3c.** In `src/schemas.ts`, replace `DirQuerySchema` (line 479) and add the content route's schemas beside it:

```ts
export const DirQuerySchema = z.object({
  dir: z.string().optional(),
  projects: z.string().optional(),
  // `defer` omits artifact bodies (97.8% of the payload) and returns only the `id` that addresses
  // them. Opt-in: the default stays `full` so no existing caller changes shape.
  body: z.enum(["full", "defer"]).optional(),
});
export const ArtifactContentQuerySchema = z.object({ id: z.string(), dir: z.string().optional() });
export const ArtifactContentSchema = z.object({ id: z.string(), content: z.string() });
```

**3d.** In `src/gem.controller.ts`, add to the `@agentgem/model` import (the file already imports `resolveDirs` from it — extend that import; if there is no such import line, add one):

```ts
import { workspaceArtifactPath, parseWorkspaceArtifactPath } from "@agentgem/model";
```

Add to the `./schemas.js` import: `ArtifactContentQuerySchema, ArtifactContentSchema`.

**3e.** In `src/gem.controller.ts`, above the `@api({ basePath: "/api" })` line (~378), add the shared helper. Mint and resolve go through the **same** function so they cannot drift:

```ts
// The three body-bearing collections. `hook` and `mcp_server` have no `content`, so they have
// nothing to address and get no id.
const BODY_COLLECTIONS = ["skills", "subagents", "instructions"] as const;

/** Mint an `id` on every body-bearing artifact; drop `content` when deferring. Mutates a fresh
 *  inventory object (introspectAll returns one per call), so there is nothing to clone. */
function decorateInventory(inv: ConfigInventory, defer: boolean): ConfigInventory {
  for (const key of BODY_COLLECTIONS) {
    const arr = inv[key] as { type: string; name: string; source?: string; content?: string; id?: string }[];
    for (const a of arr) {
      const id = workspaceArtifactPath(a);
      if (id) a.id = id;
      if (defer) delete a.content;
    }
  }
  return inv; // inv.projects[] is deliberately untouched: no project-scoped entity path exists yet
}
```

`ConfigInventory` is already imported at `src/gem.controller.ts:243` (`import type { ConfigInventory } from "@agentgem/model";`) — note it comes from `@agentgem/model`, not `@agentgem/capture`. `introspectConfig` (`:218`), `resolveDirs` (`:331`), and `AgentError` (`:7`) are also already imported. Add nothing but the two `entityPath` symbols and the two schema names.

**3f.** Replace the `inventory` handler (`src/gem.controller.ts:386-389`) and add `artifactContent` immediately after it. **Keep the method names `inventory` and `artifactContent`** — Task 3's hook keys on them via `satisfies`:

```ts
  @get("/inventory", { query: DirQuerySchema, response: InventorySchema })
  async inventory(input: { query: z.infer<typeof DirQuerySchema> }): Promise<z.infer<typeof InventorySchema>> {
    const inv = introspectAll(input.query.dir, parseProjectsQuery(input.query.projects));
    return decorateInventory(inv, input.query.body === "defer") as z.infer<typeof InventorySchema>;
  }

  @get("/artifact/content", { query: ArtifactContentQuerySchema, response: ArtifactContentSchema })
  async artifactContent(input: { query: z.infer<typeof ArtifactContentQuerySchema> }): Promise<z.infer<typeof ArtifactContentSchema>> {
    const { id } = input.query;
    const ref = parseWorkspaceArtifactPath(id);
    if (!ref) throw new AgentError(`unknown artifact id: ${id}`, { status: 404, code: "artifact_not_found", retryable: false });
    const inv = introspectConfig(resolveDirs(input.query.dir));
    const arr = inv[ref.collection] as { name: string; source?: string; content?: string }[];
    const hit = arr.find((a) => a.name === ref.name && (ref.source === undefined || a.source === ref.source));
    if (!hit?.content) throw new AgentError(`unknown artifact id: ${id}`, { status: 404, code: "artifact_not_found", retryable: false });
    return { id, content: hit.content };
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gem.controller.test.js
```

Expected: all pass, including the two pre-existing inventory tests (`returns redacted inventory`, `?projects=`).

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(api): ?body=defer on /api/inventory + GET /api/artifact/content

Bodies are 97.8% of the 6.13MB inventory payload and are read only on expand.
defer omits them and returns the canonical entity-path id that addresses them.
Inventory-only schema variants keep GemArtifactSchema's content required."
```

---

### Task 3: `Cache-Control: no-cache` so the existing ETag answers 304

**Files:**
- Create: `src/gemCache.ts`
- Modify: `src/index.ts:163` (beside the `hooks.playNoCache` bind)
- Test: `src/__tests__/gemCache.test.ts`

**Interfaces:**
- Consumes: `GemController` method names `inventory`, `artifactContent` (Task 2).
- Produces: `gemNoCache: RestDispatchHook`, `GEM_NO_CACHE_METHODS`.

**Why a dispatch hook:** `src/playCache.ts` documents it. `@inject(HTTP_RESPONSE)` is Express-coupled and makes one such route fail `start()` under `listener:'native'`; an express middleware matching `req.path` duplicates the route table in a string constant. The hook keys on the matched route (`ctor` + `methodName`), so it cannot drift.

**Why `no-cache`, not `max-age`:** `no-cache` means *revalidate every time*, not *don't store*. Express already emits a weak ETag and answers `If-None-Match` with `304` in 40 ms. `max-age` would serve a stale artifact list after the user installs a skill.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/gemCache.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { gemNoCache, GEM_NO_CACHE_METHODS } from "../gemCache.js";
import { GemController } from "../gem.controller.js";

// `responseHeaders` is a WHATWG `Headers` (see @agentback/rest keys.d.ts:113), not a Map.
function run(ctor: unknown, methodName: string) {
  const headers = new Headers();
  let nexted = false;
  gemNoCache({ ctor, methodName, responseHeaders: headers } as never, () => { nexted = true; return undefined as never; });
  return { headers, nexted };
}

describe("gemNoCache", () => {
  it("sets Cache-Control: no-cache on the inventory + artifact-content reads", () => {
    for (const m of GEM_NO_CACHE_METHODS) {
      expect(run(GemController, m).headers.get("Cache-Control"), m).toBe("no-cache");
    }
  });

  // Headers.get() returns null (not undefined) for an absent header.
  it("leaves other GemController routes alone", () => {
    expect(run(GemController, "usage").headers.get("Cache-Control")).toBeNull();
  });

  it("leaves other controllers alone", () => {
    class Other {}
    expect(run(Other, "inventory").headers.get("Cache-Control")).toBeNull();
  });

  it("always calls next()", () => {
    expect(run(GemController, "inventory").nexted).toBe(true);
    expect(run(GemController, "usage").nexted).toBe(true);
  });

  it("guards both routes", () => {
    expect([...GEM_NO_CACHE_METHODS]).toEqual(["inventory", "artifactContent"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec tsc -b
```

Expected: FAILS with `error TS2307: Cannot find module '../gemCache.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/gemCache.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemCache.ts
// Revalidation guard for the inventory reads, as a REST dispatch hook. Mirrors src/playCache.ts —
// see its header for why a dispatch hook rather than @inject(HTTP_RESPONSE) or an express
// middleware matching on req.path.
//
// These routes serve MUTABLE local state: installing a skill changes the inventory. Express answers
// them with an ETag but no Cache-Control, and a bare validator lets the browser apply *heuristic*
// freshness (RFC 9111 §4.2.2) — serving a cached inventory that omits a just-installed skill.
//
// `no-cache` (revalidate every time), never `no-store` (don't retain at all): the ETag still answers
// 304, so a repeat Curate mount costs a conditional request instead of re-downloading the payload.
import { type RestDispatchHook } from "@agentback/rest";
import { GemController } from "./gem.controller.js";

// `satisfies` makes a handler rename a COMPILE error rather than a silently dropped header.
export const GEM_NO_CACHE_METHODS = ["inventory", "artifactContent"] satisfies (keyof GemController)[];

const NO_CACHE = new Set<string>(GEM_NO_CACHE_METHODS);

export const gemNoCache: RestDispatchHook = (info, next) => {
  if (info.ctor === GemController && NO_CACHE.has(info.methodName)) info.responseHeaders.set("Cache-Control", "no-cache");
  return next();
};
```

In `src/index.ts`, add the import beside the `playNoCache` import, then bind it directly after the `hooks.playNoCache` bind (line 163):

```ts
  // The inventory reads serve mutable local state (installing a skill changes them); without
  // Cache-Control the browser heuristically caches them off the bare ETag. Same rationale and
  // mechanism as hooks.playNoCache above.
  app.bind("hooks.gemNoCache").to(gemNoCache).tag(REST_DISPATCH_HOOK_TAG);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/gemCache.test.js
```

Expected: `Tests 5 passed (5)`.

- [ ] **Step 5: Commit**

```bash
git add src/gemCache.ts src/index.ts src/__tests__/gemCache.test.ts
git commit -m "feat(api): Cache-Control: no-cache on the inventory reads

Express already emits a weak ETag and answers If-None-Match with 304. Without
Cache-Control the browser heuristically caches, serving an inventory that omits
a just-installed skill. no-cache = revalidate every time, not don't-store."
```

---

### Task 4: Client route + Curate parallel fetch and lazy bodies

**Files:**
- Modify: `packages/console/src/api/routes.ts:7-13` (`ArtifactSchema`), `:41-44` (`inventoryRoute`)
- Modify: `packages/console/src/panels/Curate/data.ts:39-45`
- Modify: `packages/console/src/panels/Curate/index.tsx:129-145`, `:370`, `:386-390`
- Test: `packages/console/src/panels/Curate/Curate.test.tsx`, `packages/console/src/panels/Curate/data.test.ts`

**Interfaces:**
- Consumes: `GET /api/inventory?body=defer`, `GET /api/artifact/content?id=` (Task 2).
- Produces: `artifactContentRoute`; `LedgerItem.id?: string`.

**Console tests are NOT in CI.** Run them explicitly with `pnpm -C packages/console exec vitest run <file>`.

- [ ] **Step 1: Write the failing test**

In `packages/console/src/panels/Curate/data.test.ts`, add:

```ts
it("carries the artifact id and does not fabricate a detail from a missing body", () => {
  const groups = groupInventory({
    skills: [{ name: "review", id: "workspace/skills/standalone/review", source: "standalone" }],
    mcpServers: [{ name: "gh", config: { cmd: "gh" } }],
    instructions: [], hooks: [], subagents: [],
  } as never);
  const skill = groups.find((g) => g.key === "skills")!.items[0];
  expect(skill.id).toBe("workspace/skills/standalone/review");
  expect(skill.detail).toBeUndefined();              // deferred — nothing inline yet
  const mcp = groups.find((g) => g.key === "mcpServers")!.items[0];
  expect(mcp.detail).toContain("gh");                // config still renders inline
  expect(mcp.id).toBeUndefined();
});
```

In `packages/console/src/panels/Curate/Curate.test.tsx`, add (match the file's existing mock style for `../../api/routes.js`):

```tsx
it("lazily fetches a deferred body on expand, once", async () => {
  const calls: string[] = [];
  artifactContentRoute.call = vi.fn(async (_c: unknown, i: { query: { id: string } }) => {
    calls.push(i.query.id);
    return { id: i.query.id, content: "LAZY-BODY" };
  }) as never;

  render(<Curate apiBase="" />);
  const view = await screen.findByLabelText("view");   // button renders from `id`, with no body loaded
  fireEvent.click(view);
  expect(await screen.findByText(/LAZY-BODY/)).toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("hide"));
  fireEvent.click(screen.getByLabelText("view"));      // re-expand
  await screen.findByText(/LAZY-BODY/);
  expect(calls).toEqual(["workspace/skills/standalone/review"]);  // memoized: fetched exactly once
});
```

Ensure the file's `inventoryRoute.call` mock returns a skill with `id: "workspace/skills/standalone/review"` and **no** `content`.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -C packages/console exec vitest run src/panels/Curate/data.test.ts src/panels/Curate/Curate.test.tsx
```

Expected: FAIL — `artifactContentRoute` is not exported; `skill.id` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

**3a.** `packages/console/src/api/routes.ts` — add `id` to `ArtifactSchema` (after the `content` line) and the `body` query, then the new route after `inventoryRoute`:

```ts
const ArtifactSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  id: z.string().optional(),        // canonical entity path; present on skills/subagents/instructions
  content: z.string().optional(),   // absent under ?body=defer — fetch it with artifactContentRoute
  config: z.record(z.string(), z.unknown()).optional(),
  source: z.string().optional(), // "standalone", a plugin name, "user"/"project", …
});
```

```ts
export const inventoryRoute = defineRoute("GET", "/api/inventory", {
  query: z.object({
    dir: z.string().optional(),
    projects: z.string().optional(),
    body: z.enum(["full", "defer"]).optional(),
  }),
  response: InventorySchema,
});

// Resolve one deferred artifact body by its canonical entity path id.
export const artifactContentRoute = defineRoute("GET", "/api/artifact/content", {
  query: z.object({ id: z.string() }),
  response: z.object({ id: z.string(), content: z.string() }),
});
```

**3b.** `packages/console/src/panels/Curate/data.ts` — add `id` to `LedgerItem` and stop deriving `detail` from a body that may not be there:

```ts
export interface LedgerItem { name: string; invocations: number; lastUsedMs: number | null; detail?: string; source?: string; id?: string }
```

```ts
      items: (inv[key] ?? []).map((a) => ({
        name: a.name,
        invocations: 0,
        lastUsedMs: null,
        // `content` is present only under ?body=full. Under defer, `id` addresses the body and the
        // panel fetches it on expand. Config-bearing types (mcp/hooks) have no id and render inline.
        detail: a.content ?? (a.config ? JSON.stringify(a.config, null, 2) : undefined),
        source: a.source,
        id: a.id,
      })),
```

**3c.** `packages/console/src/panels/Curate/index.tsx` — the mount effect (lines 129-145). Fetch in parallel and defer bodies:

```tsx
  useEffect(() => {
    let alive = true;
    const client = makeClient(apiBase);
    (async () => {
      try {
        // Parallel, not serial: first paint used to wait for usage too. `body=defer` drops the
        // artifact bodies (97.8% of the payload); a body is fetched on expand.
        const [inv, usage] = await Promise.all([
          inventoryRoute.call(client, { query: { body: "defer" } }),
          usageRoute.call(client, { query: { scope: "global" } }).catch(() => ({ artifacts: [] }) as Usage),
        ]);
        if (alive) setGroups(mergeUsage(groupInventory(inv), usage));
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [apiBase]);
```

Add body state and a loader beside the other `useState` hooks:

```tsx
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [bodyError, setBodyError] = useState<Record<string, string>>({});

  // Memoized by id: re-expanding a row must not re-fetch.
  const loadBody = async (id: string) => {
    if (bodies[id] !== undefined) return;
    try {
      const r = await artifactContentRoute.call(makeClient(apiBase), { query: { id } });
      setBodies((b) => ({ ...b, [id]: r.content }));
    } catch (e) {
      setBodyError((b) => ({ ...b, [id]: e instanceof Error ? e.message : String(e) }));
    }
  };
```

Change `toggleExpand` so expanding a row with an `id` kicks off the load. Find its definition and make it accept the item's id:

```tsx
  const toggleExpand = (key: string, id?: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else { next.add(key); if (id) void loadBody(id); }
      return next;
    });
  };
```

The button gate (line 370) and the render (386-390) become:

```tsx
                    {(i.detail || i.id) && (
                      <button type="button" className="ledger-view" aria-label={isExpanded ? "hide" : "view"} onClick={() => toggleExpand(key, i.id)}>
```

```tsx
                  {isExpanded && (() => {
                    const body = i.detail ?? (i.id ? bodies[i.id] : undefined);
                    const err = i.id ? bodyError[i.id] : undefined;
                    if (err) return <pre className="ledger-detail">Failed to load: {err}</pre>;
                    if (body === undefined) return <pre className="ledger-detail">Loading…</pre>;
                    return g.key === "skills" || g.key === "subagents" || g.key === "instructions"
                      ? <ContentView text={body} />
                      : <pre className="ledger-detail">{body}</pre>;
                  })()}
```

Add `artifactContentRoute` to the existing `../../api/routes.js` import at `index.tsx:3`. The `Usage` type is **already** imported there — do not add it twice.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -C packages/console exec vitest run src/panels/Curate/
```

Expected: all Curate tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Curate/
git commit -m "feat(console): Curate fetches inventory in parallel with deferred bodies

Promise.all replaces the serial inventory->usage await, and ?body=defer drops
5.81MB of artifact bodies. A body loads on expand, memoized by id. The expand
button now gates on 'has a body to load' (detail || id), not 'body loaded'."
```

---

### Task 5: Setup panel — lazy body on modal open

**Files:**
- Modify: `packages/console/src/panels/Setup/index.tsx:75` (fetch), `:296-301` (modal body)
- Test: `packages/console/src/panels/Setup/Setup.test.tsx`

**Interfaces:**
- Consumes: `artifactContentRoute` (Task 4); `Artifact.id` (Task 4).

**Note:** Setup passes `?projects=[root]`, and project artifacts keep inline `content` (they have no entity path). So the modal must render `a.content` when present and fall back to fetching `a.id` — both paths are live here.

- [ ] **Step 1: Write the failing test**

In `packages/console/src/panels/Setup/Setup.test.tsx`, add:

```tsx
it("lazily loads a deferred global artifact body when the modal opens", async () => {
  artifactContentRoute.call = vi.fn(async () => ({ id: "workspace/skills/standalone/review", content: "LAZY-SETUP-BODY" })) as never;
  render(<Setup apiBase="" scope={{ kind: "global" }} />);
  fireEvent.click(await screen.findByText("review"));
  expect(await screen.findByText(/LAZY-SETUP-BODY/)).toBeInTheDocument();
});

it("renders a project artifact's inline body without fetching (it has no id)", async () => {
  const spy = vi.fn();
  artifactContentRoute.call = spy as never;
  render(<Setup apiBase="" scope={{ kind: "project", root: "/p" }} />);
  fireEvent.click(await screen.findByText("proj-skill"));
  expect(await screen.findByText(/PROJECT-BODY/)).toBeInTheDocument();
  expect(spy).not.toHaveBeenCalled();
});
```

Update the file's `inventoryRoute.call` mock: the global `review` skill carries `id` and **no** `content`; the project inventory's `proj-skill` carries `content: "PROJECT-BODY"` and **no** `id`.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -C packages/console exec vitest run src/panels/Setup/Setup.test.tsx
```

Expected: FAIL — modal renders `(no file body for this artifact)` instead of `LAZY-SETUP-BODY`.

- [ ] **Step 3: Write minimal implementation**

In the mount effect (line 75), request deferred bodies:

```tsx
    inventoryRoute.call(makeClient(apiBase), { query: root ? { projects: JSON.stringify([root]), body: "defer" } : { body: "defer" } })
```

In the artifact modal component, add lazy loading and use it in the body:

```tsx
  const [lazyBody, setLazyBody] = useState<string | null>(null);
  const [lazyErr, setLazyErr] = useState<string | null>(null);
  useEffect(() => {
    // A project artifact ships its body inline (no entity path exists for project scope).
    if (a.content !== undefined || !a.id) return;
    let alive = true;
    artifactContentRoute.call(makeClient(apiBase), { query: { id: a.id } })
      .then((r) => { if (alive) setLazyBody(r.content); })
      .catch((e: unknown) => { if (alive) setLazyErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [apiBase, a.id, a.content]);
```

Replace the modal body (lines 296-301):

```tsx
        <div className="setup-modal-body">
          {/* Skills/subagents/instructions ship markdown content; MCP/hooks show their config. */}
          {(() => {
            const body = a.content ?? lazyBody ?? undefined;
            if (lazyErr) return <pre className="setup-config">Failed to load: {lazyErr}</pre>;
            if (body !== undefined) return <ContentView text={body} />;
            if (a.id) return <pre className="setup-config">Loading…</pre>;
            return <pre className="setup-config">{a.config ? JSON.stringify(a.config, null, 2) : "(no file body for this artifact)"}</pre>;
          })()}
        </div>
```

The modal must receive `apiBase`; thread it from `Setup` if it does not already have it.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -C packages/console exec vitest run src/panels/Setup/
```

Expected: all Setup tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Setup/
git commit -m "feat(console): Setup lazily loads artifact bodies on modal open

Global artifacts arrive deferred and load by id; project artifacts keep inline
bodies (the entity scheme has no project-scoped path) and never fetch."
```

---

### Task 6: `mcpHostTools.getInventory` stops shipping bodies to miniapps

**Files:**
- Modify: `packages/console/src/panels/Play/mcpHostTools.ts:56-58`
- Test: `packages/console/src/panels/Play/__tests__/mcpHostTools.test.ts`

**Interfaces:**
- Consumes: `GET /api/inventory?body=defer` (Task 2).

**Why safe:** the `local-project-access` capability is documented as *"Get the viewer's local inventory (skills, MCP servers, projects)."* Bodies were never part of it. Both installed miniapps that call `agentgem_get_inventory` (`agentgem`, `setup-explorer`) were checked: neither reads `.content`. No `agentgem_get_artifact_content` host tool is added — a miniapp cannot fetch the console API from its sealed null-origin iframe anyway, and no consumer needs one.

- [ ] **Step 1: Write the failing test**

In `packages/console/src/panels/Play/__tests__/mcpHostTools.test.ts`, add:

```ts
it("getInventory requests deferred bodies (miniapps get metadata, not 5.81MB of SKILL.md)", async () => {
  const spy = vi.fn(async () => ({ skills: [], mcpServers: [], instructions: [], hooks: [], subagents: [] }));
  inventoryRoute.call = spy as never;
  await getInventory("http://x");
  expect(spy).toHaveBeenCalledWith(expect.anything(), { query: { body: "defer" } });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -C packages/console exec vitest run src/panels/Play/__tests__/mcpHostTools.test.ts
```

Expected: FAIL — called with `{ query: {} }`.

- [ ] **Step 3: Write minimal implementation**

```ts
// getInventory: Runner.serve()'s "local-project-access" cap. Deferred: the capability is "get the
// viewer's local inventory", never every artifact's SKILL.md — which was 97.8% of the payload,
// forwarded opaquely into a sealed iframe. No miniapp reads `.content`.
export async function getInventory(apiBase: string): Promise<unknown> {
  return inventoryRoute.call(makeClient(apiBase), { query: { body: "defer" } });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm -C packages/console exec vitest run src/panels/Play/
```

Expected: all Play tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/
git commit -m "feat(console): miniapps receive inventory metadata, not artifact bodies"
```

---

### Task 7: Verify by measurement, then amend the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-07-09-inventory-defer-body-design.md`

Tests prove shape; they do not prove the payload shrank. Measure it, the way the warm-pass work was measured.

- [ ] **Step 1: Full build + full suite**

```bash
pnpm clean && pnpm build && pnpm exec vitest run 2>&1 | tail -8
pnpm -C packages/console exec vitest run 2>&1 | tail -8
```

Expected: root suite green (`consoleMount.test.js` needs `pnpm build`, not just `tsc -b`). Console suite green.

- [ ] **Step 2: Measure the payload, both modes, against the real home**

```bash
PORT=7801 node dist/index.js > /tmp/defer.log 2>&1 &
until curl -s -o /dev/null http://127.0.0.1:7801/api/rubrics; do sleep 0.3; done
sleep 25   # let the boot warm pass finish so it does not skew the numbers

echo "full :  $(curl -s 'http://127.0.0.1:7801/api/inventory' | wc -c) bytes"
echo "defer:  $(curl -s 'http://127.0.0.1:7801/api/inventory?body=defer' | wc -c) bytes"

curl -s -o /dev/null -D - 'http://127.0.0.1:7801/api/inventory?body=defer' | grep -i 'cache-control\|etag'
ET=$(curl -s -o /dev/null -D - 'http://127.0.0.1:7801/api/inventory?body=defer' | grep -i '^etag:' | sed 's/[Ee][Tt]ag: //' | tr -d '\r')
curl -s -o /dev/null -w '  revalidate -> HTTP %{http_code}, %{size_download} bytes\n' -H "If-None-Match: $ET" 'http://127.0.0.1:7801/api/inventory?body=defer'

ID=$(curl -s 'http://127.0.0.1:7801/api/inventory?body=defer' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).skills[0].id))')
echo "  first id: $ID"
curl -s -o /dev/null -w "  body-by-id -> HTTP %{http_code}, %{size_download} bytes, %{time_total}s\n" "http://127.0.0.1:7801/api/artifact/content?id=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$ID")"
curl -s -o /dev/null -w "  bad id     -> HTTP %{http_code}\n" 'http://127.0.0.1:7801/api/artifact/content?id=gems%2F%40acme%2Ftetris'
pkill -f "dist/index.js"
```

Expected: `full` ≈ 6,182,093 bytes; `defer` ≈ 160,000 bytes; `Cache-Control: no-cache` present; revalidate → `304, 0 bytes`; body-by-id → `200`; bad id → `404`.

- [ ] **Step 3: Record the measured numbers in the spec**

Replace the *Verification* table in `docs/superpowers/specs/2026-07-09-inventory-defer-body-design.md` with the actual measured `before`/`after` byte counts. If `defer` is materially larger than ~0.16 MB, stop and investigate before claiming the win — do not round a bad number into a good one.

- [ ] **Step 4: Record the three spec amendments**

Add to the spec's *Non-goals* / *Components* sections the three decisions from this plan's "Three amendments" heading: id only on body-bearing collections; `projects[]` keeps inline bodies; Curate's button gates on `detail || id`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-09-inventory-defer-body-design.md
git commit -m "docs: record measured payload + the three spec amendments"
```

---

## Self-Review

**Spec coverage.** Problem (bodies are 97.8% of payload) → Tasks 2, 4, 5, 6. The address / entity-path scheme → Task 1. `?body=defer` → Task 2. `GET /api/artifact/content` → Task 2. `Cache-Control` → Task 3. Client migrations (Curate, Setup, mcpHostTools) → Tasks 4, 5, 6. Error handling (404 not 500, `null` not throw, inline row error) → Tasks 1, 2, 4, 5. Testing (entityPath round-trip, defer/full, 404, `GemArtifactSchema` regression guard, client memoization) → Tasks 1, 2, 4. Verification by measurement → Task 7. Accepted costs → unchanged, no task needed.

**Gap found and closed:** the spec said "every inventory artifact gains `id`" and did not mention `inventory.projects[]`, which Setup requests. Both are resolved in "Three amendments" and folded into Tasks 2 and 5, and Task 7 Step 4 writes them back into the spec.

**Type consistency.** `workspaceArtifactPath` / `parseWorkspaceArtifactPath` — identical names in Tasks 1, 2. Controller methods `inventory` / `artifactContent` — defined in Task 2, keyed by `satisfies (keyof GemController)[]` in Task 3. `artifactContentRoute` query `{ id }` and response `{ id, content }` — server (Task 2) and client (Task 4) agree. `LedgerItem.id?: string` — produced in Task 4's `data.ts`, consumed in Task 4's `index.tsx`. `Artifact.id?: string` — added in Task 4's `routes.ts`, consumed in Tasks 4 and 5.

**No placeholders.** Every code step carries real code; every run step carries a real command and its expected output.
