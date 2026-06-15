# agentpack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web UI (on AgentBack) that introspects the coding-agent config (skills, MCP servers, CLAUDE.md) and builds a secret-redacted Pack, exposing `inventory`/`pack` as REST endpoints + MCP tools from one Zod contract.

**Architecture:** Standalone AgentBack hybrid app. `pack-core` (pure TS, ported from `workflow-profiler`) does introspection/build/redaction. A REST controller and an MCP tools class — both delegating to pack-core and sharing zod-v4 wire schemas — expose `GET /api/inventory` + `POST /api/pack`. A static two-pane page (layout B) is served at `/` from `server.expressApp` and is just another client of the API.

**Tech Stack:** AgentBack `@agentback/{core,rest,openapi,rest-explorer,mcp,mcp-http}` (0.2.2), **zod v4**, TypeScript 6 (`experimentalDecorators` + `emitDecoratorMetadata`), pnpm, vitest + supertest. **Build model (AgentBack):** `tsc -b` compiles `src/**` (incl. `src/**/__tests__/*.test.ts`) to `dist/`; vitest runs the compiled `dist/**/__tests__/**/*.test.js`. Run app via `node dist/index.js`. **Not `tsx`.**

**Spec:** `docs/superpowers/specs/2026-06-14-agentpack-design.md`
**pack-core source to port:** `/Users/rfeng/Projects/ninemind/workflow-profiler/src/pack/{types,redact,introspect,buildPack}.ts` and `/Users/rfeng/Projects/ninemind/workflow-profiler/tests/pack/{redact,introspect,buildPack}.test.ts`.

> **TDD loop here:** because tests run from `dist/`, the loop is: write test → `pnpm test` (which does `tsc -b && vitest run`) → see it fail → implement → `pnpm test` → pass. "Run the test" always means `pnpm test` (or `pnpm test:one <file>`).

---

## File Structure

```
agentpack/
  package.json tsconfig.json vitest.config.ts .gitignore
  src/
    pack/                       # ported pack-core (pure TS, no zod)
      types.ts redact.ts introspect.ts buildPack.ts
      __tests__/redact.test.ts introspect.test.ts buildPack.test.ts
    schemas.ts                  # zod v4 wire schemas (Inventory, PackRequest, Pack)
    pack.controller.ts          # @api REST: GET /api/inventory, POST /api/pack
    pack.tools.ts               # @mcpServer MCP tools: inventory, pack
    public/index.html           # two-pane page (vanilla, served at /)
    index.ts                    # app bootstrap: REST + MCP + static page + start
    __tests__/pack.controller.test.ts   # supertest against a started app
```

---

### Task 1: Scaffold the AgentBack project

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (`.gitignore` already exists from `git init`; ensure it lists `node_modules/`, `dist/`, `*.tsbuildinfo`).

- [ ] **Step 1: `package.json`**
```json
{
  "name": "agentpack",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc -b",
    "start": "node dist/index.js",
    "test": "tsc -b && vitest run",
    "test:one": "tsc -b && vitest run",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@agentback/core": "^0.2.2",
    "@agentback/openapi": "^0.2.2",
    "@agentback/rest": "^0.2.2",
    "@agentback/rest-explorer": "^0.2.2",
    "@agentback/mcp": "^0.2.2",
    "@agentback/mcp-http": "^0.2.2",
    "tslib": "^2.8.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^24",
    "@types/supertest": "^6",
    "supertest": "^7",
    "typescript": "^6",
    "vitest": "^3"
  }
}
```

- [ ] **Step 2: `tsconfig.json`** (mirrors AgentBack's base — legacy decorators, nodenext, emit to dist incl. tests)
```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2022"],
    "types": ["node"],
    "strict": true,
    "strictPropertyInitialization": false,
    "useUnknownInCatchVariables": false,
    "noFallthroughCasesInSwitch": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "importHelpers": true,
    "rootDir": "src",
    "outDir": "dist",
    "incremental": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: `vitest.config.ts`** (run the compiled tests under dist, like AgentBack)
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["dist/**/__tests__/**/*.test.js"],
    exclude: ["**/node_modules/**"],
    testTimeout: 15000,
    watch: false,
  },
});
```

- [ ] **Step 4: Install + verify the toolchain**

Run: `pnpm install`
Then: `pnpm build` (expect: no `src` yet → tsc -b succeeds with nothing to emit, or create a placeholder `src/index.ts` with `export {};` so the build has an input — create `src/index.ts` containing `export {};` for now).
Then: `pnpm exec vitest run --passWithNoTests` → exits 0.
If `@agentback/*` fail to resolve from npm, STOP and report (fall back to linking the local agentback workspace).

- [ ] **Step 5: Commit**
```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/index.ts
git commit -m "chore: scaffold agentpack (AgentBack hybrid, zod v4, build+vitest)"
```

---

### Task 2: Port pack-core (introspect / buildPack / redact) + tests

**Files:** Create `src/pack/{types,redact,introspect,buildPack}.ts` and `src/pack/__tests__/{redact,introspect,buildPack}.test.ts`.

- [ ] **Step 1: Copy the four pure source files verbatim** from the profiler:
```bash
mkdir -p src/pack/__tests__
cp /Users/rfeng/Projects/ninemind/workflow-profiler/src/pack/types.ts       src/pack/types.ts
cp /Users/rfeng/Projects/ninemind/workflow-profiler/src/pack/redact.ts      src/pack/redact.ts
cp /Users/rfeng/Projects/ninemind/workflow-profiler/src/pack/introspect.ts  src/pack/introspect.ts
cp /Users/rfeng/Projects/ninemind/workflow-profiler/src/pack/buildPack.ts   src/pack/buildPack.ts
```
These have **no zod dependency** (pure TS), so they compile unchanged under this project's tsconfig.

- [ ] **Step 2: Copy the three test files** and fix their import depth (tests now live in `src/pack/__tests__/`, so `../../src/pack/X` becomes `../X`):
```bash
cp /Users/rfeng/Projects/ninemind/workflow-profiler/tests/pack/redact.test.ts     src/pack/__tests__/redact.test.ts
cp /Users/rfeng/Projects/ninemind/workflow-profiler/tests/pack/introspect.test.ts src/pack/__tests__/introspect.test.ts
cp /Users/rfeng/Projects/ninemind/workflow-profiler/tests/pack/buildPack.test.ts  src/pack/__tests__/buildPack.test.ts
```
Then in each copied test file, replace the import specifier `../../src/pack/` with `../` (e.g. `import { redactMcpConfig } from "../redact";`). Make NO other change to the test bodies.

- [ ] **Step 3: Run the tests** — `pnpm test`
Expected: PASS — the ported redact (5), introspect (3), buildPack (4) tests all green (compiled to `dist/pack/__tests__/` and run there). `pnpm build` is clean.

- [ ] **Step 4: Commit**
```bash
git add src/pack
git commit -m "feat: port pack-core (introspect/buildPack/redact) + tests from workflow-profiler"
```

---

### Task 3: zod-v4 wire schemas

**Files:** Create `src/schemas.ts`. Test: `src/__tests__/schemas.test.ts`.

- [ ] **Step 1: Write the failing test**
```typescript
// src/__tests__/schemas.test.ts
import { describe, it, expect } from "vitest";
import { InventorySchema, PackSchema, PackRequestSchema } from "../schemas.js";

describe("wire schemas", () => {
  it("validates an inventory shape", () => {
    const parsed = InventorySchema.parse({
      skills: [{ type: "skill", name: "review", source: "standalone", content: "x" }],
      mcpServers: [{ type: "mcp_server", name: "gh", transport: "stdio", config: { env: { T: "<redacted>" } } }],
      instructions: [{ type: "instructions", name: "CLAUDE.md", content: "y" }],
    });
    expect(parsed.skills[0].name).toBe("review");
  });

  it("validates a pack-request with an all selection", () => {
    const p = PackRequestSchema.parse({ selection: { all: true }, name: "p" });
    expect("all" in p.selection && p.selection.all).toBe(true);
  });

  it("validates a pack-request with a named selection", () => {
    const p = PackRequestSchema.parse({ selection: { skills: ["review"], includeInstructions: true } });
    expect(p.selection).toMatchObject({ skills: ["review"] });
  });

  it("accepts a Pack", () => {
    const pk = PackSchema.parse({ name: "p", createdFrom: "/d", artifacts: [{ type: "instructions", name: "CLAUDE.md", content: "y" }] });
    expect(pk.artifacts.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it (FAIL — module not found):** `pnpm test`

- [ ] **Step 3: Create `src/schemas.ts`** (zod v4; mirrors `pack/types.ts`)
```typescript
// src/schemas.ts
import { z } from "zod";

export const ToolKindSchema = z.enum(["web_search", "deck", "dataroom"]);

export const SkillArtifactSchema = z.object({
  type: z.literal("skill"),
  name: z.string(),
  description: z.string().optional(),
  source: z.literal("standalone"),
  content: z.string(),
});

export const McpServerArtifactSchema = z.object({
  type: z.literal("mcp_server"),
  name: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  config: z.record(z.string(), z.unknown()),
});

export const InstructionsArtifactSchema = z.object({
  type: z.literal("instructions"),
  name: z.string(),
  content: z.string(),
});

export const PackArtifactSchema = z.discriminatedUnion("type", [
  SkillArtifactSchema,
  McpServerArtifactSchema,
  InstructionsArtifactSchema,
]);

export const InventorySchema = z.object({
  skills: z.array(SkillArtifactSchema),
  mcpServers: z.array(McpServerArtifactSchema),
  instructions: z.array(InstructionsArtifactSchema),
});

export const PackSelectionSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    includeInstructions: z.boolean().optional(),
  }),
]);

export const PackRequestSchema = z.object({
  selection: PackSelectionSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
});

export const DirQuerySchema = z.object({ dir: z.string().optional() });

export const PackSchema = z.object({
  name: z.string(),
  createdFrom: z.string(),
  artifacts: z.array(PackArtifactSchema),
});
```
Note: import is `from "../schemas.js"` in tests (NodeNext requires the `.js` extension on relative imports of TS files). Keep `.js` extensions on all intra-project relative imports.

- [ ] **Step 4: Run test to verify it passes** — `pnpm test` (PASS).

- [ ] **Step 5: Commit**
```bash
git add src/schemas.ts src/__tests__/schemas.test.ts
git commit -m "feat: zod-v4 wire schemas for inventory/pack-request/pack"
```

---

### Task 4: REST controller + supertest

**Files:** Create `src/pack.controller.ts`. Test: `src/__tests__/pack.controller.test.ts`.

- [ ] **Step 1: Write the failing test** (supertest against a started RestApplication, port 0 — the AgentBack integration pattern)
```typescript
// src/__tests__/pack.controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { PackController } from "../pack.controller.js";

let app: RestApplication;
let client: ReturnType<typeof supertest>;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ap-"));
  mkdirSync(join(dir, "skills", "review"), { recursive: true });
  writeFileSync(join(dir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n# Review\n");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ mcpServers: { gh: { command: "npx", env: { GH_TOKEN: "ghp_secret" } } } }));
  writeFileSync(join(dir, "CLAUDE.md"), "global instructions");

  app = new RestApplication({});
  app.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1" });
  app.restController(PackController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});
afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("PackController", () => {
  it("GET /api/inventory returns redacted inventory", async () => {
    const r = await client.get(`/api/inventory?dir=${encodeURIComponent(dir)}`).expect(200);
    expect(r.body.skills.map((s: { name: string }) => s.name)).toEqual(["review"]);
    expect(r.body.mcpServers[0].config.env.GH_TOKEN).toBe("<redacted>");
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret");
  });

  it("POST /api/pack builds a pack from a selection", async () => {
    const r = await client.post("/api/pack")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, name: "demo" })
      .expect(200);
    expect(r.body.name).toBe("demo");
    expect(r.body.artifacts.map((a: { name: string }) => a.name)).toEqual(["review", "CLAUDE.md"]);
  });
});
```

- [ ] **Step 2: Run it (FAIL — module not found):** `pnpm test`

- [ ] **Step 3: Create `src/pack.controller.ts`**
```typescript
// src/pack.controller.ts
import { homedir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { introspectConfig } from "./pack/introspect.js";
import { buildPack } from "./pack/buildPack.js";
import { InventorySchema, PackSchema, PackRequestSchema, DirQuerySchema } from "./schemas.js";

function resolveDir(dir?: string): string {
  return dir && dir.length > 0 ? dir : join(homedir(), ".claude");
}

@api({ basePath: "/api" })
export class PackController {
  @get("/inventory", { query: DirQuerySchema, response: InventorySchema })
  async inventory(input: { query: z.infer<typeof DirQuerySchema> }): Promise<z.infer<typeof InventorySchema>> {
    return introspectConfig(resolveDir(input.query.dir));
  }

  @post("/pack", { body: PackRequestSchema, response: PackSchema })
  async pack(input: { body: z.infer<typeof PackRequestSchema> }): Promise<z.infer<typeof PackSchema>> {
    const dir = resolveDir(input.body.dir);
    const inventory = introspectConfig(dir);
    return buildPack(inventory, input.body.selection, { name: input.body.name ?? "pack", createdFrom: dir });
  }
}
```
If `tsc` complains that `introspectConfig`'s `ConfigInventory` return type isn't assignable to `z.infer<typeof InventorySchema>` (or `buildPack`'s `Pack` vs `PackSchema`), the schema and the pack-core type have drifted — reconcile `src/schemas.ts` to match `src/pack/types.ts` exactly (do NOT loosen the redaction or change pack-core). If AgentBack's `@get` doesn't accept a `query` schema key in 0.2.2, check `examples/hello-hybrid` / `@agentback/openapi` types in the agentback repo and use the supported form (e.g. read the dir from `input.query` if present, else default); keep the `?dir=` behavior.

- [ ] **Step 4: Run test to verify it passes** — `pnpm test` (PASS, incl. the no-`ghp_secret` redaction assertion). `pnpm build` clean.

- [ ] **Step 5: Commit**
```bash
git add src/pack.controller.ts src/__tests__/pack.controller.test.ts
git commit -m "feat: REST controller — GET /api/inventory, POST /api/pack (redacted)"
```

---

### Task 5: MCP tools (same core, agent-native)

**Files:** Create `src/pack.tools.ts`.

> MCP runtime testing needs an MCP client harness; for this task the gate is `tsc` clean + the tools registering. Functional MCP verification happens in the Task 6 smoke (`/mcp` reachable) and is exercised by the operator's agent. The tool handlers are thin delegations to the already-tested pack-core.

- [ ] **Step 1: Create `src/pack.tools.ts`** (mirror `examples/hello-hybrid` `@mcpServer`/`@tool`)
```typescript
// src/pack.tools.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { mcpServer, tool } from "@agentback/mcp";
import { introspectConfig } from "./pack/introspect.js";
import { buildPack } from "./pack/buildPack.js";
import { PackSelectionSchema } from "./schemas.js";

function resolveDir(dir?: string): string {
  return dir && dir.length > 0 ? dir : join(homedir(), ".claude");
}

const InventoryInput = z.object({ dir: z.string().optional() });
const PackInput = z.object({ selection: PackSelectionSchema, name: z.string().optional(), dir: z.string().optional() });

@mcpServer()
export class PackTools {
  @tool("inventory", {
    description: "Introspect the local coding-agent config (skills, MCP servers, CLAUDE.md). Secrets are redacted.",
    input: InventoryInput,
  })
  async inventory(input: z.infer<typeof InventoryInput>) {
    return introspectConfig(resolveDir(input.dir));
  }

  @tool("pack", {
    description: "Build a redacted Pack from a selection of the introspected config artifacts.",
    input: PackInput,
  })
  async pack(input: z.infer<typeof PackInput>) {
    const dir = resolveDir(input.dir);
    return buildPack(introspectConfig(dir), input.selection, { name: input.name ?? "pack", createdFrom: dir });
  }
}
```
If `@tool` in 0.2.2 requires an `output`/`response` schema too, add one referencing `InventorySchema`/`PackSchema` from `./schemas.js` (consult `examples/hello-hybrid` and `@agentback/mcp` types).

- [ ] **Step 2: Verify** — `pnpm build` (tsc clean) and `pnpm test` (still all green; no new test, existing suite unaffected).

- [ ] **Step 3: Commit**
```bash
git add src/pack.tools.ts
git commit -m "feat: MCP tools (inventory, pack) sharing pack-core + schemas"
```

---

### Task 6: Static two-pane page + app bootstrap

**Files:** Create `src/public/index.html`, replace `src/index.ts`.

- [ ] **Step 1: Create `src/public/index.html`** (layout B — vanilla, self-contained, no build)
```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>agentpack — Pack Builder</title>
<style>
  :root{--ink:#221d16;--muted:#6f6555;--line:#ddd3c0;--accent:#9a3324;--paper:#f6f2e9;--card:#fff}
  *{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,sans-serif;color:var(--ink);background:var(--paper)}
  header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center}
  header h1{font-size:16px;margin:0}header .muted{color:var(--muted)}
  main{display:grid;grid-template-columns:1fr 1fr;gap:0;height:calc(100vh - 53px)}
  .pane{padding:16px 20px;overflow:auto}.pane.left{border-right:1px solid var(--line)}
  .group{margin-bottom:18px}.group h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 8px}
  label.row{display:flex;gap:8px;align-items:flex-start;padding:4px 0;cursor:pointer}
  label.row .d{color:var(--muted);font-size:12px}
  .bar{display:flex;gap:8px;align-items:center;margin-bottom:12px}
  input[type=text]{flex:1;padding:6px 8px;border:1px solid var(--line);border-radius:5px;font:inherit}
  button{padding:6px 12px;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:5px;cursor:pointer;font:inherit}
  button.ghost{background:transparent;color:var(--accent)}
  pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word}
  .note{color:var(--muted);font-size:12px;margin-top:8px}
</style>
</head>
<body>
<header><h1>agentpack</h1><span class="muted">Pack Builder · introspecting <code id="dir">~/.claude</code></span></header>
<main>
  <section class="pane left">
    <div class="bar"><input id="name" type="text" placeholder="pack name" value="pack" /><button id="all" class="ghost">Select all</button></div>
    <div id="inventory">Loading…</div>
  </section>
  <section class="pane right">
    <div class="bar"><strong style="flex:1">pack.json (live)</strong><button id="copy" class="ghost">Copy</button><button id="dl">⬇ Download</button></div>
    <pre id="preview">{}</pre>
    <p class="note">MCP secrets are shown as <code>&lt;redacted&gt;</code>. Nothing secret is displayed or exported.</p>
  </section>
</main>
<script>
let inv = { skills: [], mcpServers: [], instructions: [] };
const sel = { skills: new Set(), mcpServers: new Set(), includeInstructions: false };

function group(title, items, kind) {
  if (!items.length && kind !== "instructions") return "";
  const rows = items.map(it => {
    const desc = it.description ? `<span class="d">— ${esc(it.description)}</span>` : (it.transport ? `<span class="d">(${it.transport})</span>` : "");
    return `<label class="row"><input type="checkbox" data-kind="${kind}" data-name="${esc(it.name)}"> <span>${esc(it.name)} ${desc}</span></label>`;
  }).join("");
  return `<div class="group"><h2>${title} (${items.length})</h2>${rows}</div>`;
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}

async function load() {
  inv = await (await fetch("/api/inventory")).json();
  let html = group("Skills", inv.skills, "skills") + group("MCP servers", inv.mcpServers, "mcpServers");
  html += `<div class="group"><h2>Instructions</h2><label class="row"><input type="checkbox" data-kind="instructions"> <span>CLAUDE.md ${inv.instructions.length ? "" : "<span class='d'>(none)</span>"}</span></label></div>`;
  document.getElementById("inventory").innerHTML = html;
  document.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener("change", onToggle));
  refresh();
}
function onToggle(e){
  const { kind, name } = e.target.dataset;
  if (kind === "instructions") sel.includeInstructions = e.target.checked;
  else { e.target.checked ? sel[kind].add(name) : sel[kind].delete(name); }
  refresh();
}
let t; function refresh(){ clearTimeout(t); t = setTimeout(build, 120); }
async function build(){
  const selection = { skills: [...sel.skills], mcpServers: [...sel.mcpServers], includeInstructions: sel.includeInstructions };
  const name = document.getElementById("name").value || "pack";
  const pack = await (await fetch("/api/pack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selection, name }) })).json();
  window.__pack = pack;
  document.getElementById("preview").textContent = JSON.stringify(pack, null, 2);
}
document.getElementById("all").addEventListener("click", () => {
  document.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = true; cb.dispatchEvent(new Event("change")); });
});
document.getElementById("name").addEventListener("input", refresh);
document.getElementById("dl").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(window.__pack || {}, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (document.getElementById("name").value || "pack") + ".json"; a.click();
});
document.getElementById("copy").addEventListener("click", () => navigator.clipboard.writeText(document.getElementById("preview").textContent));
load();
</script>
</body>
</html>
```

- [ ] **Step 2: Replace `src/index.ts`** (bootstrap; serve the page from `server.expressApp`)
```typescript
// src/index.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isMain } from "@agentback/core";
import { RestApplication } from "@agentback/rest";
import { installExplorer } from "@agentback/rest-explorer";
import { MCPComponent } from "@agentback/mcp";
import { installMcpHttp } from "@agentback/mcp-http";
import { PackController } from "./pack.controller.js";
import { PackTools } from "./pack.tools.js";

const here = dirname(fileURLToPath(import.meta.url));
// public/ is copied next to dist at build time (see Step 3); fall back to src.
function pageHtml(): string {
  for (const p of [join(here, "public", "index.html"), join(here, "..", "src", "public", "index.html")]) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  return "<!doctype html><p>index.html not found</p>";
}

export async function createApp(): Promise<RestApplication> {
  const app = new RestApplication({});
  app.component(MCPComponent);
  app.configure("servers.MCPServer").to({ name: "agentpack", version: "0.1.0", transports: { stdio: false } });
  app.restController(PackController);
  app.service(PackTools);
  await installExplorer(app, { title: "agentpack API" });
  await installMcpHttp(app);
  const server = await app.restServer;
  const html = pageHtml();
  server.expressApp.get("/", (_req, res) => res.type("html").send(html));
  return app;
}

async function main() {
  const port = Number(process.env.PORT ?? 4317);
  const app = await createApp();
  app.configure("servers.RestServer").to({ port, host: "127.0.0.1" });
  await app.start();
  const server = await app.restServer;
  console.log(`agentpack listening at ${server.url}`);
  console.log(`  UI:       ${server.url}/`);
  console.log(`  API:      ${server.url}/api/inventory  ·  POST ${server.url}/api/pack`);
  console.log(`  Explorer: ${server.url}/explorer/`);
  console.log(`  MCP:      ${server.url}/mcp`);
}

if (isMain(import.meta)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```
Note: if `app.configure("servers.RestServer")` must be set before `app.restServer` is first resolved, move the `.configure("servers.RestServer")` call to the top of `createApp` (before `await installExplorer`, which resolves the server). Adjust so the server is configured before it is awaited. Verify against `examples/hello-hybrid` ordering (it configures MCP, registers controllers, installs explorer, then starts; the RestServer default port is fine, but we want a fixed port — set it in `createApp` before any `await app.restServer`).

- [ ] **Step 3: Make the page available at runtime** — add a copy step so `public/` sits beside `dist/`. Update `package.json` `build` script:
```json
"build": "tsc -b && mkdir -p dist/public && cp src/public/index.html dist/public/index.html",
```
(Keep `test` as `tsc -b && vitest run`.)

- [ ] **Step 4: Smoke test (build + run + curl)**
```bash
pnpm build
PORT=4317 node dist/index.js &  SERVER=$!
sleep 1
echo "--- page ---"; curl -s localhost:4317/ | grep -o "<title>[^<]*</title>"
echo "--- inventory ---"; curl -s "localhost:4317/api/inventory" | head -c 200; echo
echo "--- pack (all) ---"; curl -s -X POST localhost:4317/api/pack -H 'content-type: application/json' -d '{"selection":{"all":true},"name":"smoke"}' | grep -o '"name":"smoke"'
echo "--- no secret leak in pack ---"; curl -s -X POST localhost:4317/api/pack -H 'content-type: application/json' -d '{"selection":{"all":true}}' | grep -qiE "ghp_|sk-ant|xox" && echo "FAIL leak" || echo "OK no leak"
kill $SERVER
```
Expected: title present; `/api/inventory` returns JSON with `skills`; pack returns `"name":"smoke"`; "OK no leak". Then `pnpm test` (full suite still green) and `pnpm build` clean.

- [ ] **Step 5: Commit**
```bash
git add src/public/index.html src/index.ts package.json
git commit -m "feat: two-pane pack-builder page + AgentBack bootstrap (REST + MCP + static)"
```

---

### Task 7: Acceptance — drive the real UI

- [ ] **Step 1: Run the app on the real `~/.claude`**
```bash
pnpm build && PORT=4317 node dist/index.js
```
Open `http://localhost:4317/`.

- [ ] **Step 2: Verify with the gstack browser** (the operator has gstack). Load `/`, confirm: the left pane lists real skills (72) + any MCP servers + CLAUDE.md; checking a skill updates the right-pane `pack.json` live; the preview shows `<redacted>` for any MCP secret and never a raw secret; "Download" yields a valid `pack.json`. Screenshot before/after a selection.

- [ ] **Step 3: Record the result** — note in the final report whether the UI rendered real inventory, the live preview updated on selection, and no secret appeared. (No commit — uses already-committed code.)

---

## Self-Review (completed during planning)

- **Spec coverage:** AgentBack hybrid app (Tasks 1,4,5,6 — spec §1,§2); pack-core ported (Task 2 — §3); zod-v4 wire schemas (Task 3 — §3); REST `GET /inventory` + `POST /pack` (Task 4 — §4); MCP tools `inventory`/`pack` (Task 5 — §4); two-pane page served statically + bootstrap with `/explorer` + `/mcp` (Task 6 — §4,§5,§8); redaction enforced + asserted over HTTP (Tasks 2,4,6 — §6); tests = ported core + supertest controller + gstack page smoke (Tasks 2,4,7 — §7); run via build+node (Task 6,7 — §8). Publish/dedupe/v2-introspection out (§9).
- **Type consistency:** pack-core `ConfigInventory`/`Pack`/`PackArtifact`/`PackSelection` (Task 2) ↔ `InventorySchema`/`PackSchema`/`PackArtifactSchema`/`PackSelectionSchema` (Task 3); `introspectConfig(dir)→ConfigInventory`, `buildPack(inv, selection, {name,createdFrom})→Pack` used identically in controller (Task 4) and tools (Task 5). Relative imports use `.js` (NodeNext).
- **AgentBack-API risk:** the `@get` `query` key, `@tool` output requirement, and RestServer configure-before-resolve ordering are flagged inline with "consult `examples/hello-hybrid` / package types and use the supported form" + concrete fallbacks — the implementer reads the agentback repo (same machine) to confirm exact 0.2.2 shapes.
- **Out of scope:** publishing Packs to a managed backend; de-duping pack-core with workflow-profiler; plugin-bundled artifacts; auth/hosting.
