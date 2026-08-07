# Gem Archive v2 — Agent Plugins Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every written gem archive a conformant Agent Plugin 1.0.0 (generated `plugin.json` + spec-shaped `mcp.json` + existing `skills/`), and accept any conformant Agent Plugin as an importable Gem.

**Architecture:** All changes live at the serialization edge (`packages/archive`), plus one pure helper in `packages/model`. `gem.json`/`gem.lock` stay the source of truth; `plugin.json` is write-only derived output; portable MCP servers single-source into `mcp.json` with non-spec fields riding in the `gem.json` manifest entry. A new `readAgentPlugin()` imports foreign plugins. Spec: `docs/superpowers/specs/2026-08-07-agent-plugins-alignment-design.md`.

**Tech Stack:** TypeScript ESM (Node ≥ 24), pnpm 11 workspace, vitest 4, ajv (new dev-only dep) for JSON Schema conformance tests.

**Explicit non-goal:** no user-facing import surface (SourceSpec adapter / console UI) in this plan — `readAgentPlugin` is the library seam; the adapter ships as a follow-up branch off a fresh `origin/main`.

## Global Constraints

- **Work in the worktree** `/Users/rfeng/Projects/ninemind/agentgem-worktrees/agent-plugins`, branch `agent-plugins` (off `origin/main`). Never commit to `main`.
- **Tests run against compiled output**: vitest's include is `dist/**/__tests__/**/*.test.js` + `packages/*/dist/**/__tests__/**/*.test.js`. ALWAYS `pnpm exec tsc -b` before `pnpm exec vitest run <dist path>`. A test that was renamed/deleted needs its stale `dist` twin removed.
- **New source files start with** the two-line header:
  `// Copyright (c) 2026 NineMind, Inc.` / `// SPDX-License-Identifier: MIT`
- **Determinism:** nothing written into an archive may depend on time or randomness; unchanged gems must produce byte-identical archives across writes.
- **Round-trip invariant:** `readGemArchive(writeGemArchive(gem).files)` deep-equals `gem` for every field this plan touches.
- Spec constants (verbatim): plugin schema URI `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, mcp schema URI `https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`, plugin name rule = 1–64 chars of `[a-z0-9.-]`, alphanumeric first/last char, no `--`, no `..`.

---

### Task 1: `pluginNameSlug` helper in the model

**Files:**
- Modify: `packages/model/src/targets.ts` (add function next to `safePathSegment`, ~line 44)
- Test: `packages/model/src/__tests__/pluginNameSlug.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function pluginNameSlug(name: string): string` — exported via the existing `export * from "./targets.js"` barrel in `packages/model/src/index.ts` (no barrel edit needed). Task 2 imports it from `@agentgem/model`.

- [ ] **Step 1: Write the failing test**

Create `packages/model/src/__tests__/pluginNameSlug.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { pluginNameSlug } from "../index.js";

describe("pluginNameSlug", () => {
  it("lowercases and replaces illegal chars with hyphens", () => {
    expect(pluginNameSlug("My Gem!")).toBe("my-gem");
    expect(pluginNameSlug("ALL_CAPS_NAME")).toBe("all-caps-name");
  });
  it("collapses runs and trims to alphanumeric edges", () => {
    expect(pluginNameSlug("--weird--name--")).toBe("weird-name");
    expect(pluginNameSlug("reports..plugin")).toBe("reports.plugin");
    expect(pluginNameSlug("trailing-.")).toBe("trailing");
  });
  it("clamps to 64 chars and re-trims the cut edge", () => {
    expect(pluginNameSlug("a".repeat(70))).toBe("a".repeat(64));
    expect(pluginNameSlug("a".repeat(63) + "-bcd")).toBe("a".repeat(63));
  });
  it("falls back to 'gem' when nothing survives", () => {
    expect(pluginNameSlug("日本語")).toBe("gem");
    expect(pluginNameSlug("")).toBe("gem");
  });
  it("keeps already-valid names unchanged", () => {
    expect(pluginNameSlug("reports-plugin")).toBe("reports-plugin");
  });
});
```

Note the import is from `../index.js` (the barrel), so the compiled test resolves inside `dist/`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/agent-plugins
pnpm exec tsc -b
```
Expected: compile FAILS with `pluginNameSlug` not exported. (The compile failure IS the failing state; vitest can't run what doesn't compile.)

- [ ] **Step 3: Implement**

In `packages/model/src/targets.ts`, directly below `safePathSegment` (after line 43):

```ts
// Agent Plugins 1.0.0 manifest name: 1–64 chars of [a-z0-9.-], alphanumeric at both
// ends, no "--" or "..". Derived for plugin.json only — gem.name stays canonical and
// the slug is never read back.
export function pluginNameSlug(name: string): string {
  let s = name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  s = s.replace(/-+/g, "-").replace(/\.+/g, ".");
  s = s.replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
  if (s.length > 64) s = s.slice(0, 64).replace(/[^a-z0-9]+$/, "");
  return s.length === 0 ? "gem" : s;
}
```

(Hyphen runs are collapsed before dot runs; neither collapse can create the other's run, and `-.-` sequences are legal per the spec.)

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm exec tsc -b && pnpm exec vitest run packages/model/dist/__tests__/pluginNameSlug.test.js
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/model/src/targets.ts packages/model/src/__tests__/pluginNameSlug.test.ts
git commit -m "feat(model): add pluginNameSlug for Agent Plugins manifest names"
```

---

### Task 2: Format v2 scaffolding — `plugin.json` emission + version gate

**Files:**
- Modify: `packages/archive/src/archive.ts`
- Test: `src/gem/__tests__/agentPluginArchive.test.ts` (new, at repo root — sits beside `archive.test.ts`)

**Interfaces:**
- Consumes: `pluginNameSlug` from `@agentgem/model` (Task 1).
- Produces: `ARCHIVE_FORMAT_VERSION === 2`; every `writeGemArchive` output contains `plugin.json`; `readGemArchive` accepts formatVersion 1 and 2, throws on anything else. Constants `PLUGIN_MANIFEST_PATH = "plugin.json"`, `MCP_JSON_PATH = "mcp.json"` (module-level, used by Tasks 3–6).

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/agentPluginArchive.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { writeGemArchive, readGemArchive, computeLock } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";

const baseGem = (): Gem => ({
  name: "My Test Gem!",
  createdFrom: "unit test",
  artifacts: [{ type: "skill", name: "summarize", source: "standalone", content: "# Summarize\nDo the thing." }],
  checks: [],
  requiredSecrets: [],
});

describe("archive v2: plugin.json", () => {
  it("emits a spec-shaped plugin.json with slugged name", () => {
    const { files } = writeGemArchive(baseGem(), { version: "1.2.0" });
    const p = JSON.parse(files["plugin.json"]);
    expect(p).toEqual({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "my-test-gem",
      version: "1.2.0",
    });
  });
  it("stamps formatVersion 2 in gem.json and gem.lock, and lock covers plugin.json", () => {
    const { files } = writeGemArchive(baseGem());
    expect(JSON.parse(files["gem.json"]).formatVersion).toBe(2);
    const lock = JSON.parse(files["gem.lock"]);
    expect(lock.formatVersion).toBe(2);
    expect(lock.files["plugin.json"]).toMatch(/^sha256:/);
  });
  it("round-trips: plugin.json is derived output, never read back", () => {
    const gem = baseGem();
    expect(readGemArchive(writeGemArchive(gem).files)).toEqual(gem);
  });
  it("still reads a formatVersion 1 archive (no plugin.json)", () => {
    const files: Record<string, string> = {
      "gem.json": JSON.stringify({
        formatVersion: 1, name: "old", version: "0.1.0", createdFrom: "unit test",
        artifacts: [{ type: "skill", name: "s", path: "skills/s/SKILL.md", source: "standalone" }],
        requiredSecrets: [], checks: [],
      }),
      "skills/s/SKILL.md": "# S",
    };
    files["gem.lock"] = JSON.stringify(computeLock(files));
    const gem = readGemArchive(files);
    expect(gem.name).toBe("old");
    expect(gem.artifacts).toEqual([{ type: "skill", name: "s", source: "standalone", content: "# S" }]);
  });
  it("rejects an unknown formatVersion", () => {
    const files: Record<string, string> = {
      "gem.json": JSON.stringify({ formatVersion: 3, name: "future", version: "0.1.0", createdFrom: "x", artifacts: [], requiredSecrets: [], checks: [] }),
    };
    files["gem.lock"] = JSON.stringify(computeLock(files));
    expect(() => readGemArchive(files)).toThrow(/formatVersion/);
  });
});
```

(The v1 fixture is hand-built; `computeLock` is format-agnostic so the lock is valid. Note the v1 fixture's lock will carry `formatVersion: 2` after the bump — that is fine, dispatch reads `gem.json`'s value.)

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/agentPluginArchive.test.js
```
(Adjust the dist path if the compiled test lands at `dist/gem/__tests__/…` — mirror wherever `archive.test.js` compiles to; check with `ls dist/**/__tests__/ | grep -n agentPlugin`.)
Expected: FAIL — no `plugin.json` in output, formatVersion still 1.

- [ ] **Step 3: Implement in `packages/archive/src/archive.ts`**

1. Change line 19: `export const ARCHIVE_FORMAT_VERSION = 2;`
2. Below `const LOCK_PATH = "gem.lock";` add:

```ts
export const PLUGIN_MANIFEST_PATH = "plugin.json";
export const MCP_JSON_PATH = "mcp.json";
const PLUGIN_SCHEMA_URI = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA_URI = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
```

3. Add `pluginNameSlug` to the `@agentgem/model` value import (line 12).
4. In `writeGemArchive`, immediately before `files[MANIFEST_PATH] = …` (line 189), add:

```ts
  files[PLUGIN_MANIFEST_PATH] = JSON.stringify(
    { $schema: PLUGIN_SCHEMA_URI, name: pluginNameSlug(gem.name), version: opts.version ?? "0.1.0" },
    null, 2,
  );
```

5. In `readGemArchive`, right after `const manifest = JSON.parse(manifestRaw) as GemManifest;` (line 261), add:

```ts
  if (manifest.formatVersion !== 1 && manifest.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw new Error(`unsupported archive formatVersion ${manifest.formatVersion}`);
  }
```

- [ ] **Step 4: Run the new test AND the full existing archive suites**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/**/__tests__/agentPluginArchive.test.js dist/**/__tests__/archive*.test.js dist/**/__tests__/*.archive.test.js dist/**/__tests__/gameArchive.test.js dist/**/__tests__/rubricArchive.test.js
```
Expected: new test PASSES. **Existing suites may fail on assertions that enumerate archive files or hardcode formatVersion 1** — fix those assertions (they now must expect `plugin.json` and version 2); do NOT weaken round-trip assertions. If a failure is not obviously that, stop and investigate before touching it.

- [ ] **Step 5: Commit**

```bash
git add packages/archive/src/archive.ts src/gem/__tests__/agentPluginArchive.test.ts src/gem/__tests__/
git commit -m "feat(archive): v2 emits a conformant Agent Plugins plugin.json"
```

---

### Task 3: Serialize `SkillArtifact.files` (sibling scripts/references)

**Files:**
- Modify: `packages/archive/src/archive.ts` (skill branch of `writeGemArchive` ~line 108; skill branch of `readGemArchive` ~line 277; `ManifestArtifactEntry` line 75)
- Test: `src/gem/__tests__/agentPluginArchive.test.ts` (extend)

**Interfaces:**
- Consumes: `SkillArtifact.files?: { path: string; content: string }[]` and `filesTruncated?: boolean` (already in `packages/model/src/types.ts:21-37`).
- Produces: manifest skill entries gain `files?: string[]` (skill-dir-relative paths) and `filesTruncated?: boolean`; bodies at `skills/<seg>/<relpath>`. Task 6's importer relies on this surviving a write.

- [ ] **Step 1: Write the failing tests** (append to `agentPluginArchive.test.ts`)

```ts
describe("archive v2: skill sibling files", () => {
  const gemWithFiles = (): Gem => ({
    name: "g", createdFrom: "unit test", checks: [], requiredSecrets: [],
    artifacts: [{
      type: "skill", name: "summarize", source: "standalone", content: "# S",
      files: [
        { path: "scripts/analyze.sh", content: "#!/bin/sh\necho hi\n" },
        { path: "references/checklist.md", content: "- [ ] check\n" },
      ],
    }],
  });
  it("places sibling files under the skill dir and round-trips them", () => {
    const { files } = writeGemArchive(gemWithFiles());
    expect(files["skills/summarize/scripts/analyze.sh"]).toBe("#!/bin/sh\necho hi\n");
    expect(files["skills/summarize/references/checklist.md"]).toBe("- [ ] check\n");
    expect(readGemArchive(files)).toEqual(gemWithFiles());
  });
  it("round-trips filesTruncated", () => {
    const gem = gemWithFiles();
    (gem.artifacts[0] as { filesTruncated?: boolean }).filesTruncated = true;
    expect(readGemArchive(writeGemArchive(gem).files)).toEqual(gem);
  });
  it("skips unsafe sibling paths instead of writing them", () => {
    const gem = gemWithFiles();
    (gem.artifacts[0] as { files: { path: string; content: string }[] }).files = [{ path: "../evil.sh", content: "x" }];
    const { files, skipped } = writeGemArchive(gem);
    expect(Object.keys(files).some((p) => p.includes("evil"))).toBe(false);
    expect(skipped.some((s) => s.reason.includes("unsafe"))).toBe(true);
  });
  it("keeps a no-files skill byte-identical to a plain write (digest safety)", () => {
    const a = writeGemArchive(baseGem()).files;
    const b = writeGemArchive(baseGem()).files;
    expect(a).toEqual(b);
    expect(JSON.parse(a["gem.json"]).artifacts[0].files).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/**/__tests__/agentPluginArchive.test.js
```
Expected: FAIL — sibling files absent from output, `readGemArchive` drops `files`.

- [ ] **Step 3: Implement**

1. Extend `ManifestArtifactEntry` (line 75) with `files?: string[]; filesTruncated?: boolean;`.
2. Replace the skill branch in `writeGemArchive` (lines 108–114) with:

```ts
    if (a.type === "skill") {
      const skillDir = `skills/${seg}`;
      const path = `${skillDir}/SKILL.md`;
      if (place(path, a.content, a.name, "skill")) {
        const e: ManifestArtifactEntry = { type: "skill", name: a.name, path, source: a.source };
        if (a.description !== undefined) e.description = a.description;
        const rels: string[] = [];
        for (const f of a.files ?? []) {
          const segs = f.path.split("/");
          if (segs.some((s) => s === "" || s === "." || s === "..") || f.path === "SKILL.md") {
            skipped.push({ artifact: `${a.name}:${f.path}`, type: "skill", reason: "unsafe or reserved skill file path" });
            continue;
          }
          if (place(`${skillDir}/${f.path}`, f.content, `${a.name}:${f.path}`, "skill")) rels.push(f.path);
        }
        if (rels.length > 0) e.files = rels;
        if (a.filesTruncated) e.filesTruncated = true;
        artifacts.push(e);
      }
    } else if (a.type === "instructions") {
```

3. Replace the skill branch in `readGemArchive` (lines 277–281) with:

```ts
    if (e.type === "skill") {
      const a: SkillArtifact = { type: "skill", name: e.name, source: e.source ?? "standalone", content: body(e.path) };
      if (e.description !== undefined) a.description = e.description;
      const skillDir = e.path.replace(/\/SKILL\.md$/, "");
      if (e.files !== undefined) a.files = e.files.map((rel) => ({ path: rel, content: body(`${skillDir}/${rel}`) }));
      if (e.filesTruncated) a.filesTruncated = true;
      return a;
    }
```

- [ ] **Step 4: Run to verify pass** — same command as Step 2, plus `dist/**/__tests__/archive.test.js`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/archive/src/archive.ts src/gem/__tests__/agentPluginArchive.test.ts
git commit -m "feat(archive): v2 serializes SkillArtifact sibling files"
```

---

### Task 4: Fold portable MCP servers into a spec-shaped `mcp.json`

**Files:**
- Modify: `packages/archive/src/archive.ts` (mcp branch of write ~line 118, mcp branch of read ~line 285, `ManifestArtifactEntry`)
- Test: `src/gem/__tests__/agentPluginArchive.test.ts` (extend)

**Interfaces:**
- Consumes: `McpServerArtifact` (`transport: "stdio" | "http" | "sse"`, free-form redacted `config`, `source?`, `secretRefs?`).
- Produces: `mcp.json` written iff ≥1 portable server; manifest mcp entries with `path: "mcp.json"` gain `secretRefs?` and `extra?: Record<string, unknown>`; non-portable servers keep `mcp/<n>.json`. Module-level helper `mcpPortable(a: McpServerArtifact): { entry: Record<string, unknown>; extra: Record<string, unknown> } | null`.

- [ ] **Step 1: Write the failing tests** (append)

```ts
import type { McpServerArtifact } from "@agentgem/model";

describe("archive v2: mcp.json folding", () => {
  const mk = (over: Partial<McpServerArtifact>): Gem => ({
    name: "g", createdFrom: "unit test", checks: [], requiredSecrets: [],
    artifacts: [{ type: "mcp_server", name: "db server", transport: "stdio", config: { command: "npx", args: ["-y", "db-mcp"] }, ...over } as McpServerArtifact],
  });
  it("writes a portable stdio server into spec-shaped mcp.json only", () => {
    const { files } = writeGemArchive(mk({}));
    const doc = JSON.parse(files["mcp.json"]);
    expect(doc.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(doc.mcpServers["db_server"]).toEqual({ type: "stdio", command: "npx", args: ["-y", "db-mcp"] });
    expect(Object.keys(files).some((p) => p.startsWith("mcp/"))).toBe(false);
  });
  it("maps http to streamable-http and back", () => {
    const gem = mk({ transport: "http", config: { url: "https://x.example/mcp", headers: { "X-T": "1" } } });
    const { files } = writeGemArchive(gem);
    expect(JSON.parse(files["mcp.json"]).mcpServers["db_server"].type).toBe("streamable-http");
    expect(readGemArchive(files)).toEqual(gem);
  });
  it("carries non-spec config keys, source, and secretRefs via the manifest entry", () => {
    const gem = mk({ source: "claude", secretRefs: [{ name: "DB_TOKEN", locations: ["env.DB_TOKEN"] }], config: { command: "npx", timeoutMs: 5000, env: { PLUGIN_ROOT: "reserved" } } } as Partial<McpServerArtifact>);
    const { files } = writeGemArchive(gem);
    const entry = JSON.parse(files["gem.json"]).artifacts[0];
    expect(entry.path).toBe("mcp.json");
    expect(entry.extra).toEqual({ timeoutMs: 5000, env: { PLUGIN_ROOT: "reserved" } });
    const server = JSON.parse(files["mcp.json"]).mcpServers["db_server"];
    expect(server.env).toBeUndefined(); // reserved name kept OUT of spec surface
    expect(readGemArchive(files)).toEqual(gem);
  });
  it("falls back to mcp/<n>.json for a non-portable server and writes no mcp.json", () => {
    const gem = mk({ config: { note: "no command" } });
    const { files } = writeGemArchive(gem);
    expect(files["mcp.json"]).toBeUndefined();
    expect(files["mcp/db_server.json"]).toBeDefined();
    expect(readGemArchive(files)).toEqual(gem);
  });
  it("rejects plain-http non-loopback urls as non-portable", () => {
    const { files } = writeGemArchive(mk({ transport: "http", config: { url: "http://x.example/mcp" } }));
    expect(files["mcp.json"]).toBeUndefined();
  });
  it("skips the second server when two names slug to the same mcp.json key", () => {
    const gem: Gem = { ...mk({}), artifacts: [
      { type: "mcp_server", name: "db server", transport: "stdio", config: { command: "a" } },
      { type: "mcp_server", name: "db_server", transport: "stdio", config: { command: "b" } },
    ] };
    const { files, skipped } = writeGemArchive(gem);
    expect(JSON.parse(files["mcp.json"]).mcpServers["db_server"].command).toBe("a");
    expect(skipped.some((s) => s.type === "mcp_server" && s.reason.includes("collision"))).toBe(true);
  });
});
```

(Check `SecretRef`'s exact shape in `packages/model/src/types.ts` before writing the secretRefs fixture and adjust the literal to match.)

- [ ] **Step 2: Run to verify fail** — `pnpm exec tsc -b && pnpm exec vitest run dist/**/__tests__/agentPluginArchive.test.js`. Expected: FAIL (servers still under `mcp/`).

- [ ] **Step 3: Implement**

1. Extend `ManifestArtifactEntry` with `secretRefs?: SecretRef[]; extra?: Record<string, unknown>;` (import `SecretRef` type — already imported at line 8).
2. Add module-level helper above `writeGemArchive`:

```ts
// A server is portable when its redacted config supplies the closed spec schema's
// required fields. Recognized keys go to mcp.json; everything else (wrong-shaped,
// unknown, or spec-reserved) rides in the manifest entry's `extra` and merges back
// on read — the round-trip stays exact while mcp.json stays conformant.
function mcpPortable(a: McpServerArtifact): { entry: Record<string, unknown>; extra: Record<string, unknown> } | null {
  const c = a.config;
  const extra: Record<string, unknown> = {};
  const isStrMap = (v: unknown): v is Record<string, string> =>
    typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
  if (a.transport === "stdio") {
    if (typeof c.command !== "string" || c.command === "") return null;
    const entry: Record<string, unknown> = { type: "stdio", command: c.command };
    for (const [k, v] of Object.entries(c)) {
      if (k === "command") continue;
      if (k === "args" && Array.isArray(v) && v.every((x) => typeof x === "string")) entry.args = v;
      else if (k === "env" && isStrMap(v) && !("PLUGIN_ROOT" in v) && !("PLUGIN_DATA" in v)) entry.env = v;
      else if (k === "cwd" && typeof v === "string") entry.cwd = v;
      else extra[k] = v;
    }
    return { entry, extra };
  }
  if (typeof c.url !== "string") return null;
  let u: URL;
  try { u = new URL(c.url); } catch { return null; }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
  if (u.username !== "" || u.password !== "" || u.hash !== "") return null;
  const entry: Record<string, unknown> = { type: a.transport === "http" ? "streamable-http" : "sse", url: c.url };
  for (const [k, v] of Object.entries(c)) {
    if (k === "url") continue;
    if (k === "headers" && isStrMap(v)) entry.headers = v;
    else extra[k] = v;
  }
  return { entry, extra };
}
```

3. In `writeGemArchive`, add `const mcpServers: Record<string, Record<string, unknown>> = {};` next to the other accumulators, and replace the `mcp_server` branch (lines 118–123) with:

```ts
    } else if (a.type === "mcp_server") {
      const portable = mcpPortable(a);
      if (portable) {
        if (seg in mcpServers) {
          skipped.push({ artifact: a.name, type: "mcp_server", reason: `mcp.json key collision with an earlier server at ${seg}` });
        } else {
          mcpServers[seg] = portable.entry;
          const e: ManifestArtifactEntry = { type: "mcp_server", name: a.name, path: MCP_JSON_PATH };
          if (a.source !== undefined) e.source = a.source;
          if (a.secretRefs !== undefined) e.secretRefs = a.secretRefs;
          if (Object.keys(portable.extra).length > 0) e.extra = portable.extra;
          artifacts.push(e);
        }
      } else {
        const path = `mcp/${withExt(seg, ".json")}`;
        const body: Record<string, unknown> = { transport: a.transport, config: a.config };
        if (a.source !== undefined) body.source = a.source;
        if (a.secretRefs !== undefined) body.secretRefs = a.secretRefs;
        if (place(path, JSON.stringify(body, null, 2), a.name, "mcp_server")) artifacts.push({ type: "mcp_server", name: a.name, path });
      }
    }
```

4. After the artifact loop (before the checks loop, ~line 168), add:

```ts
  if (Object.keys(mcpServers).length > 0) {
    files[MCP_JSON_PATH] = JSON.stringify({ $schema: MCP_SCHEMA_URI, mcpServers }, null, 2);
  }
```

5. In `readGemArchive`, replace the `mcp_server` branch (lines 285–291) with:

```ts
    if (e.type === "mcp_server") {
      if (e.path === MCP_JSON_PATH) {
        const doc = JSON.parse(body(MCP_JSON_PATH)) as { mcpServers?: Record<string, Record<string, unknown>> };
        const s = doc.mcpServers?.[safePathSegment(e.name)];
        if (s === undefined) throw new Error(`mcp.json is missing server '${e.name}'`);
        const { type: specType, ...rest } = s;
        const transport: McpServerArtifact["transport"] = specType === "streamable-http" ? "http" : specType === "sse" ? "sse" : "stdio";
        const a: McpServerArtifact = { type: "mcp_server", name: e.name, transport, config: { ...rest, ...(e.extra ?? {}) } };
        if (e.source !== undefined) a.source = e.source;
        if (e.secretRefs !== undefined) a.secretRefs = e.secretRefs;
        return a;
      }
      const o = JSON.parse(body(e.path)) as { transport: McpServerArtifact["transport"]; config: Record<string, unknown>; source?: string; secretRefs?: McpServerArtifact["secretRefs"] };
      const a: McpServerArtifact = { type: "mcp_server", name: e.name, transport: o.transport, config: o.config };
      if (o.source !== undefined) a.source = o.source;
      if (o.secretRefs !== undefined) a.secretRefs = o.secretRefs;
      return a;
    }
```

- [ ] **Step 4: Run to verify pass**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/**/__tests__/agentPluginArchive.test.js dist/**/__tests__/archive.test.js dist/**/__tests__/archiveMeta.test.js
```
Expected: PASS. Any pre-existing test that asserted `mcp/<n>.json` for a portable server must be updated to the new expectation (that IS the format change).

- [ ] **Step 5: Commit**

```bash
git add packages/archive/src/archive.ts src/gem/__tests__/agentPluginArchive.test.ts
git commit -m "feat(archive): v2 single-sources portable MCP servers into spec-shaped mcp.json"
```

---

### Task 5: Conformance tests against the vendored official schemas

**Files:**
- Create: `src/gem/__tests__/fixtures/agentPluginSchemas.ts` (vendored schemas as TS exports — JSON files under `src/` don't reach `dist/`)
- Test: `src/gem/__tests__/agentPluginConformance.test.ts` (new)
- Modify: root `package.json` (ajv devDependency)

**Interfaces:**
- Consumes: `writeGemArchive` outputs from Tasks 2/4.
- Produces: nothing for later tasks — this is a verification gate.

- [ ] **Step 1: Add ajv (dev-only) and vendor the schemas**

```bash
pnpm add -D -w "ajv@^8.20.0"
curl -sL https://agent-plugins.org/schemas/1.0.0/plugin.schema.json -o /tmp/plugin.schema.json
curl -sL https://agent-plugins.org/schemas/1.0.0/mcp.schema.json -o /tmp/mcp.schema.json
```

Create `src/gem/__tests__/fixtures/agentPluginSchemas.ts` with the two-line copyright header, then:

```ts
// Vendored verbatim from https://agent-plugins.org/schemas/1.0.0/ (immutable URIs
// per spec §versioning). Do not hand-edit; re-vendor if the pinned version changes.
export const pluginSchema = /* paste /tmp/plugin.schema.json contents */ as const;
export const mcpSchema = /* paste /tmp/mcp.schema.json contents */ as const;
```

(Paste the raw JSON object literals — they are ~1.8KB and ~3.4KB.)

- [ ] **Step 2: Write the failing-or-passing conformance test**

Create `src/gem/__tests__/agentPluginConformance.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import AjvImport from "ajv/dist/2020.js";
import { writeGemArchive } from "@agentgem/archive";
import type { Gem } from "@agentgem/model";
import { pluginSchema, mcpSchema } from "./fixtures/agentPluginSchemas.js";

// CJS/ESM interop: under node ESM the class may arrive as the module or as .default.
const Ajv = ((AjvImport as unknown as { default?: unknown }).default ?? AjvImport) as new (o: object) => {
  compile(s: object): ((d: unknown) => boolean) & { errors?: unknown };
};

const gem: Gem = {
  name: "Conformance Gem", createdFrom: "unit test", checks: [], requiredSecrets: [],
  artifacts: [
    { type: "skill", name: "summarize", source: "standalone", content: "# S" },
    { type: "mcp_server", name: "db", transport: "stdio", config: { command: "npx", args: ["db-mcp"], env: { MODE: "ro" } } },
    { type: "mcp_server", name: "api", transport: "http", config: { url: "https://x.example/mcp" } },
  ],
};

describe("generated files conform to the official Agent Plugins schemas", () => {
  const ajv = new Ajv({ strict: false });
  it("plugin.json validates", () => {
    const validate = ajv.compile(pluginSchema);
    const { files } = writeGemArchive(gem);
    expect(validate(JSON.parse(files["plugin.json"])), JSON.stringify(validate.errors)).toBe(true);
  });
  it("mcp.json validates", () => {
    const validate = ajv.compile(mcpSchema);
    const { files } = writeGemArchive(gem);
    expect(validate(JSON.parse(files["mcp.json"])), JSON.stringify(validate.errors)).toBe(true);
  });
  it("a gem with no portable servers writes no mcp.json at all", () => {
    const { files } = writeGemArchive({ ...gem, artifacts: [gem.artifacts[0]] });
    expect(files["mcp.json"]).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/**/__tests__/agentPluginConformance.test.js
```
Expected: PASS. If a schema violation surfaces, the generator (Tasks 2/4) is wrong — fix the generator, never the assertion. If the ajv import shape breaks compilation, resolve the interop in the test only (the shim above), not by changing tsconfig.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml src/gem/__tests__/fixtures/agentPluginSchemas.ts src/gem/__tests__/agentPluginConformance.test.ts
git commit -m "test(archive): validate generated plugin.json/mcp.json against official schemas"
```

---

### Task 6: `readAgentPlugin` import adapter

**Files:**
- Create: `packages/archive/src/agentPlugin.ts`
- Modify: `packages/archive/src/index.ts` (add `export * from "./agentPlugin.js";`)
- Test: `src/gem/__tests__/agentPluginImport.test.ts` (new)

**Interfaces:**
- Consumes: `FileTree`, `SkippedArtifact`, `InvalidInputError` (all exported from `@agentgem/model`); `writeGemArchive`/`readGemArchive` for the round-trip test.
- Produces:

```ts
export interface AgentPluginImport { gem: Gem; skipped: SkippedArtifact[]; notes: string[] }
export function readAgentPlugin(files: FileTree): AgentPluginImport
```

- [ ] **Step 1: Write the failing tests**

Create `src/gem/__tests__/agentPluginImport.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { readAgentPlugin, writeGemArchive, readGemArchive } from "@agentgem/archive";
import { InvalidInputError } from "@agentgem/model";

const fixture = (): Record<string, string> => ({
  "plugin.json": JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "reports-plugin", version: "1.2.0", license: "MIT",
  }),
  "skills/summarize/SKILL.md": "# Summarize\nDo it.",
  "skills/summarize/scripts/analyze.sh": "#!/bin/sh\n",
  "skills/summarize/references/checklist.md": "- check\n",
  "skills/not-a-skill/README.md": "no SKILL.md here",
  "mcp.json": JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      validator: { type: "stdio", command: "./bin/validate", args: ["--fast"], cwd: "${PLUGIN_ROOT}" },
      deploy: { type: "streamable-http", url: "https://deploy.example.com/mcp", headers: { "X-T": "p" } },
      legacy: { type: "websocket", url: "wss://nope" },
    },
  }),
  "com.example.client/hooks/hooks.json": "{}",
  "LICENSE": "MIT",
});

describe("readAgentPlugin", () => {
  it("imports skills (with sibling files) and MCP servers, ignoring extensions", () => {
    const { gem, skipped, notes } = readAgentPlugin(fixture());
    expect(gem.name).toBe("reports-plugin");
    expect(gem.createdFrom).toBe("Imported from Agent Plugin 'reports-plugin' v1.2.0");
    const skill = gem.artifacts.find((a) => a.type === "skill");
    expect(skill).toMatchObject({ name: "summarize", source: "agent-plugin", content: "# Summarize\nDo it." });
    expect((skill as { files?: unknown[] }).files).toEqual([
      { path: "references/checklist.md", content: "- check\n" },
      { path: "scripts/analyze.sh", content: "#!/bin/sh\n" },
    ]);
    const servers = gem.artifacts.filter((a) => a.type === "mcp_server");
    expect(servers).toEqual([
      { type: "mcp_server", name: "validator", transport: "stdio", config: { command: "./bin/validate", args: ["--fast"], cwd: "${PLUGIN_ROOT}" } },
      { type: "mcp_server", name: "deploy", transport: "http", config: { url: "https://deploy.example.com/mcp", headers: { "X-T": "p" } } },
    ]);
    expect(skipped.some((s) => s.artifact === "legacy" && s.type === "mcp_server")).toBe(true);
    expect(notes).toEqual([]); // license is a KNOWN manifest field
    expect(gem.checks).toEqual([]);
    expect(gem.requiredSecrets).toEqual([]);
  });
  it("reports unknown manifest fields as notes, non-fatally", () => {
    const f = fixture();
    f["plugin.json"] = JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "x", futureField: 1 });
    const { gem, notes } = readAgentPlugin(f);
    expect(gem.name).toBe("x");
    expect(notes.some((n) => n.includes("futureField"))).toBe(true);
  });
  it("rejects a missing or invalid manifest", () => {
    expect(() => readAgentPlugin({})).toThrow(InvalidInputError);
    const f = fixture();
    f["plugin.json"] = JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "Bad--Name" });
    expect(() => readAgentPlugin(f)).toThrow(InvalidInputError);
  });
  it("skips a version-mismatched mcp.json wholesale but keeps skills", () => {
    const f = fixture();
    f["mcp.json"] = JSON.stringify({ $schema: "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json", mcpServers: {} });
    const { gem, notes } = readAgentPlugin(f);
    expect(gem.artifacts.some((a) => a.type === "skill")).toBe(true);
    expect(gem.artifacts.some((a) => a.type === "mcp_server")).toBe(false);
    expect(notes.some((n) => n.includes("mcp.json"))).toBe(true);
  });
  it("imported gems survive our archive round-trip", () => {
    const { gem } = readAgentPlugin(fixture());
    expect(readGemArchive(writeGemArchive(gem).files)).toEqual(gem);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm exec tsc -b`. Expected: compile FAILS (`readAgentPlugin` unexported).

- [ ] **Step 3: Implement `packages/archive/src/agentPlugin.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Import a conformant Agent Plugin 1.0.0 directory tree as a Gem. Plugin-level
// schema violations are fatal (InvalidInputError); component-level failures are
// isolated as SkippedArtifact, matching the spec's failure-handling table.
import type { FileTree, Gem, GemArtifact, McpServerArtifact, SkillArtifact, SkippedArtifact } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";

const PLUGIN_SCHEMA_URI = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA_URI = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const NAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const KNOWN_MANIFEST_FIELDS = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);

export interface AgentPluginImport { gem: Gem; skipped: SkippedArtifact[]; notes: string[] }

export function readAgentPlugin(files: FileTree): AgentPluginImport {
  const raw = files["plugin.json"];
  if (raw === undefined) throw new InvalidInputError("not an Agent Plugin: plugin.json is missing");
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(raw) as Record<string, unknown>; } catch { throw new InvalidInputError("plugin.json is not valid JSON"); }
  if (manifest.$schema !== PLUGIN_SCHEMA_URI) throw new InvalidInputError(`unsupported plugin.json $schema '${String(manifest.$schema)}'`);
  const name = manifest.name;
  if (typeof name !== "string" || !NAME_RE.test(name) || name.includes("--") || name.includes("..")) {
    throw new InvalidInputError(`invalid Agent Plugin name '${String(name)}'`);
  }
  const notes: string[] = [];
  for (const k of Object.keys(manifest)) if (!KNOWN_MANIFEST_FIELDS.has(k)) notes.push(`plugin.json: unknown field '${k}' ignored`);

  const skipped: SkippedArtifact[] = [];
  const artifacts: GemArtifact[] = [];

  // Skills: immediate children of skills/ that contain SKILL.md; no recursion.
  const skillDirs = new Set<string>();
  for (const p of Object.keys(files)) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(p);
    if (m) skillDirs.add(m[1]);
  }
  for (const dir of [...skillDirs].sort()) {
    const a: SkillArtifact = { type: "skill", name: dir, source: "agent-plugin", content: files[`skills/${dir}/SKILL.md`] };
    const siblings = Object.keys(files)
      .filter((p) => p.startsWith(`skills/${dir}/`) && p !== `skills/${dir}/SKILL.md`)
      .sort();
    if (siblings.length > 0) a.files = siblings.map((p) => ({ path: p.slice(`skills/${dir}/`.length), content: files[p] }));
    artifacts.push(a);
  }

  // MCP servers: optional mcp.json; a version mismatch invalidates only this component.
  const mcpRaw = files["mcp.json"];
  if (mcpRaw !== undefined) {
    let doc: { $schema?: unknown; mcpServers?: Record<string, Record<string, unknown>> } | null = null;
    try { doc = JSON.parse(mcpRaw) as typeof doc; } catch { notes.push("mcp.json: invalid JSON — component skipped"); }
    if (doc !== null && doc.$schema !== MCP_SCHEMA_URI) { notes.push(`mcp.json: unsupported $schema — component skipped`); doc = null; }
    for (const [key, s] of Object.entries(doc?.mcpServers ?? {})) {
      const a = importServer(key, s);
      if (typeof a === "string") skipped.push({ artifact: key, type: "mcp_server", reason: a });
      else artifacts.push(a);
    }
  }

  const version = typeof manifest.version === "string" ? ` v${manifest.version}` : "";
  const gem: Gem = { name, createdFrom: `Imported from Agent Plugin '${name}'${version}`, artifacts, checks: [], requiredSecrets: [] };
  return { gem, skipped, notes };
}

function importServer(key: string, s: Record<string, unknown>): McpServerArtifact | string {
  const pick = (keys: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (s[k] !== undefined) out[k] = s[k];
    return out;
  };
  if (s.type === "stdio") {
    if (typeof s.command !== "string" || s.command === "") return "stdio server has no command";
    return { type: "mcp_server", name: key, transport: "stdio", config: pick(["command", "args", "env", "cwd"]) };
  }
  if (s.type === "streamable-http" || s.type === "sse") {
    if (typeof s.url !== "string") return `${s.type} server has no url`;
    return { type: "mcp_server", name: key, transport: s.type === "sse" ? "sse" : "http", config: pick(["url", "headers"]) };
  }
  return `unsupported transport '${String(s.type)}'`;
}
```

Add to `packages/archive/src/index.ts`: `export * from "./agentPlugin.js";`

- [ ] **Step 4: Run to verify pass**

```bash
pnpm exec tsc -b && pnpm exec vitest run dist/**/__tests__/agentPluginImport.test.js
```
Expected: PASS. (If `Gem` isn't exported as a type from `@agentgem/model`'s barrel it is — `types.ts` is re-exported; check the actual error before changing anything.)

- [ ] **Step 5: Commit**

```bash
git add packages/archive/src/agentPlugin.ts packages/archive/src/index.ts src/gem/__tests__/agentPluginImport.test.ts
git commit -m "feat(archive): readAgentPlugin imports conformant Agent Plugins as gems"
```

---

### Task 7: Full-suite regression, docs, and PR

**Files:**
- Modify: `docs/superpowers/specs/2026-08-07-agent-plugins-alignment-design.md` only if implementation diverged (record the divergence; don't rewrite history).

**Interfaces:** none — verification and integration gate.

- [ ] **Step 1: Full build + full test suite**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/agent-plugins
pnpm build && pnpm test
```
Expected: green. Failures in `packages/app` / run/verify paths most likely mean an assumption about `mcp/<n>.json` paths or formatVersion leaked outside the archive package — fix the consumer to go through `readGemArchive` rather than special-casing paths. Report any pre-existing failures separately; do not absorb them.

- [ ] **Step 2: Consumer sweep**

```bash
grep -rn "mcp/" --include="*.ts" src packages | grep -v __tests__ | grep -v dist | grep -v node_modules
grep -rn "formatVersion" --include="*.ts" src packages | grep -v __tests__ | grep -v dist
```
Expected: no consumer outside `packages/archive` hardcodes `mcp/<n>.json` layout or `formatVersion: 1`. Investigate and fix anything found (through the archive API, not by re-hardcoding).

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin agent-plugins
gh pr create --title "Gem archive v2: Agent Plugins alignment" --body "$(cat <<'EOF'
Every written gem archive is now also a conformant Agent Plugins 1.0.0 plugin
(generated plugin.json, spec-shaped mcp.json for portable MCP servers, existing
skills/ layout), and readAgentPlugin() imports any conformant plugin as a Gem.

- Format v2; v1 archives stay readable, published digests untouched
- SkillArtifact.files now serializes (was silently dropped in v1)
- Conformance tests validate output against the vendored official JSON Schemas (ajv, dev-only)
- Spec: docs/superpowers/specs/2026-08-07-agent-plugins-alignment-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch CI, verify conclusion, merge**

```bash
gh run list --branch agent-plugins --limit 1        # note <run-id>
gh run watch <run-id> --exit-status
gh run view <run-id> --json conclusion              # MUST be "success" — watch's exit code alone is not proof
gh pr merge --rebase --delete-branch                # local branch-delete step may error (main is in another worktree) — the REMOTE merge still succeeds
```

- [ ] **Step 5: Verify every commit landed on origin/main**

```bash
git fetch origin
git show origin/main:packages/model/src/targets.ts | grep -c pluginNameSlug        # ≥1 (Task 1)
git show origin/main:packages/archive/src/archive.ts | grep -c PLUGIN_MANIFEST_PATH # ≥1 (Task 2)
git show origin/main:packages/archive/src/archive.ts | grep -c "e.files"            # ≥1 (Task 3)
git show origin/main:packages/archive/src/archive.ts | grep -c mcpPortable          # ≥1 (Task 4)
git show origin/main:src/gem/__tests__/agentPluginConformance.test.ts | grep -c ajv # ≥1 (Task 5)
git show origin/main:packages/archive/src/agentPlugin.ts | grep -c readAgentPlugin  # ≥1 (Task 6)
```
Every command must print ≥ 1. If any commit was dropped (this repo has been bitten twice), the work is safe on the local branch: `git rebase origin/main` (merged commits auto-skip) → fresh branch → new PR.
