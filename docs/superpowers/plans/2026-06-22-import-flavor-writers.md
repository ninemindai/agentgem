# Import-into-flavor writers (Codex / Hermes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Import from machine" write into Codex and Hermes testbeds (not just Claude), each in that flavor's on-disk shape, round-tripping through introspect → package.

**Architecture:** Per-flavor write rules go in the `TESTBED_FLAVORS` registry as an `import` block (`skillRel`/`instructionsFile`/`writeMcp?`/`supportsHooks`); the MCP writers (`writeMcpJson`, `writeMcpCodexToml`) live in `testbedFlavors.ts` (NOT `testbed.ts`, which already imports the registry — putting them there would cycle). `importArtifacts` keeps the shared marker/secret machinery and dispatches via the flavor's `import` block; MCP/hooks unsupported by a flavor are skip-and-reported.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), Vitest, Zod. Reuses `parseTomlMcpServers` + `tomlMcpServers` (toml.ts).

## Global Constraints

- ESM: every local import uses a `.js` suffix.
- Tests run via compiled dist: `npm run clean && npx tsc -b && npx vitest run`.
- **No import cycle:** `testbed.ts` imports `testbedFlavors.ts` (for the registry); `testbedFlavors.ts` MUST NOT import `testbed.ts`. The MCP writers + their small JSON helpers live in `testbedFlavors.ts`.
- **Secret invariant:** writers write RAW config into the LOCAL testbed only (`.codex/config.toml`, `.mcp.json`). Packaging re-redacts via `introspectProject` (`serversToArtifacts`). No raw secret reaches a Gem — a codex round-trip test must prove it.
- **Write mapping (verbatim):**
  - claude: skill `.claude/skills/<n>/SKILL.md`, instructions `CLAUDE.md`, MCP `.mcp.json`, hooks `.claude/settings.json`.
  - codex: skill `.agents/skills/<n>/SKILL.md`, instructions `AGENTS.md`, MCP `.codex/config.toml [mcp_servers]` (strip+re-append), hooks N/A (skip+report).
  - hermes: skill `.hermes/skills/<n>/DESCRIPTION.md`, instructions `.hermes/SOUL.md`, MCP N/A (skip+report "Hermes has no MCP-server config"), hooks N/A (skip+report).
- `importSupported` becomes `true` for all three flavors.
- Skip reasons: missing artifact → `"not found in global inventory"`; unsupported MCP → `"<Label> has no MCP-server config"`; unsupported hooks → `"<Label> has no hooks"`.

---

## File Structure

- **Modify** `src/gem/testbedFlavors.ts` — add `FlavorImport` interface + `import` block to each flavor; add `writeMcpJson`, `writeMcpCodexToml`, `stripMcpServerBlocks`, and small JSON helpers; flip `importSupported` to true.
- **Modify** `src/gem/testbed.ts` — `importArtifacts` gains a `flavor` param and dispatches via `TESTBED_FLAVORS[flavor].import`.
- **Modify** `src/schemas.ts` — add `flavor` to `TestbedImportRequestSchema`.
- **Modify** `src/gem.controller.ts` — `/api/testbed/import` passes the flavor.
- **Modify** `src/public/index.html` — `applyImport` sends `flavor`; `FLAVORS` table `importSupported: true` for codex/hermes; remove the `openImport` import-gate.
- **Tests:** `src/gem/__tests__/testbedFlavors.test.ts` (codex toml writer), `src/gem/__tests__/testbed.test.ts` (flavor-aware import + round-trip), `src/__tests__/gem.controller.test.ts` (flavor param).

---

## Task 1: Codex TOML MCP writer (strip + re-append)

**Files:**
- Modify: `src/gem/testbedFlavors.ts`
- Test: `src/gem/__tests__/testbedFlavors.test.ts`

**Interfaces:**
- Consumes: `parseTomlMcpServers`, `tomlMcpServers` (from `./toml.js`); `McpServerArtifact` (from `./types.js`).
- Produces: `export function writeMcpCodexToml(root: string, name: string, rawConfig: Record<string, unknown>): boolean` — writes/merges `.codex/config.toml` `[mcp_servers.<name>]`, preserving non-MCP sections; returns `true` if the server name already existed.

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/testbedFlavors.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { writeMcpCodexToml } from "../testbedFlavors.js";

describe("writeMcpCodexToml", () => {
  it("writes a fresh mcp server into .codex/config.toml", () => {
    expect(writeMcpCodexToml(root, "gh", { command: "npx", env: { GH_TOKEN: "ghp_x" } })).toBe(false);
    const toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.gh]");
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain("[mcp_servers.gh.env]");
    expect(toml).toContain('GH_TOKEN = "ghp_x"');   // raw — local testbed only
  });
  it("merges a second server and PRESERVES a non-mcp section; reports overwritten", () => {
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(join(root, ".codex", "config.toml"), '[model]\nname = "gpt-5"\n\n[mcp_servers.gh]\ncommand = "npx"\n');
    expect(writeMcpCodexToml(root, "exa", { url: "https://mcp.x/sse" })).toBe(false);  // new server
    let toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[model]");                 // non-mcp section preserved
    expect(toml).toContain('name = "gpt-5"');
    expect(toml).toContain("[mcp_servers.gh]");        // existing server kept
    expect(toml).toContain("[mcp_servers.exa]");       // new server added
    expect(writeMcpCodexToml(root, "gh", { command: "node" })).toBe(true);  // overwrite existing
    toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    expect((toml.match(/\[mcp_servers\.gh\]/g) || []).length).toBe(1);  // not duplicated
    expect(toml).toContain('command = "node"');
  });
});
```

(`root` + `mkdirSync`/`writeFileSync`/`join` are already set up at the top of this test file from the flavors task; add the `readFileSync` import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run testbedFlavors`
Expected: FAIL — `writeMcpCodexToml` not exported.

- [ ] **Step 3: Implement**

In `src/gem/testbedFlavors.ts`, add imports at the top:

```ts
import { readFileSync } from "node:fs";
import { parseTomlMcpServers, tomlMcpServers } from "./toml.js";
import type { McpServerArtifact } from "./types.js";
```

Add (after `writeIfAbsent`):

```ts
// Remove every [mcp_servers...] section (header through to the next top-level table or EOF),
// preserving all other content. Lets writeMcpCodexToml regenerate just the MCP block.
function stripMcpServerBlocks(toml: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[/.test(line)) skipping = /^\s*\[mcp_servers(\.|\])/.test(line); // a table header (re)sets the mode
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

export function writeMcpCodexToml(root: string, name: string, rawConfig: Record<string, unknown>): boolean {
  const abs = join(root, ".codex", "config.toml");
  const text = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const servers = parseTomlMcpServers(text);
  const overwritten = name in servers;
  servers[name] = rawConfig;                      // raw config — local testbed only
  const nonMcp = stripMcpServerBlocks(text).trimEnd();
  const arts = Object.entries(servers).map(([n, config]) =>
    ({ type: "mcp_server", name: n, transport: "stdio", config } as McpServerArtifact));
  const block = tomlMcpServers(arts);            // regenerated [mcp_servers...] section
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, (nonMcp ? nonMcp + "\n\n" : "") + block, "utf8");
  return overwritten;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run clean && npx vitest run testbedFlavors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/testbedFlavors.ts src/gem/__tests__/testbedFlavors.test.ts
git commit -m "feat(testbed): writeMcpCodexToml — merge MCP into .codex/config.toml (strip+re-append)"
```

---

## Task 2: Flavor `import` block in the registry

**Files:**
- Modify: `src/gem/testbedFlavors.ts`
- Test: `src/gem/__tests__/testbedFlavors.test.ts`

**Interfaces:**
- Consumes: `writeMcpCodexToml` (Task 1).
- Produces:
  - `interface FlavorImport { skillRel(name: string): string; instructionsFile: string; writeMcp?: (root, name, rawConfig) => boolean; supportsHooks: boolean }`
  - `TestbedFlavor` gains `import: FlavorImport`; `importSupported: true` for all three.
  - `export function writeMcpJson(root, name, rawConfig): boolean` (the `.mcp.json` merge, extracted for claude).

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/testbedFlavors.test.ts`:

```ts
import { TESTBED_FLAVORS as FLV } from "../testbedFlavors.js";

describe("flavor import blocks", () => {
  it("each flavor declares import rules; all importSupported", () => {
    expect(FLV.claude.import.skillRel("x")).toBe(".claude/skills/x/SKILL.md");
    expect(FLV.claude.import.instructionsFile).toBe("CLAUDE.md");
    expect(typeof FLV.claude.import.writeMcp).toBe("function");
    expect(FLV.claude.import.supportsHooks).toBe(true);

    expect(FLV.codex.import.skillRel("x")).toBe(".agents/skills/x/SKILL.md");
    expect(FLV.codex.import.instructionsFile).toBe("AGENTS.md");
    expect(typeof FLV.codex.import.writeMcp).toBe("function");
    expect(FLV.codex.import.supportsHooks).toBe(false);

    expect(FLV.hermes.import.skillRel("x")).toBe(".hermes/skills/x/DESCRIPTION.md");
    expect(FLV.hermes.import.instructionsFile).toBe(".hermes/SOUL.md");
    expect(FLV.hermes.import.writeMcp).toBeUndefined();   // Hermes has no MCP-server config
    expect(FLV.hermes.import.supportsHooks).toBe(false);

    for (const id of ["claude", "codex", "hermes"] as const) expect(FLV[id].importSupported).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run testbedFlavors`
Expected: FAIL — `import` block / `FlavorImport` not present.

- [ ] **Step 3: Implement**

In `src/gem/testbedFlavors.ts`: extend the interface, add `writeMcpJson` + JSON helpers, add the `import` block to each entry, flip `importSupported`.

Add the interface field:

```ts
export interface FlavorImport {
  skillRel(name: string): string;
  instructionsFile: string;
  writeMcp?: (root: string, name: string, rawConfig: Record<string, unknown>) => boolean;
  supportsHooks: boolean;
}
export interface TestbedFlavor {
  id: TestbedFlavorId;
  label: string;
  detect(root: string): boolean;
  scaffold(root: string, name: string): { created: string[] };
  runCommand: string;
  importSupported: boolean;
  import: FlavorImport;
}
```

Add helpers (near `writeMcpCodexToml`):

```ts
function readJsonFile(abs: string): Record<string, unknown> {
  try { const v = JSON.parse(readFileSync(abs, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}
export function writeMcpJson(root: string, name: string, rawConfig: Record<string, unknown>): boolean {
  const abs = join(root, ".mcp.json");
  const doc = readJsonFile(abs);
  const servers = (doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {}) as Record<string, unknown>;
  const overwritten = name in servers;
  servers[name] = rawConfig;                       // raw config — local testbed only
  doc.mcpServers = servers;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return overwritten;
}
```

Add `import` to each registry entry + set `importSupported: true`:

```ts
  // claude entry:
    importSupported: true,
    import: { skillRel: (n) => `.claude/skills/${n}/SKILL.md`, instructionsFile: "CLAUDE.md", writeMcp: writeMcpJson, supportsHooks: true },
  // codex entry:
    importSupported: true,
    import: { skillRel: (n) => `.agents/skills/${n}/SKILL.md`, instructionsFile: "AGENTS.md", writeMcp: writeMcpCodexToml, supportsHooks: false },
  // hermes entry:
    importSupported: true,
    import: { skillRel: (n) => `.hermes/skills/${n}/DESCRIPTION.md`, instructionsFile: ".hermes/SOUL.md", writeMcp: undefined, supportsHooks: false },
```

- [ ] **Step 4: Run test to verify it passes + full suite**

Run: `npm run clean && npx vitest run testbedFlavors` then `npx vitest run`
Expected: PASS (existing flavor tests still pass; importSupported flip doesn't break them).

- [ ] **Step 5: Commit**

```bash
git add src/gem/testbedFlavors.ts src/gem/__tests__/testbedFlavors.test.ts
git commit -m "feat(testbed): per-flavor import block + writeMcpJson; importSupported true for all"
```

---

## Task 3: Flavor-aware `importArtifacts`

**Files:**
- Modify: `src/gem/testbed.ts`
- Test: `src/gem/__tests__/testbed.test.ts`

**Interfaces:**
- Consumes: `TESTBED_FLAVORS`, `TestbedFlavorId` (already imported in testbed.ts); `introspectProject` + `buildGem` (for the round-trip test).
- Produces: `importArtifacts(root, selection, rawInv, flavor: TestbedFlavorId = "claude")` — dispatches writes via `TESTBED_FLAVORS[flavor].import`; MCP/hooks unsupported by a flavor are skip-reported.

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/testbed.test.ts`:

```ts
import { introspectProject } from "../introspect.js";
import { buildGem } from "../buildGem.js";

describe("importArtifacts — flavors", () => {
  const raw = (over = {}) => inv({
    skills: [{ type: "skill", name: "scrape", source: "standalone", content: "# body" }],
    instructions: [{ type: "instructions", name: "CLAUDE.md", content: "RULES" }],
    mcpServers: [{ type: "mcp_server", name: "gh", transport: "stdio", config: { command: "npx", env: { GH_TOKEN: "ghp_realsecret" } }, source: "user" }],
    hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { matcher: "Bash", hooks: [{ type: "command", command: "./g.sh" }] }, source: "user" }],
    ...over,
  });

  it("codex import writes .agents/skills + AGENTS.md + .codex/config.toml MCP; hooks skip-reported", () => {
    scaffoldTestbed(root, "x", "codex");
    const r = importArtifacts(root, { skills: ["scrape"], includeInstructions: true, mcpServers: ["gh"], hooks: ["PreToolUse · Bash"] }, raw(), "codex");
    expect(readFileSync(join(root, ".agents", "skills", "scrape", "SKILL.md"), "utf8")).toContain("# body");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("RULES");
    expect(readFileSync(join(root, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.gh]");
    expect(r.skipped.some((s) => s.artifact === "PreToolUse · Bash" && /no hooks/i.test(s.reason))).toBe(true);
  });

  it("hermes import writes .hermes/skills DESCRIPTION.md + SOUL.md; MCP + hooks skip-reported", () => {
    scaffoldTestbed(root, "x", "hermes");
    const r = importArtifacts(root, { skills: ["scrape"], includeInstructions: true, mcpServers: ["gh"], hooks: ["PreToolUse · Bash"] }, raw(), "hermes");
    expect(readFileSync(join(root, ".hermes", "skills", "scrape", "DESCRIPTION.md"), "utf8")).toContain("# body");
    expect(readFileSync(join(root, ".hermes", "SOUL.md"), "utf8")).toContain("RULES");
    expect(r.skipped.some((s) => s.artifact === "gh" && /no MCP-server config/i.test(s.reason))).toBe(true);
    expect(r.skipped.some((s) => s.artifact === "PreToolUse · Bash" && /no hooks/i.test(s.reason))).toBe(true);
  });

  it("claude import is unchanged (default flavor)", () => {
    scaffoldTestbed(root, "x");
    importArtifacts(root, { skills: ["scrape"], mcpServers: ["gh"], includeInstructions: true, hooks: ["PreToolUse · Bash"] }, raw());
    expect(existsSync(join(root, ".claude", "skills", "scrape", "SKILL.md"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.gh).toBeDefined();
    expect(JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")).hooks.PreToolUse).toHaveLength(1);
  });

  it("CONTAINMENT (codex): raw secret in testbed, redacted in the packaged Gem", () => {
    scaffoldTestbed(root, "x", "codex");
    importArtifacts(root, { mcpServers: ["gh"] }, raw(), "codex");
    const gem = buildGem({ skills: [], mcpServers: [], instructions: [], hooks: [], projects: [introspectProject(root)] },
      { projects: { [root]: { mcpServers: ["gh"] } } }, { name: "g" });
    expect(JSON.stringify(gem)).not.toContain("ghp_realsecret");
    expect(gem.requiredSecrets).toContainEqual({ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run testbed`
Expected: FAIL — `importArtifacts` ignores `flavor` (writes claude shape; no skip reasons).

- [ ] **Step 3: Implement**

In `src/gem/testbed.ts`, rewrite `importArtifacts` to dispatch via the flavor import block. Replace the whole function body:

```ts
export function importArtifacts(root: string, selection: ImportSelection, rawInv: ConfigInventory, flavor: TestbedFlavorId = "claude"): { written: ImportedRef[]; skipped: ImportSkip[] } {
  const written: ImportedRef[] = [];
  const skipped: ImportSkip[] = [];
  const { import: imp, label } = TESTBED_FLAVORS[flavor];

  for (const name of selection.skills ?? []) {
    const sk = rawInv.skills.find((s) => s.name === name);
    if (!sk) { skipped.push({ artifact: name, reason: "not found in global inventory" }); continue; }
    const rel = imp.skillRel(name);
    const overwritten = existsSync(join(root, rel));
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), sk.content, "utf8");
    written.push({ type: "skill", name, overwritten });
  }

  if (selection.includeInstructions) {
    for (const ins of rawInv.instructions) {
      const overwritten = upsertMarkedBlock(root, imp.instructionsFile, ins.name, ins.content);
      written.push({ type: "instructions", name: ins.name, overwritten });
    }
  }

  for (const name of selection.mcpServers ?? []) {
    const m = rawInv.mcpServers.find((s) => s.name === name);
    if (!m) { skipped.push({ artifact: name, reason: "not found in global inventory" }); continue; }
    if (!imp.writeMcp) { skipped.push({ artifact: name, reason: `${label} has no MCP-server config` }); continue; }
    const overwritten = imp.writeMcp(root, name, m.config); // raw config — local testbed only
    written.push({ type: "mcp_server", name, overwritten });
  }

  for (const name of selection.hooks ?? []) {
    const h = rawInv.hooks.find((x) => x.name === name);
    if (!h) { skipped.push({ artifact: name, reason: "not found in global inventory" }); continue; }
    if (!imp.supportsHooks) { skipped.push({ artifact: name, reason: `${label} has no hooks` }); continue; }
    const abs = join(root, ".claude", "settings.json");
    const doc = readJson(abs);
    const hooks = (doc.hooks && typeof doc.hooks === "object" ? doc.hooks : {}) as Record<string, unknown[]>;
    const groups = Array.isArray(hooks[h.event]) ? hooks[h.event] : [];
    const exists = groups.some((g) => JSON.stringify(g) === JSON.stringify(h.config));
    if (!exists) groups.push(h.config);
    hooks[h.event] = groups;
    doc.hooks = hooks;
    writeJson(abs, doc);
    written.push({ type: "hook", name, overwritten: false });
  }

  return { written, skipped };
}
```

(`TESTBED_FLAVORS`/`TestbedFlavorId` are already imported in testbed.ts. `readJson`/`writeJson` remain in testbed.ts for the hooks merge. The old inline `.mcp.json` block is now gone — its logic moved to `writeMcpJson` in the registry. `readJson`/`writeJson` may now be used only by hooks; keep them.)

- [ ] **Step 4: Run tests + full suite**

Run: `npm run clean && npx vitest run testbed` then `npx vitest run`
Expected: PASS — all four new tests + existing testbed/import tests (claude unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/gem/testbed.ts src/gem/__tests__/testbed.test.ts
git commit -m "feat(testbed): flavor-aware importArtifacts (codex/hermes writers; skip-report N/A)"
```

---

## Task 4: Wire flavor through the endpoint + UI

**Files:**
- Modify: `src/schemas.ts`, `src/gem.controller.ts`, `src/public/index.html`
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Consumes: `importArtifacts(..., flavor)` (Task 3); `TestbedFlavorIdSchema` (already in schemas.ts).
- Produces: `/api/testbed/import` accepts `flavor`; UI sends `activeFlavor` and un-gates import for codex/hermes.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/gem.controller.test.ts`:

```ts
it("POST /api/testbed/import flavor=codex writes the codex shape", async () => {
  const tb = mkdtempSync(join(tmpdir(), "cxi-"));
  try {
    await client.post("/api/testbed/scaffold").send({ root: tb, name: "cx", flavor: "codex" }).expect(200);
    const im = await client.post("/api/testbed/import")
      .send({ root: tb, dir, flavor: "codex", selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true } })
      .expect(200);
    expect(im.body.written.some((w: { name: string }) => w.name === "review")).toBe(true);
    expect(existsSync(join(tb, ".agents", "skills", "review", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(tb, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.gh]");
  } finally { rmSync(tb, { recursive: true, force: true }); }
});
```

(The `dir` global fixture has skill `review` + mcp `gh`. Ensure `readFileSync`/`existsSync` are imported in the test file's `node:fs` import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run gem.controller`
Expected: FAIL — import ignores `flavor` (writes claude `.claude/skills`, not `.agents/skills`).

- [ ] **Step 3: Schema + controller**

In `src/schemas.ts`, add `flavor` to the import request (TestbedFlavorIdSchema already exists):

```ts
export const TestbedImportRequestSchema = z.object({
  root: z.string(),
  selection: TestbedImportSelectionSchema,
  dir: z.string().optional(),
  flavor: TestbedFlavorIdSchema.optional(),
});
```

In `src/gem.controller.ts`, in the `importTestbed` method, pass the flavor:

```ts
    return importArtifacts(resolveProject(input.body.root), input.body.selection, rawInv, (input.body.flavor ?? "claude") as TestbedFlavorId);
```

(`TestbedFlavorId` is already imported in the controller from the flavors module; if not, add it.)

- [ ] **Step 4: UI — send flavor + un-gate**

In `src/public/index.html`:
1. In the `FLAVORS` table, set `importSupported: true` for codex and hermes (claude already true).
2. In `applyImport`, include the flavor in the POST body:

```js
  const r = await (await fetch("/api/testbed/import", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ root: activeTestbed, selection, flavor: activeFlavor }) })).json();
```

(With `importSupported` now true for all flavors, the existing gate in `openImport` and the disabled-button logic in `renderTestDrive` become no-ops — the button is enabled for every flavor. Leave that gate code in place; it simply never triggers now.)

- [ ] **Step 5: Run tests + full suite + build + manual verify**

Run: `npm run clean && npx tsc -b && npx vitest run` (expect all pass), then `npm run build`.

Manual smoke:
```bash
PORT=4317 node dist/index.js & sleep 1.3
TB=$(mktemp -d); curl -s -X POST http://127.0.0.1:4317/api/testbed/scaffold -H 'content-type: application/json' -d "{\"root\":\"$TB\",\"name\":\"cx\",\"flavor\":\"codex\"}" >/dev/null
browser-harness <<PY
import time
new_tab("http://127.0.0.1:4317/"); wait_for_load(); time.sleep(1)
js("localStorage.setItem('agentgem.testbed','$TB'); localStorage.setItem('agentgem.testbedFlavor','codex'); location.reload()"); time.sleep(2)
print("import enabled (codex):", js("!document.getElementById('importBtn').disabled"))
PY
kill %1; rm -rf "$TB"
```
Expected: `import enabled (codex): True`.

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/public/index.html src/__tests__/gem.controller.test.ts
git commit -m "feat(testbed): wire flavor through /testbed/import + un-gate import UI"
```

---

## Self-Review

**1. Spec coverage:** registry `import` block → Task 2. Codex MCP strip+re-append → Task 1. Flavor-aware `importArtifacts` (dispatch + skip-report) → Task 3. Hermes MCP/hooks + codex hooks skip-reported → Task 3. `importSupported` true + UI un-gate → Tasks 2, 4. Endpoint flavor → Task 4. Secret containment round-trip → Task 3 (CONTAINMENT test). Per-flavor write mapping → Tasks 2–3. No-import-cycle constraint honored (writers in testbedFlavors.ts) → Tasks 1–2.

**2. Placeholder scan:** No TBD/TODO; every code step is complete. Skip-reason strings are exact.

**3. Type consistency:** `FlavorImport`/`import` block (Task 2) consumed by `importArtifacts` (Task 3) with identical field names (`skillRel`/`instructionsFile`/`writeMcp`/`supportsHooks`). `writeMcpCodexToml`/`writeMcpJson` signatures `(root, name, rawConfig) => boolean` identical across Tasks 1–3. `importArtifacts(root, selection, rawInv, flavor="claude")` consistent between Task 3 and the Task 4 controller call. `flavor` schema field ↔ controller ↔ UI body key all `flavor`.

**Out of scope (carried):** Hermes MCP (no such config — permanent skip+report), Codex hooks (no such concept), Gem/archive/target changes.
