# Testbed Flavors (Claude / Codex / Hermes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a testbed be authored + test-driven as Claude (existing), Codex, or Hermes — detect-else-ask flavor selection, flavor-correct introspection/scaffold, and the right test-drive launch command — while the neutral Gem and all downstream targets stay unchanged.

**Architecture:** Introspection stays *flavor-agnostic*: extend `introspectProject` to also read the Codex/Hermes project shapes, so inventory + packaging work for any flavor with no flavor-threading. A new `TESTBED_FLAVORS` registry (peer of `TARGET_REGISTRY`) drives the genuinely flavor-specific bits — `detect`, `scaffold`, `runCommand`, `importSupported`. The UI detects the flavor (else asks), persists it, and uses it for the test-drive command + import gating.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), Vitest, Zod, `@agentback` REST. Plain HTML/JS UI (`src/public/index.html`).

## Global Constraints

- ESM: every local import uses a `.js` suffix.
- Tests run via compiled dist: `npm run clean && npx tsc -b && npx vitest run`.
- **Secret invariant:** MCP configs read from any project shape must be redacted via the existing `serversToArtifacts` (never emit raw secret values). New readers return raw config; redaction happens in `introspectProject` as it already does.
- **Confirmed flavor conventions (verbatim):**
  - **Claude** (existing): `.claude/skills/<n>/SKILL.md`, `.mcp.json`, `.claude/settings.json` hooks, `CLAUDE.md`; run `claude`.
  - **Codex:** skills `.agents/skills/<n>/SKILL.md`; MCP project `.codex/config.toml` `[mcp_servers]`; instructions `AGENTS.md`; run `codex`.
  - **Hermes:** project dir `.hermes/`; skills `.hermes/skills/<n>/DESCRIPTION.md` (flat); instructions `.hermes/SOUL.md`; run `hermes`. **Hermes project MCP (`.hermes/config.yaml`) is DEFERRED** (needs a YAML reader + secret-safety review) — out of scope, see §Out of scope.
- Introspection reads the **union** of project shapes present (a claude testbed has no `.codex/config.toml`, so nothing extra is read, etc.). The flavor never needs to be passed to introspect/packaging.
- Detect-else-ask: `detectFlavor(root)` returns a single flavor when unambiguous, else `null` (UI asks). Selection persists in `localStorage["agentgem.testbedFlavor"]`.
- Follow existing patterns: `readSkillsDir`/`serversToArtifacts` in `introspect.ts`; the `TARGET_REGISTRY` shape; the testbed controller endpoints.

---

## File Structure

- **Modify** `src/gem/toml.ts` — add `parseTomlMcpServers` (read the `[mcp_servers.*]` subset the existing `tomlMcpServers` writes).
- **Modify** `src/gem/introspect.ts` — `introspectProject` also reads Codex MCP (`.codex/config.toml`), Codex skills are already covered by the existing `.agents/skills` read, Hermes skills (`.hermes/skills`, DESCRIPTION.md), and `.hermes/SOUL.md`.
- **Create** `src/gem/testbedFlavors.ts` — `TESTBED_FLAVORS` registry, `TestbedFlavorId`, `detectFlavor`, flavor-aware `scaffoldTestbed`.
- **Modify** `src/gem/testbed.ts` — `scaffoldTestbed` delegates to the flavor registry (claude unchanged).
- **Modify** `src/schemas.ts` — `TestbedFlavorIdSchema`, scaffold-request `flavor`, detect response.
- **Modify** `src/gem.controller.ts` — `GET /api/testbed/detect`, scaffold gains `flavor`.
- **Modify** `src/public/index.html` — detect-else-ask create flow, persist flavor, chip shows flavor, test-drive command from flavor, import gating.
- **Tests:** `src/gem/__tests__/toml.test.ts` (or existing), `introspect` tests, `testbedFlavors` tests, controller tests.

---

## Task 1: TOML reader for `[mcp_servers]`

**Files:**
- Modify: `src/gem/toml.ts`
- Test: `src/gem/__tests__/toml.test.ts` (create if absent)

**Interfaces:**
- Produces: `parseTomlMcpServers(toml: string): Record<string, Record<string, unknown>>` — inverse of `tomlMcpServers`; returns `{ <serverName>: <config> }`. Handles scalar values, scalar arrays, and one level of sub-tables (`[mcp_servers.<n>.env]`).

- [ ] **Step 1: Write the failing test**

Create/append `src/gem/__tests__/toml.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { tomlMcpServers, parseTomlMcpServers } from "../toml.js";
import type { McpServerArtifact } from "../types.js";

describe("parseTomlMcpServers", () => {
  it("round-trips the shape tomlMcpServers writes", () => {
    const servers: McpServerArtifact[] = [
      { type: "mcp_server", name: "gh", transport: "stdio", config: { command: "npx", args: ["-y", "gh-mcp"], env: { GH_TOKEN: "x" } } },
      { type: "mcp_server", name: "exa", transport: "http", config: { url: "https://mcp.x/sse" } },
    ];
    const parsed = parseTomlMcpServers(tomlMcpServers(servers));
    expect(parsed.gh).toEqual({ command: "npx", args: ["-y", "gh-mcp"], env: { GH_TOKEN: "x" } });
    expect(parsed.exa).toEqual({ url: "https://mcp.x/sse" });
  });
  it("returns {} for input without an [mcp_servers] table", () => {
    expect(parseTomlMcpServers('[other]\nx = 1\n')).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run toml`
Expected: FAIL — `parseTomlMcpServers` is not exported.

- [ ] **Step 3: Implement the reader**

Append to `src/gem/toml.ts`:

```ts
// Inverse of tomlMcpServers for the [mcp_servers.*] subset only (scalars, scalar arrays, one level of
// sub-tables). Not a general TOML parser. Unknown/other top-level tables are ignored.
function parseScalar(raw: string): unknown {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
function parseArray(raw: string): unknown[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  // split on commas not inside quotes
  const parts: string[] = []; let cur = ""; let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && inner[i - 1] !== "\\") inStr = !inStr;
    if (ch === "," && !inStr) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => parseScalar(p));
}
function unquoteKey(k: string): string {
  const s = k.trim();
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}
export function parseTomlMcpServers(toml: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  let server: string | null = null;
  let sub: string | null = null;     // sub-table key (e.g. "env") within the current server
  for (const rawLine of toml.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (header) {
      // split "name" or "name.sub" on the first dot outside quotes
      const segs = header[1].match(/("(?:[^"\\]|\\.)*"|[^.]+)/g) ?? [];
      const name = unquoteKey(segs[0] ?? "");
      server = name; sub = segs[1] ? unquoteKey(segs[1]) : null;
      out[server] ??= {};
      if (sub) (out[server][sub] ??= {});
      continue;
    }
    if (line.startsWith("[")) { server = null; sub = null; continue; } // some other table
    if (!server) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = unquoteKey(line.slice(0, eq));
    const valRaw = line.slice(eq + 1).trim();
    const val = valRaw.startsWith("[") ? parseArray(valRaw) : parseScalar(valRaw);
    if (sub) (out[server][sub] as Record<string, unknown>)[key] = val;
    else out[server][key] = val;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run clean && npx vitest run toml`
Expected: PASS (round-trip + empty).

- [ ] **Step 5: Commit**

```bash
git add src/gem/toml.ts src/gem/__tests__/toml.test.ts
git commit -m "feat(toml): parseTomlMcpServers — read the [mcp_servers] subset (inverse of the writer)"
```

---

## Task 2: Flavor-agnostic introspection of Codex/Hermes project shapes

**Files:**
- Modify: `src/gem/introspect.ts` (`introspectProject`)
- Test: `src/gem/__tests__/introspectProject.test.ts`

**Interfaces:**
- Consumes: `parseTomlMcpServers` (Task 1); existing `readSkillsDir`, `serversToArtifacts`, `readJson`.
- Produces: `introspectProject(root)` additionally returns — Codex MCP from `.codex/config.toml`, Hermes skills from `.hermes/skills` (DESCRIPTION.md/SKILL.md), and `.hermes/SOUL.md` as instructions. (Codex skills `.agents/skills` are already read today.) Signature unchanged.

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/introspectProject.test.ts`:

```ts
import { writeFileSync as wf, mkdirSync as mk } from "node:fs";

describe("introspectProject — codex/hermes shapes", () => {
  it("reads codex MCP from .codex/config.toml (redacted)", () => {
    const r = mkdtempSync(join(tmpdir(), "cx-"));
    mk(join(r, ".codex"), { recursive: true });
    wf(join(r, ".codex", "config.toml"), '[mcp_servers.gh]\ncommand = "npx"\n\n[mcp_servers.gh.env]\nGH_TOKEN = "ghp_realsecret"\n');
    wf(join(r, "AGENTS.md"), "codex instructions");
    const p = introspectProject(r);
    const gh = p.mcpServers.find((m) => m.name === "gh");
    expect(gh).toBeTruthy();
    expect((gh!.config.env as Record<string, string>).GH_TOKEN).toBe("<redacted>");
    expect(JSON.stringify(p)).not.toContain("ghp_realsecret");
    expect(p.instructions.map((i) => i.name)).toContain("AGENTS.md");
    rmSync(r, { recursive: true, force: true });
  });
  it("reads hermes skills (DESCRIPTION.md) and SOUL.md", () => {
    const r = mkdtempSync(join(tmpdir(), "hm-"));
    mk(join(r, ".hermes", "skills", "weather"), { recursive: true });
    wf(join(r, ".hermes", "skills", "weather", "DESCRIPTION.md"), "---\nname: weather\ndescription: w\n---\nbody");
    wf(join(r, ".hermes", "SOUL.md"), "be kind");
    const p = introspectProject(r);
    expect(p.skills.map((s) => s.name)).toContain("weather");
    expect(p.instructions.map((i) => i.name)).toContain("SOUL.md");
    rmSync(r, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run introspectProject`
Expected: FAIL — codex MCP not read; hermes skills/SOUL.md not read.

- [ ] **Step 3: Extend `introspectProject`**

In `src/gem/introspect.ts`, add an import at the top:

```ts
import { parseTomlMcpServers } from "./toml.js";
```

Inside `introspectProject`, after the existing skill/mcp reads (before the instructions loop), add the new shapes:

```ts
  // Hermes project skills (nested-flat: .hermes/skills/<n>/DESCRIPTION.md|SKILL.md)
  skills.push(...readSkillsDir(join(root, ".hermes", "skills"), "project", ["DESCRIPTION.md", "SKILL.md"]));
  // Codex project MCP (.codex/config.toml [mcp_servers])
  const codexToml = join(root, ".codex", "config.toml");
  if (existsSync(codexToml)) {
    try { mcp.push(...serversToArtifacts(parseTomlMcpServers(readFileSync(codexToml, "utf8")), "project")); }
    catch { /* skip unparseable codex config */ }
  }
```

And extend the instructions loop to include `.hermes/SOUL.md` (its name should be `SOUL.md`):

```ts
  for (const rel of ["CLAUDE.md", "AGENTS.md", join(".hermes", "SOUL.md")]) {
    const p = join(root, rel);
    if (existsSync(p)) {
      try { instructions.push({ type: "instructions", name: basename(rel), content: readFileSync(p, "utf8") }); }
      catch { /* skip unreadable instructions file */ }
    }
  }
```

(Replace the existing `for (const file of ["CLAUDE.md", "AGENTS.md"])` loop with the above; `basename(rel)` keeps the instruction name `SOUL.md` rather than the path.)

- [ ] **Step 4: Run test to verify it passes + regression**

Run: `npm run clean && npx vitest run introspectProject` then `npx vitest run`
Expected: PASS — new codex/hermes tests + the existing claude introspectProject tests unchanged (claude shape still read identically).

- [ ] **Step 5: Commit**

```bash
git add src/gem/introspect.ts src/gem/__tests__/introspectProject.test.ts
git commit -m "feat(introspect): read codex (.codex/config.toml MCP) + hermes (skills, SOUL.md) project shapes"
```

---

## Task 3: TESTBED_FLAVORS registry + detect + flavor-aware scaffold

**Files:**
- Create: `src/gem/testbedFlavors.ts`
- Modify: `src/gem/testbed.ts` (`scaffoldTestbed` delegates to the registry)
- Test: `src/gem/__tests__/testbedFlavors.test.ts`

**Interfaces:**
- Produces:
  - `type TestbedFlavorId = "claude" | "codex" | "hermes"`
  - `interface TestbedFlavor { id; label; detect(root): boolean; scaffold(root, name): { created: string[] }; runCommand: string; importSupported: boolean }`
  - `const TESTBED_FLAVORS: Record<TestbedFlavorId, TestbedFlavor>`
  - `function detectFlavor(root: string): TestbedFlavorId | null` (single match → id; none/multiple → null)
  - `function flavorIds(): TestbedFlavorId[]`
- `scaffoldTestbed(root, name, flavor: TestbedFlavorId = "claude")` dispatches to `TESTBED_FLAVORS[flavor].scaffold`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/testbedFlavors.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TESTBED_FLAVORS, detectFlavor } from "../testbedFlavors.js";
import { scaffoldTestbed } from "../testbed.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fl-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("detectFlavor", () => {
  it("detects claude / codex / hermes by markers; null when ambiguous or none", () => {
    mkdirSync(join(root, "a", ".claude"), { recursive: true });
    expect(detectFlavor(join(root, "a"))).toBe("claude");
    mkdirSync(join(root, "b", ".hermes"), { recursive: true });
    expect(detectFlavor(join(root, "b"))).toBe("hermes");
    writeFileSync(join(root, "c-AGENTS"), ""); mkdirSync(join(root, "c"), { recursive: true }); writeFileSync(join(root, "c", "AGENTS.md"), "x");
    expect(detectFlavor(join(root, "c"))).toBe("codex");
    mkdirSync(join(root, "d", ".claude"), { recursive: true }); mkdirSync(join(root, "d", ".hermes"), { recursive: true });
    expect(detectFlavor(join(root, "d"))).toBeNull();   // ambiguous
    mkdirSync(join(root, "e"), { recursive: true });
    expect(detectFlavor(join(root, "e"))).toBeNull();   // none
  });
});

describe("scaffoldTestbed flavors", () => {
  it("codex scaffold writes AGENTS.md + .agents/skills + .gitignore", () => {
    scaffoldTestbed(root, "agent", "codex");
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills"))).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".codex/config.toml");
    expect(TESTBED_FLAVORS.codex.runCommand).toBe("codex");
    expect(TESTBED_FLAVORS.codex.importSupported).toBe(false);
  });
  it("hermes scaffold writes .hermes/skills + .hermes/SOUL.md", () => {
    scaffoldTestbed(root, "agent", "hermes");
    expect(existsSync(join(root, ".hermes", "skills"))).toBe(true);
    expect(readFileSync(join(root, ".hermes", "SOUL.md"), "utf8")).toContain("agent");
    expect(TESTBED_FLAVORS.hermes.runCommand).toBe("hermes");
  });
  it("claude scaffold is unchanged (still writes .claude + CLAUDE.md)", () => {
    scaffoldTestbed(root, "agent", "claude");
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(true);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# agent\n");
    expect(TESTBED_FLAVORS.claude.importSupported).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run testbedFlavors`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

Create `src/gem/testbedFlavors.ts`:

```ts
// src/gem/testbedFlavors.ts
// The set of harness "flavors" a testbed can be authored/test-driven as. Flavors drive the
// flavor-specific bits — detection, scaffold skeleton, test-drive run command, and import support.
// Introspection is flavor-agnostic (introspectProject reads whatever project config is present).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type TestbedFlavorId = "claude" | "codex" | "hermes";

export interface TestbedFlavor {
  id: TestbedFlavorId;
  label: string;
  detect(root: string): boolean;
  scaffold(root: string, name: string): { created: string[] };
  runCommand: string;
  importSupported: boolean;
}

function writeIfAbsent(root: string, rel: string, content: string, created: string[]): void {
  const abs = join(root, rel);
  if (existsSync(abs)) return;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  created.push(rel);
}

export const TESTBED_FLAVORS: Record<TestbedFlavorId, TestbedFlavor> = {
  claude: {
    id: "claude", label: "Claude Code", runCommand: "claude", importSupported: true,
    detect: (root) => existsSync(join(root, ".claude")) || existsSync(join(root, "CLAUDE.md")),
    scaffold: (root, name) => {
      const created: string[] = [];
      mkdirSync(join(root, ".claude", "skills"), { recursive: true });
      writeIfAbsent(root, ".claude/settings.json", "{}\n", created);
      writeIfAbsent(root, "CLAUDE.md", `# ${name}\n`, created);
      writeIfAbsent(root, ".gitignore", ".mcp.json\n.claude/settings.json\n.env\n.targets/\n", created);
      return { created };
    },
  },
  codex: {
    id: "codex", label: "Codex", runCommand: "codex", importSupported: false,
    detect: (root) => existsSync(join(root, ".codex")) || existsSync(join(root, "AGENTS.md")),
    scaffold: (root, name) => {
      const created: string[] = [];
      mkdirSync(join(root, ".agents", "skills"), { recursive: true });
      writeIfAbsent(root, "AGENTS.md", `# ${name}\n`, created);
      writeIfAbsent(root, ".gitignore", ".codex/config.toml\n.env\n.targets/\n", created);
      return { created };
    },
  },
  hermes: {
    id: "hermes", label: "Hermes", runCommand: "hermes", importSupported: false,
    detect: (root) => existsSync(join(root, ".hermes")),
    scaffold: (root, name) => {
      const created: string[] = [];
      mkdirSync(join(root, ".hermes", "skills"), { recursive: true });
      writeIfAbsent(root, ".hermes/SOUL.md", `# ${name}\n`, created);
      writeIfAbsent(root, ".gitignore", ".hermes/config.yaml\n.env\n.targets/\n", created);
      return { created };
    },
  },
};

export function flavorIds(): TestbedFlavorId[] {
  return Object.keys(TESTBED_FLAVORS) as TestbedFlavorId[];
}

// Single marker match -> that flavor; none or several -> null (caller asks).
export function detectFlavor(root: string): TestbedFlavorId | null {
  const hits = flavorIds().filter((id) => TESTBED_FLAVORS[id].detect(root));
  return hits.length === 1 ? hits[0] : null;
}
```

- [ ] **Step 4: Delegate `scaffoldTestbed` to the registry**

In `src/gem/testbed.ts`, replace the body of `scaffoldTestbed` to dispatch (keep the export + return shape):

```ts
import { TESTBED_FLAVORS, type TestbedFlavorId } from "./testbedFlavors.js";

export function scaffoldTestbed(root: string, name: string, flavor: TestbedFlavorId = "claude"): { root: string; created: string[] } {
  const { created } = TESTBED_FLAVORS[flavor].scaffold(root, name);
  return { root, created };
}
```

(Remove the now-duplicated inline claude skeleton from `testbed.ts`; the claude flavor in the registry is the single source. Keep `writeIfAbsent` in `testbed.ts` only if still used by `importArtifacts`; otherwise it now lives in `testbedFlavors.ts`.)

- [ ] **Step 5: Run tests + full suite**

Run: `npm run clean && npx vitest run testbedFlavors` then `npx vitest run`
Expected: PASS — including the existing testbed scaffold tests (claude behavior identical).

- [ ] **Step 6: Commit**

```bash
git add src/gem/testbedFlavors.ts src/gem/testbed.ts src/gem/__tests__/testbedFlavors.test.ts
git commit -m "feat(testbed): TESTBED_FLAVORS registry + detectFlavor + flavor-aware scaffold"
```

---

## Task 4: Endpoints + schemas

**Files:**
- Modify: `src/schemas.ts`, `src/gem.controller.ts`
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Consumes: `detectFlavor`, `flavorIds`, `scaffoldTestbed` (with flavor).
- Produces:
  - `GET /api/testbed/detect?root=` → `{ flavor: TestbedFlavorId | null }`
  - `POST /api/testbed/scaffold` body gains `flavor?: TestbedFlavorId` (default `"claude"`)

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/gem.controller.test.ts`:

```ts
describe("testbed flavors", () => {
  it("detect returns the flavor for a codex-shaped dir and scaffolds a hermes testbed", async () => {
    const cx = mkdtempSync(join(tmpdir(), "cx-")); mkdirSync(join(cx, ".codex"), { recursive: true });
    try {
      const d = await client.get(`/api/testbed/detect?root=${encodeURIComponent(cx)}`).expect(200);
      expect(d.body.flavor).toBe("codex");
      const hm = mkdtempSync(join(tmpdir(), "hm-"));
      const s = await client.post("/api/testbed/scaffold").send({ root: hm, name: "h", flavor: "hermes" }).expect(200);
      expect(existsSync(join(hm, ".hermes", "SOUL.md"))).toBe(true);
      expect(s.body.created).toContain(".hermes/SOUL.md");
      rmSync(hm, { recursive: true, force: true });
    } finally { rmSync(cx, { recursive: true, force: true }); }
  });
});
```

(Ensure `existsSync` is imported in the test file's `node:fs` import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run gem.controller`
Expected: FAIL — 404 on `/api/testbed/detect`; scaffold ignores `flavor`.

- [ ] **Step 3: Schemas**

Append to `src/schemas.ts`:

```ts
import { flavorIds } from "./gem/testbedFlavors.js";
const FLAVOR_IDS = flavorIds() as [string, ...string[]];
export const TestbedFlavorIdSchema = z.enum(FLAVOR_IDS);
export const TestbedDetectQuerySchema = z.object({ root: z.string() });
export const TestbedDetectResponseSchema = z.object({ flavor: TestbedFlavorIdSchema.nullable() });
```

And add `flavor` to the existing `TestbedScaffoldRequestSchema`:

```ts
export const TestbedScaffoldRequestSchema = z.object({ root: z.string(), name: z.string(), flavor: TestbedFlavorIdSchema.optional() });
```

- [ ] **Step 4: Endpoints**

In `src/gem.controller.ts` add imports (merge into existing blocks):

```ts
import { detectFlavor } from "./gem/testbedFlavors.js";
import type { TestbedFlavorId } from "./gem/testbedFlavors.js";
import { TestbedDetectQuerySchema, TestbedDetectResponseSchema } from "./schemas.js";
```

Update the scaffold method to pass the flavor, and add the detect endpoint:

```ts
  @get("/testbed/detect", { query: TestbedDetectQuerySchema, response: TestbedDetectResponseSchema })
  async testbedDetect(input: { query: z.infer<typeof TestbedDetectQuerySchema> }): Promise<z.infer<typeof TestbedDetectResponseSchema>> {
    return { flavor: detectFlavor(resolveProject(input.query.root)) };
  }
```

In the existing `scaffoldTestbed` controller method, pass the flavor:

```ts
    return scaffoldTestbed(resolveProject(input.body.root), input.body.name, (input.body.flavor ?? "claude") as TestbedFlavorId);
```

- [ ] **Step 5: Run tests + full suite**

Run: `npm run clean && npx vitest run gem.controller` then `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(api): /testbed/detect + scaffold flavor param"
```

---

## Task 5: UI — flavor selection, chip, test-drive command, import gating

**Files:**
- Modify: `src/public/index.html`

**Interfaces:**
- Consumes: `GET /api/testbed/detect`, `POST /api/testbed/scaffold` (with `flavor`), the flavor list (hardcode the 3 ids + labels + runCommand + importSupported in the UI, mirroring the registry — the UI has no import path to the backend module).

- [ ] **Step 1: Add flavor state + a small UI flavor table**

In the `<script>`, near the testbed state (after `let activeTestbed = …`), add:

```js
const FLAVORS = {
  claude: { label: "Claude Code", run: "claude", importSupported: true },
  codex:  { label: "Codex",       run: "codex",  importSupported: false },
  hermes: { label: "Hermes",      run: "hermes", importSupported: false },
};
let activeFlavor = localStorage.getItem("agentgem.testbedFlavor") || "claude";
function setFlavor(id){ activeFlavor = (id in FLAVORS) ? id : "claude"; localStorage.setItem("agentgem.testbedFlavor", activeFlavor); }
```

- [ ] **Step 2: Detect-else-ask in `openOrCreateTestbed` + persist**

Replace `openOrCreateTestbed` so it detects the flavor (else prompts) and passes it to scaffold:

```js
async function openOrCreateTestbed(){
  const pick = await (await fetch("/api/pick-folder")).json();
  if(!pick.path) return;
  let flavor = (await (await fetch(`/api/testbed/detect?root=${encodeURIComponent(pick.path)}`)).json()).flavor;
  if(!flavor){
    const choice = (prompt("Harness flavor for this testbed — claude / codex / hermes", "claude") || "claude").trim().toLowerCase();
    flavor = (choice in FLAVORS) ? choice : "claude";
  }
  setFlavor(flavor);
  const name = prompt("Testbed agent name", pick.path.replace(/^.*\//, "")) || pick.path.replace(/^.*\//, "");
  await fetch("/api/testbed/scaffold", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ root: pick.path, name, flavor }) });
  setTestbed(pick.path);
  load();
}
```

- [ ] **Step 3: Show flavor on the chip + use it for the test-drive command + import gating**

In `renderTestbedChip` (the non-null branch), include the flavor label, e.g. change the path span to also show `FLAVORS[activeFlavor].label`. In `renderTestDrive`, use the flavor's run command:

```js
  document.getElementById("tdCmd").textContent = `cd ${activeTestbed} && ${FLAVORS[activeFlavor].run}`;
```

And gate the Import button (in `load()` after rendering, or in `openImport`): if `!FLAVORS[activeFlavor].importSupported`, disable `#importBtn` and set its title to `Import into ${FLAVORS[activeFlavor].label} testbeds isn't supported yet — hand-edit the project`. In `openImport`, early-return with an alert if import isn't supported:

```js
async function openImport(){
  if(!activeTestbed){ alert("Create or open a testbed first."); return; }
  if(!FLAVORS[activeFlavor].importSupported){ alert(`Import into ${FLAVORS[activeFlavor].label} testbeds isn't supported yet — hand-edit the project, then it'll be picked up.`); return; }
  /* …existing body… */
}
```

Also set the Import button's disabled state in `renderTestDrive()` (called at the end of `load()`):

```js
  const ib = document.getElementById("importBtn");
  if (ib) { const ok = FLAVORS[activeFlavor].importSupported; ib.disabled = !ok; ib.title = ok ? "" : `Not supported for ${FLAVORS[activeFlavor].label} testbeds`; }
```

- [ ] **Step 4: Build + manual verify**

```bash
npm run build && PORT=4317 node dist/index.js &
```
```bash
browser-harness <<'PY'
import time
new_tab("http://127.0.0.1:4317/"); wait_for_load(); time.sleep(1.0)
import subprocess
# simulate a codex testbed
js("localStorage.setItem('agentgem.testbed','/tmp/cx-tb'); localStorage.setItem('agentgem.testbedFlavor','codex')")
PY
mkdir -p /tmp/cx-tb && curl -s -X POST http://127.0.0.1:4317/api/testbed/scaffold -H 'content-type: application/json' -d '{"root":"/tmp/cx-tb","name":"cx","flavor":"codex"}' >/dev/null
browser-harness <<'PY'
import time
new_tab("http://127.0.0.1:4317/"); wait_for_load(); time.sleep(1.5)
print("test-drive cmd:", js("document.getElementById('tdCmd') && document.getElementById('tdCmd').textContent"))
print("import disabled (codex):", js("document.getElementById('importBtn') && document.getElementById('importBtn').disabled"))
PY
```
Expected: the test-drive command reads `cd /tmp/cx-tb && codex`, and the Import button is disabled for the codex flavor. Clean up `/tmp/cx-tb` + stop the server after.

- [ ] **Step 5: Unit suite + commit**

Run: `npm run clean && npx tsc -b && npx vitest run` (still passing), then `npm run build`.

```bash
git add src/public/index.html
git commit -m "feat(ui): testbed flavor selection (detect-else-ask), flavor run command + import gating"
```

---

## Self-Review

**1. Spec coverage:** registry + detect/scaffold/runCommand/importSupported → Task 3. Detect-else-ask + persistence → Tasks 3 (detect) + 5 (ask/persist). Flavor-aware *introspect* delivered as the refined **flavor-agnostic union read** (spec §2's intent; rationale in Architecture) → Task 2. Codex shape (skills `.agents/skills` existing + MCP `.codex/config.toml` + `AGENTS.md`) → Tasks 1–3. Hermes shape (skills `.hermes/skills` DESCRIPTION.md + `.hermes/SOUL.md`) → Tasks 2–3. Endpoints → Task 4. UI (chip flavor, test-drive command, import gating) → Task 5. Packaging unchanged (introspect union means `/api/gem`/materialize need no flavor) — confirmed by Task 2's design. **Deferred per spec §8:** import-INTO-codex/hermes writers; **Hermes project MCP (`.hermes/config.yaml`)** moved to deferred (needs a YAML reader + secret-safety) — noted below.

**2. Placeholder scan:** No TBD/TODO; every code step has complete code. The hermes-MCP deferral is an explicit out-of-scope decision, not a placeholder.

**3. Type consistency:** `TestbedFlavorId` / `TESTBED_FLAVORS` / `detectFlavor` / `flavorIds` defined in Task 3, consumed identically in Tasks 4 (schemas/endpoints) and mirrored in the UI's `FLAVORS` table (Task 5). `scaffoldTestbed(root, name, flavor="claude")` signature consistent across Tasks 3–4. `parseTomlMcpServers` (Task 1) consumed in Task 2. Endpoint paths/shapes (`/api/testbed/detect` → `{flavor}`, scaffold `+flavor`) consistent between Task 4 and the Task 5 fetches.

**Deviation from spec (noted):** the spec modeled a per-flavor `introspect(root)`; the plan instead keeps introspection flavor-agnostic (union of present project shapes) because `introspectProject` already reads multiple shapes and this makes inventory **and** packaging work with zero flavor-threading. Same user-facing behavior; simpler seam. Flagged here for the spec-review/reviewer.

**Out of scope (carried):** import-INTO-codex/hermes writers; **Hermes `.hermes/config.yaml` MCP** (YAML reader + secret-safety) — both are clean follow-ups; the run/scaffold/skills/instructions path ships first.
