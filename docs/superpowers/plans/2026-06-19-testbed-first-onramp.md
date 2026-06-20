# Testbed-first On-ramp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a local `.claude/` testbed project the canonical authoring surface — scaffold it, import global config into it (with real secrets, so it runs), then package → workspace → target → deploy through the existing pipeline.

**Architecture:** One net-new core module (`src/gem/testbed.ts`) is the inverse of `introspect.ts`: it scaffolds a `.claude/` skeleton and merges selected *global* artifacts into it. MCP/hook secrets are obtained by re-introspecting global config in an un-redacted mode (`introspectConfig({ redact:false })`) and copied verbatim into the local testbed only. Packaging reuses `buildGem`'s existing project-namespaced selection — no new packaging code. Two thin controller endpoints expose scaffold + import; the UI flips its on-ramp to be testbed-first.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Zod schemas, `@agentback` REST/OpenAPI decorators, Vitest, supertest. Plain HTML/CSS/JS frontend (no framework) in `src/public/index.html`.

## Global Constraints

- ESM throughout: every local import uses a `.js` suffix (e.g. `import { x } from "./redact.js"`).
- Tests run via compiled dist: `npm test` = `tsc -b && vitest run`. After any file rename/move, run `npm run clean` before testing (see [[test-setup-runs-compiled-dist]]).
- **Secret invariant:** raw secret values may be written ONLY into the local testbed `.claude/`. They must never appear in a Gem, archive, workspace, materialize output, or any HTTP response body. Every secret-touching task includes a `not.toContain(rawValue)` assertion on the downstream Gem.
- Redaction default is unchanged: `introspectConfig()` and `introspectProject()` redact by default; only an explicit `redact:false` opt-in returns raw config, and only `testbed.ts` uses it.
- Follow existing controller patterns: Zod request/response schemas in `src/schemas.ts`, decorator methods in `src/gem.controller.ts`, `resolveDirs(dir)` / `resolveProject(root)` for path canonicalization.
- Frequent commits: one per task.

---

## File Structure

- **Create** `src/gem/testbed.ts` — `scaffoldTestbed`, `importArtifacts`, internal merge helpers. The inverse of `introspect.ts`. Owns its own disk I/O (it must read-merge-write existing testbed files).
- **Create** `src/gem/__tests__/testbed.test.ts` — unit tests for scaffold + import + the secret-containment round-trip.
- **Modify** `src/gem/introspect.ts` — add an opt-in `redact?: boolean` (default true) to `introspectConfig` and the two shared helpers, so the writer can obtain raw global config.
- **Modify** `src/schemas.ts` — add `TestbedImportSelectionSchema`, `TestbedScaffoldRequestSchema`, `TestbedScaffoldResponseSchema`, `TestbedImportRequestSchema`, `TestbedImportResponseSchema`.
- **Modify** `src/gem.controller.ts` — add `POST /api/testbed/scaffold` and `POST /api/testbed/import`.
- **Modify** `src/__tests__/gem.controller.test.ts` — endpoint tests.
- **Modify** `src/public/index.html` — testbed-first UI (Tasks 6–8).

---

## Task 1: Un-redacted introspection opt-in

**Files:**
- Modify: `src/gem/introspect.ts` (`IntrospectOptions`, `serversToArtifacts`, `hooksFromConfig`, `introspectConfig`)
- Test: `src/gem/__tests__/introspect.redact.test.ts` (Create)

**Interfaces:**
- Consumes: existing `introspectConfig(opts: IntrospectOptions)`.
- Produces: `introspectConfig({ ...dirs, redact: false }): ConfigInventory` whose `mcpServers[i].config` and `hooks[i].config` retain raw secret values and whose `secretRefs` is `undefined`. Default (no flag / `redact:true`) is unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/introspect.redact.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { introspectConfig } from "../introspect.js";

let claudeDir: string;
beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "cfg-"));
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
    mcpServers: { gh: { command: "npx", env: { GH_TOKEN: "ghp_realsecretvalue" } } },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./g.sh" }] }] },
  }));
});
afterEach(() => rmSync(claudeDir, { recursive: true, force: true }));

describe("introspectConfig redact option", () => {
  it("redacts by default", () => {
    const inv = introspectConfig({ claudeDir });
    expect((inv.mcpServers[0].config.env as Record<string, string>).GH_TOKEN).toBe("<redacted>");
    expect(inv.mcpServers[0].secretRefs?.length).toBeGreaterThan(0);
  });

  it("returns raw config when redact:false", () => {
    const inv = introspectConfig({ claudeDir, redact: false });
    expect((inv.mcpServers[0].config.env as Record<string, string>).GH_TOKEN).toBe("ghp_realsecretvalue");
    expect(inv.mcpServers[0].secretRefs).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run introspect.redact`
Expected: FAIL — second test sees `<redacted>` (redact flag not yet honored).

- [ ] **Step 3: Implement the opt-in**

In `src/gem/introspect.ts`:

Add `redact` to the options type:

```ts
export interface IntrospectOptions {
  claudeDir?: string;
  agentDir?: string;
  codexDir?: string;
  hermesDir?: string;
  redact?: boolean; // default true; false yields raw config (writer-only)
}
```

Thread `redact` through the two helpers (default `true` preserves all existing callers, incl. `introspectProject`):

```ts
function serversToArtifacts(servers: Record<string, unknown>, source: string, redact = true): McpServerArtifact[] {
  return Object.entries(servers).map(([name, cfg]) => {
    const config = isObj(cfg) ? cfg : {};
    if (!redact) return { type: "mcp_server", name, transport: inferTransport(config), config, source };
    const { config: redacted, secrets } = redactMcpConfig(config);
    return { type: "mcp_server", name, transport: inferTransport(config), config: redacted, source, secretRefs: secrets };
  });
}

function hooksFromConfig(parsed: unknown, source: string, redact = true): HookArtifact[] {
  const out: HookArtifact[] = [];
  if (!isObj(parsed) || !isObj(parsed.hooks)) return out;
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!isObj(g)) continue;
      const matcher = typeof g.matcher === "string" && g.matcher.length ? g.matcher : undefined;
      if (!redact) { out.push({ type: "hook", name: `${event}${matcher ? ` · ${matcher}` : ""}`, event, matcher, config: g, source }); continue; }
      const { config: redacted, secrets } = redactMcpConfig(g);
      out.push({ type: "hook", name: `${event}${matcher ? ` · ${matcher}` : ""}`, event, matcher, config: redacted, source, secretRefs: secrets });
    }
  }
  return out;
}
```

In `introspectConfig`, read the flag and pass it to every `serversToArtifacts(...)` and `hooksFromConfig(...)` call:

```ts
export function introspectConfig(opts: IntrospectOptions = {}): ConfigInventory {
  const redact = opts.redact ?? true;
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  // …unchanged dir resolution…
```

Then update each call site inside `introspectConfig`, e.g.:

```ts
mcpList.push(...serversToArtifacts(settings.mcpServers, "user", redact));
mcpList.push(...serversToArtifacts(serversFromMcpJson(readJson(join(claudeDir, ".mcp.json"))), "user", redact));
hookList.push(...hooksFromConfig(settings, "user", redact));
// …and the plugin loop:
mcpList.push(...serversToArtifacts(serversFromMcpJson(readJson(join(installPath, ".mcp.json"))), source, redact));
hookList.push(...hooksFromConfig(readJson(join(installPath, "hooks", "hooks.json")), source, redact));
```

(Leave `introspectProject` untouched — it keeps the default-redact helper calls.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run clean && npx vitest run introspect.redact`
Expected: PASS (both tests).

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `npm test`
Expected: PASS (existing introspect/controller tests still redact by default).

- [ ] **Step 6: Commit**

```bash
git add src/gem/introspect.ts src/gem/__tests__/introspect.redact.test.ts
git commit -m "feat(introspect): opt-in redact:false for raw global config (writer-only)"
```

---

## Task 2: `scaffoldTestbed`

**Files:**
- Create: `src/gem/testbed.ts`
- Test: `src/gem/__tests__/testbed.test.ts`

**Interfaces:**
- Produces: `scaffoldTestbed(root: string, name: string): { root: string; created: string[] }` — creates a minimal runnable `.claude/` skeleton under `root`, only writing files that don't already exist (idempotent). `created` lists POSIX-relative paths actually written.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/testbed.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldTestbed } from "../testbed.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "tb-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("scaffoldTestbed", () => {
  it("creates a runnable .claude skeleton with a secret-containing .gitignore", () => {
    const r = scaffoldTestbed(root, "research-agent");
    expect(r.root).toBe(root);
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(root, ".claude", "skills"))).toBe(true);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# research-agent\n");
    const gi = readFileSync(join(root, ".gitignore"), "utf8");
    expect(gi).toContain(".mcp.json");
    expect(gi).toContain(".claude/settings.json");
    expect(gi).toContain(".env");
    expect(r.created).toContain("CLAUDE.md");
  });

  it("is idempotent — never clobbers existing files", () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "# hand-edited\n");
    const r = scaffoldTestbed(root, "x");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("# hand-edited\n");
    expect(r.created).not.toContain("CLAUDE.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run testbed`
Expected: FAIL with "Cannot find module '../testbed.js'".

- [ ] **Step 3: Write minimal implementation**

Create `src/gem/testbed.ts`:

```ts
// src/gem/testbed.ts
// The inverse of introspect.ts: scaffold a runnable .claude/ testbed and merge selected
// GLOBAL artifacts into it. MCP/hook secrets are copied verbatim from raw global config into
// the LOCAL testbed only (never into a Gem). Owns its own read-merge-write disk I/O.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function writeIfAbsent(root: string, rel: string, content: string, created: string[]): void {
  const abs = join(root, rel);
  if (existsSync(abs)) return;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  created.push(rel);
}

export function scaffoldTestbed(root: string, name: string): { root: string; created: string[] } {
  const created: string[] = [];
  mkdirSync(join(root, ".claude", "skills"), { recursive: true });
  writeIfAbsent(root, ".claude/settings.json", "{}\n", created);
  writeIfAbsent(root, "CLAUDE.md", `# ${name}\n`, created);
  writeIfAbsent(root, ".gitignore", ".mcp.json\n.claude/settings.json\n.env\n.targets/\n", created);
  return { root, created };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run clean && npx vitest run testbed`
Expected: PASS (both scaffold tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/testbed.ts src/gem/__tests__/testbed.test.ts
git commit -m "feat(testbed): scaffoldTestbed — runnable .claude skeleton + secret .gitignore"
```

---

## Task 3: `importArtifacts` — skills + instructions

**Files:**
- Modify: `src/gem/testbed.ts`
- Test: `src/gem/__tests__/testbed.test.ts`

**Interfaces:**
- Consumes: `ConfigInventory` (from `./types.js`).
- Produces:
  - `interface ImportedRef { type: "skill" | "mcp_server" | "instructions" | "hook"; name: string; overwritten: boolean }`
  - `interface ImportSkip { artifact: string; reason: string }`
  - `interface ImportSelection { skills?: string[]; mcpServers?: string[]; hooks?: string[]; includeInstructions?: boolean }`
  - `importArtifacts(root: string, selection: ImportSelection, rawInv: ConfigInventory): { written: ImportedRef[]; skipped: ImportSkip[] }`
  - This task implements the `skills` and `includeInstructions` branches only; `mcpServers`/`hooks` are added in Task 4.

- [ ] **Step 1: Write the failing test**

Append to `src/gem/__tests__/testbed.test.ts`:

```ts
import { importArtifacts } from "../testbed.js";
import type { ConfigInventory } from "../types.js";

function inv(partial: Partial<ConfigInventory>): ConfigInventory {
  return { skills: [], mcpServers: [], instructions: [], hooks: [], ...partial };
}

describe("importArtifacts — skills + instructions", () => {
  it("writes a selected skill verbatim into .claude/skills/<n>/SKILL.md", () => {
    scaffoldTestbed(root, "x");
    const rawInv = inv({ skills: [{ type: "skill", name: "scrape", description: "d", source: "standalone", content: "---\nname: scrape\n---\nbody" }] });
    const r = importArtifacts(root, { skills: ["scrape"] }, rawInv);
    expect(readFileSync(join(root, ".claude", "skills", "scrape", "SKILL.md"), "utf8")).toContain("body");
    expect(r.written).toContainEqual({ type: "skill", name: "scrape", overwritten: false });
  });

  it("appends instructions under an idempotent marker (re-import replaces, not duplicates)", () => {
    scaffoldTestbed(root, "x");
    const rawInv = inv({ instructions: [{ type: "instructions", name: "CLAUDE.md", content: "GLOBAL RULES" }] });
    importArtifacts(root, { includeInstructions: true }, rawInv);
    importArtifacts(root, { includeInstructions: true }, rawInv); // twice
    const body = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(body).toContain("GLOBAL RULES");
    expect(body.match(/agentgem:imported CLAUDE.md/g)?.length).toBe(1); // one block, not two
  });

  it("reports a missing skill in skipped", () => {
    scaffoldTestbed(root, "x");
    const r = importArtifacts(root, { skills: ["nope"] }, inv({}));
    expect(r.skipped).toContainEqual({ artifact: "nope", reason: "not found in global inventory" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run testbed`
Expected: FAIL with "importArtifacts is not a function" / not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/gem/testbed.ts`:

```ts
import type { ConfigInventory } from "./types.js";

export interface ImportedRef { type: "skill" | "mcp_server" | "instructions" | "hook"; name: string; overwritten: boolean }
export interface ImportSkip { artifact: string; reason: string }
export interface ImportSelection { skills?: string[]; mcpServers?: string[]; hooks?: string[]; includeInstructions?: boolean }

function marker(name: string): { open: string; close: string } {
  return { open: `<!-- agentgem:imported ${name} -->`, close: `<!-- /agentgem:imported ${name} -->` };
}

// Replace an existing marked block, else append one. Keeps re-import idempotent.
function upsertMarkedBlock(root: string, rel: string, name: string, content: string): void {
  const abs = join(root, rel);
  const existing = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const { open, close } = marker(name);
  const block = `${open}\n${content}\n${close}`;
  const re = new RegExp(`${open}[\\s\\S]*?${close}`);
  const next = re.test(existing) ? existing.replace(re, block) : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${block}\n`;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, next, "utf8");
}

export function importArtifacts(root: string, selection: ImportSelection, rawInv: ConfigInventory): { written: ImportedRef[]; skipped: ImportSkip[] } {
  const written: ImportedRef[] = [];
  const skipped: ImportSkip[] = [];

  for (const name of selection.skills ?? []) {
    const sk = rawInv.skills.find((s) => s.name === name);
    if (!sk) { skipped.push({ artifact: name, reason: "not found in global inventory" }); continue; }
    const rel = `.claude/skills/${name}/SKILL.md`;
    const overwritten = existsSync(join(root, rel));
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), sk.content, "utf8");
    written.push({ type: "skill", name, overwritten });
  }

  if (selection.includeInstructions) {
    for (const ins of rawInv.instructions) {
      upsertMarkedBlock(root, "CLAUDE.md", ins.name, ins.content);
      written.push({ type: "instructions", name: ins.name, overwritten: false });
    }
  }

  return { written, skipped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run clean && npx vitest run testbed`
Expected: PASS (scaffold + skills/instructions tests).

- [ ] **Step 5: Commit**

```bash
git add src/gem/testbed.ts src/gem/__tests__/testbed.test.ts
git commit -m "feat(testbed): importArtifacts — skills + idempotent instructions import"
```

---

## Task 4: `importArtifacts` — MCP + hooks (raw, merged) + secret containment

**Files:**
- Modify: `src/gem/testbed.ts`
- Test: `src/gem/__tests__/testbed.test.ts`

**Interfaces:**
- Extends `importArtifacts` (Task 3) with the `mcpServers` and `hooks` branches. MCP configs are written to `<root>/.mcp.json` (`{ mcpServers: { … } }`); hook groups are appended to `<root>/.claude/settings.json` `hooks[event]`. Both read raw config from `rawInv` (the caller passes `introspectConfig({ redact:false })`).

- [ ] **Step 1: Write the failing test (incl. the containment round-trip)**

Append to `src/gem/__tests__/testbed.test.ts`:

```ts
import { introspectProject } from "../introspect.js";
import { buildGem } from "../buildGem.js";

describe("importArtifacts — mcp + hooks + containment", () => {
  const rawMcp = inv({ mcpServers: [{ type: "mcp_server", name: "gh", transport: "stdio", config: { command: "npx", env: { GH_TOKEN: "ghp_realsecretvalue" } }, source: "user" }] });

  it("merges raw MCP config into .mcp.json, preserving existing servers", () => {
    scaffoldTestbed(root, "x");
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { keep: { command: "k" } } }));
    const r = importArtifacts(root, { mcpServers: ["gh"] }, rawMcp);
    const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.keep).toBeDefined();                 // existing preserved
    expect(mcp.mcpServers.gh.env.GH_TOKEN).toBe("ghp_realsecretvalue"); // raw, so testbed runs
    expect(r.written).toContainEqual({ type: "mcp_server", name: "gh", overwritten: false });
  });

  it("appends a hook group into settings.json without duplicating on re-import", () => {
    scaffoldTestbed(root, "x");
    const rawHook = inv({ hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { matcher: "Bash", hooks: [{ type: "command", command: "./g.sh" }] }, source: "user" }] });
    importArtifacts(root, { hooks: ["PreToolUse · Bash"] }, rawHook);
    importArtifacts(root, { hooks: ["PreToolUse · Bash"] }, rawHook); // twice
    const s = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    expect(s.hooks.PreToolUse).toHaveLength(1); // deduped
  });

  it("CONTAINMENT: raw secret in testbed, but the packaged Gem is redacted", () => {
    scaffoldTestbed(root, "x");
    importArtifacts(root, { mcpServers: ["gh"] }, rawMcp);
    // package the testbed: introspectProject redacts again
    const proj = introspectProject(root);
    const gem = buildGem({ skills: [], mcpServers: [], instructions: [], hooks: [], projects: [proj] },
      { projects: { [root]: { mcpServers: ["gh"] } } }, { name: "g" });
    expect(JSON.stringify(gem)).not.toContain("ghp_realsecretvalue"); // never leaks into the Gem
    expect(gem.requiredSecrets).toContainEqual({ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run testbed`
Expected: FAIL — MCP/hook branches not implemented; `.mcp.json` has no `gh`.

- [ ] **Step 3: Write minimal implementation**

Add JSON helpers and the two branches to `src/gem/testbed.ts`. Add near the top:

```ts
function readJson(abs: string): Record<string, unknown> {
  try { const v = JSON.parse(readFileSync(abs, "utf8")); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
  catch { return {}; }
}
function writeJson(abs: string, obj: unknown): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
```

Then add these branches inside `importArtifacts`, before the final `return`:

```ts
  for (const name of selection.mcpServers ?? []) {
    const m = rawInv.mcpServers.find((s) => s.name === name);
    if (!m) { skipped.push({ artifact: name, reason: "not found in global inventory" }); continue; }
    const abs = join(root, ".mcp.json");
    const doc = readJson(abs);
    const servers = (doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {}) as Record<string, unknown>;
    const overwritten = name in servers;
    servers[name] = m.config; // raw config — local testbed only
    doc.mcpServers = servers;
    writeJson(abs, doc);
    written.push({ type: "mcp_server", name, overwritten });
  }

  for (const name of selection.hooks ?? []) {
    const h = rawInv.hooks.find((x) => x.name === name);
    if (!h) { skipped.push({ artifact: name, reason: "not found in global inventory" }); continue; }
    const abs = join(root, ".claude", "settings.json");
    const doc = readJson(abs);
    const hooks = (doc.hooks && typeof doc.hooks === "object" ? doc.hooks : {}) as Record<string, unknown[]>;
    const groups = Array.isArray(hooks[h.event]) ? hooks[h.event] : [];
    const exists = groups.some((g) => JSON.stringify(g) === JSON.stringify(h.config));
    if (!exists) groups.push(h.config);
    hooks[h.event] = groups;
    doc.hooks = hooks;
    writeJson(abs, doc);
    written.push({ type: "hook", name, overwritten: exists });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run clean && npx vitest run testbed`
Expected: PASS — including the CONTAINMENT test (Gem redacted, `requiredSecrets` declared).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/gem/testbed.ts src/gem/__tests__/testbed.test.ts
git commit -m "feat(testbed): import raw MCP/hooks into testbed; prove Gem stays redacted"
```

---

## Task 5: Controller endpoints + schemas

**Files:**
- Modify: `src/schemas.ts`
- Modify: `src/gem.controller.ts`
- Test: `src/__tests__/gem.controller.test.ts`

**Interfaces:**
- Consumes: `scaffoldTestbed`, `importArtifacts`, `ImportSelection` from `./gem/testbed.js`; `introspectConfig` (with `redact:false`); `resolveDirs`, `resolveProject`.
- Produces two endpoints:
  - `POST /api/testbed/scaffold` body `{ root: string; name: string }` → `{ root: string; created: string[] }`
  - `POST /api/testbed/import` body `{ root: string; selection: ImportSelection; dir?: string }` → `{ written: ImportedRef[]; skipped: ImportSkip[] }`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/gem.controller.test.ts` a new `describe` block:

```ts
describe("testbed ops", () => {
  it("scaffold then import (raw MCP) — testbed runs, packaged gem stays redacted", async () => {
    const tb = mkdtempSync(join(tmpdir(), "tb-"));
    try {
      const sc = await client.post("/api/testbed/scaffold").send({ root: tb, name: "agent" }).expect(200);
      expect(sc.body.created).toContain("CLAUDE.md");

      // `dir` points at the global config fixture built in beforeAll (has mcp `gh` with ghp_secret)
      const im = await client.post("/api/testbed/import")
        .send({ root: tb, dir, selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true } })
        .expect(200);
      expect(im.body.written.map((w: { name: string }) => w.name).sort()).toContain("gh");

      // testbed .mcp.json holds the RAW secret (so `claude` runs there)
      const mcp = JSON.parse(readFileSync(join(tb, ".mcp.json"), "utf8"));
      expect(mcp.mcpServers.gh.env.GH_TOKEN).toBe("ghp_secret");

      // but packaging the testbed yields a redacted gem
      const g = await client.post("/api/gem")
        .send({ projects: [tb], selection: { projects: { [tb]: { skills: ["review"], mcpServers: ["gh"] } } }, name: "p" })
        .expect(200);
      expect(JSON.stringify(g.body)).not.toContain("ghp_secret");
      expect(g.body.requiredSecrets).toContainEqual({ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" });
    } finally {
      rmSync(tb, { recursive: true, force: true });
    }
  });
});
```

(Note: `readFileSync` is already imported at the top of the test file? It imports `writeFileSync, mkdirSync` — add `readFileSync` to that import line in this step.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run clean && npx tsc -b && npx vitest run gem.controller`
Expected: FAIL — 404 on `/api/testbed/scaffold` (route not registered).

- [ ] **Step 3: Add schemas**

Append to `src/schemas.ts`:

```ts
// ── Testbed (testbed-first on-ramp) ──
export const TestbedImportSelectionSchema = z.object({
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  hooks: z.array(z.string()).optional(),
  includeInstructions: z.boolean().optional(),
});
export const TestbedScaffoldRequestSchema = z.object({ root: z.string(), name: z.string() });
export const TestbedScaffoldResponseSchema = z.object({ root: z.string(), created: z.array(z.string()) });
export const TestbedImportRequestSchema = z.object({
  root: z.string(),
  selection: TestbedImportSelectionSchema,
  dir: z.string().optional(),
});
const ImportedRefSchema = z.object({
  type: z.enum(["skill", "mcp_server", "instructions", "hook"]),
  name: z.string(),
  overwritten: z.boolean(),
});
export const TestbedImportResponseSchema = z.object({
  written: z.array(ImportedRefSchema),
  skipped: z.array(z.object({ artifact: z.string(), reason: z.string() })),
});
```

- [ ] **Step 4: Add endpoints**

In `src/gem.controller.ts`, add imports:

```ts
import { scaffoldTestbed, importArtifacts } from "./gem/testbed.js";
import {
  TestbedScaffoldRequestSchema, TestbedScaffoldResponseSchema,
  TestbedImportRequestSchema, TestbedImportResponseSchema,
} from "./schemas.js";
```

(Merge these names into the existing `./schemas.js` import block rather than adding a duplicate import statement.)

Add two methods inside the `GemController` class:

```ts
  @post("/testbed/scaffold", { body: TestbedScaffoldRequestSchema, response: TestbedScaffoldResponseSchema })
  async scaffoldTestbed(input: { body: z.infer<typeof TestbedScaffoldRequestSchema> }): Promise<z.infer<typeof TestbedScaffoldResponseSchema>> {
    return scaffoldTestbed(resolveProject(input.body.root), input.body.name);
  }

  @post("/testbed/import", { body: TestbedImportRequestSchema, response: TestbedImportResponseSchema })
  async importTestbed(input: { body: z.infer<typeof TestbedImportRequestSchema> }): Promise<z.infer<typeof TestbedImportResponseSchema>> {
    const rawInv = introspectConfig({ ...resolveDirs(input.body.dir), redact: false });
    return importArtifacts(resolveProject(input.body.root), input.body.selection, rawInv);
  }
```

(`introspectConfig`, `resolveDirs`, `resolveProject` are already imported in this file.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run clean && npx vitest run gem.controller`
Expected: PASS (testbed ops block).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/gem.controller.ts src/__tests__/gem.controller.test.ts
git commit -m "feat(api): /testbed/scaffold + /testbed/import endpoints"
```

---

## Task 6: UI — testbed state, header chip, empty state, project-scoped load

**Files:**
- Modify: `src/public/index.html` (header markup; `load()` and top-of-`<script>` state)

**Interfaces:**
- Consumes: `GET /api/inventory?projects=[root]` (existing), `GET /api/pick-folder` (existing), `POST /api/testbed/scaffold` (Task 5).
- Produces: a global `activeTestbed` (string path | null) persisted in `localStorage["agentgem.testbed"]`; the left pane renders the active testbed's inventory (project groups only) or an empty state when none is set.

- [ ] **Step 1: Add testbed state + header chip**

In `src/public/index.html`, replace the `<span class="muted">introspecting …</span>` line inside `<header>` with a testbed chip container:

```html
  <span class="tag">Gem Builder</span>
  <span class="spacer" style="flex:1"></span>
  <span id="testbedChip" class="testbed-chip"></span>
```

Add chip styles to the `<style>` block (after the `header .muted` rule):

```css
  .spacer{flex:1}
  .testbed-chip{display:flex;align-items:center;gap:9px;background:var(--card);border:1px solid var(--line);border-radius:99px;padding:6px 8px 6px 13px;box-shadow:var(--shadow);font-size:12.5px}
  .testbed-chip .path{font-family:var(--mono);color:var(--ink-2);font-size:12px}
  .testbed-chip .path b{color:var(--ink)}
  .testbed-chip button{font:600 11px/1 var(--ui);padding:5px 10px;border-radius:99px}
```

- [ ] **Step 2: Add testbed state + render at top of `<script>`**

Immediately after `let inv = …;` near the top of the `<script>` block, add:

```js
let activeTestbed = localStorage.getItem("agentgem.testbed") || null;
function setTestbed(path){ activeTestbed = path || null; if(path) localStorage.setItem("agentgem.testbed", path); else localStorage.removeItem("agentgem.testbed"); renderTestbedChip(); }
function renderTestbedChip(){
  const el = document.getElementById("testbedChip");
  if(!activeTestbed){ el.innerHTML = `<button id="tbNew">Create / open testbed…</button>`; document.getElementById("tbNew").onclick = openOrCreateTestbed; return; }
  const short = activeTestbed.replace(/^.*\//, "");
  el.innerHTML = `<span class="path">📁 <b>${esc(short)}</b></span><button id="tbSwap" class="ghost">Switch</button>`;
  document.getElementById("tbSwap").onclick = openOrCreateTestbed;
}
async function openOrCreateTestbed(){
  const pick = await (await fetch("/api/pick-folder")).json();
  if(!pick.path) return;
  const name = prompt("Testbed agent name", pick.path.replace(/^.*\//, "")) || pick.path.replace(/^.*\//, "");
  await fetch("/api/testbed/scaffold", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ root: pick.path, name }) });
  setTestbed(pick.path);
  load();
}
```

- [ ] **Step 3: Make `load()` testbed-scoped**

Replace the body of `load()` so it reads the active testbed (and shows an empty state otherwise). Change the first lines of `load()`:

```js
async function load() {
  renderTestbedChip();
  if (!activeTestbed) {
    document.getElementById("inventory").innerHTML =
      `<div class="group"><h2>No testbed</h2><p class="note">Create or open a testbed project to author and test-drive an agent, then package it into a gem. Use <b>Create / open testbed…</b> in the top bar.</p></div>`;
    return;
  }
  projects = [activeTestbed];
  const qs = `?projects=${encodeURIComponent(JSON.stringify(projects))}`;
  inv = await (await fetch("/api/inventory" + qs)).json();
  inv.projects = inv.projects || [];
  // Render ONLY the active testbed's project groups (global groups are reached via Import).
  const proj = inv.projects.find(p => p.root === activeTestbed) || { root: activeTestbed, name: activeTestbed.replace(/^.*\//, ""), skills: [], mcpServers: [], instructions: [], hooks: [] };
  let html = group("Skills", proj.skills, "projectSkills", proj.root)
           + group("MCP servers", proj.mcpServers, "projectMcpServers", proj.root)
           + group("Hooks", proj.hooks, "projectHooks", proj.root);
  if (proj.instructions.length) {
    const pil = esc(proj.instructions.map(x => x.name).join(", "));
    html += `<div class="group"><h2>Instructions</h2><label class="row" data-source="project" data-agent="project" data-type="instructions" data-project="${esc(proj.root)}"><input type="checkbox" data-kind="projectInstructions" data-project="${esc(proj.root)}"> <span><span class="src">project</span> ${pil}</span><button type="button" class="view" data-kind="projectInstructions" data-name="" data-project="${esc(proj.root)}" title="view content">view</button></label></div>`;
  }
  document.getElementById("inventory").innerHTML = html;
  document.querySelectorAll("#inventory label.row").forEach(row => {
    const cb = row.querySelector("input[type=checkbox]");
    row._hay = hayForRow(cb && cb.dataset.kind, cb && cb.dataset.name, cb && cb.dataset.project).toLowerCase();
  });
  populateSources(); populateAgents(); populateTypes(); renderProjectBar();
  document.querySelectorAll('#inventory input[type=checkbox]').forEach(cb => cb.addEventListener("change", onToggle));
  restoreChecks();
  refresh();
}
```

- [ ] **Step 4: Verify manually (server + browser)**

```bash
npm run build && PORT=4319 node dist/index.js &
```
Then drive it:
```bash
browser-harness <<'PY'
import time
new_tab("http://127.0.0.1:4319/"); wait_for_load(); time.sleep(1.5)
capture_screenshot(path="/tmp/tb_empty.png")
print(js("document.getElementById('inventory').innerText.slice(0,40)"))
PY
```
Expected: the inventory shows the "No testbed" empty state; the header chip shows "Create / open testbed…". Stop the server with `kill %1` when done.

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git commit -m "feat(ui): testbed-first on-ramp — chip, empty state, project-scoped inventory"
```

---

## Task 7: UI — "Import from machine" modal

**Files:**
- Modify: `src/public/index.html` (new import modal + global inventory fetch + wire `/api/testbed/import`)

**Interfaces:**
- Consumes: `GET /api/inventory` (no `projects` → global), `POST /api/testbed/import`.
- Produces: an `#importModal` that lists global skills/mcp/hooks/instructions with checkboxes; "Add to testbed" posts the selection and reloads.

- [ ] **Step 1: Add the Import button + modal markup**

Add an Import button to the left pane. Just before `<div id="inventory">`, insert:

```html
    <div class="bar"><button id="importBtn" class="ghost">⬇ Import from machine…</button><span class="d" id="importStatus" style="margin-left:8px"></span></div>
```

Add the modal near the existing `#modal` (after it):

```html
<div id="importModal" class="modal-bg" hidden>
  <div class="modal">
    <div class="modal-h"><strong class="t">Import from machine</strong><span class="src">~/.claude · ~/.agents · ~/.codex · ~/.hermes</span><button id="importClose" class="ghost" style="margin-left:auto">✕ Close</button></div>
    <div class="modal-body" style="padding:14px"><div id="importInventory">Loading…</div></div>
    <div class="modal-h" style="border-top:1px solid var(--line);border-bottom:0">
      <span class="d">Writes real secrets into this testbed so it runs — don't commit <code>.mcp.json</code>/<code>settings.json</code>.</span>
      <button id="importApply" style="margin-left:auto">Add to testbed</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Wire the modal logic**

Add to the `<script>` block:

```js
const importSel = { skills: new Set(), mcpServers: new Set(), hooks: new Set(), includeInstructions: false };
async function openImport(){
  if(!activeTestbed){ alert("Create or open a testbed first."); return; }
  importSel.skills.clear(); importSel.mcpServers.clear(); importSel.hooks.clear(); importSel.includeInstructions = false;
  document.getElementById("importModal").hidden = false;
  const gi = await (await fetch("/api/inventory")).json();
  const grp = (title, items, kind) => items.length ? `<div class="group"><h2>${title}</h2>` + items.map(it =>
    `<label class="row"><input type="checkbox" data-ikind="${kind}" data-name="${esc(it.name)}"> <span>${esc(it.name)}${it.source?` <span class="src">${esc(it.source)}</span>`:""}${(it.description||it.transport)?` <span class="d">— ${esc(it.description||it.transport)}</span>`:""}</span></label>`).join("") + `</div>` : "";
  let h = grp("Skills", gi.skills, "skills") + grp("MCP servers", gi.mcpServers, "mcpServers") + grp("Hooks", gi.hooks, "hooks");
  if(gi.instructions.length) h += `<div class="group"><h2>Instructions</h2><label class="row"><input type="checkbox" data-ikind="instructions"> <span>${esc(gi.instructions.map(i=>i.name).join(", "))}</span></label></div>`;
  document.getElementById("importInventory").innerHTML = h;
  document.querySelectorAll('#importInventory input[type=checkbox]').forEach(cb => cb.addEventListener("change", e => {
    const k = e.target.dataset.ikind, n = e.target.dataset.name;
    if(k === "instructions"){ importSel.includeInstructions = e.target.checked; return; }
    const set = importSel[k]; if(e.target.checked) set.add(n); else set.delete(n);
  }));
}
async function applyImport(){
  const selection = { skills:[...importSel.skills], mcpServers:[...importSel.mcpServers], hooks:[...importSel.hooks], includeInstructions: importSel.includeInstructions };
  const r = await (await fetch("/api/testbed/import", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ root: activeTestbed, selection }) })).json();
  document.getElementById("importModal").hidden = true;
  document.getElementById("importStatus").textContent = `Imported ${r.written.length}${r.skipped.length?` · skipped ${r.skipped.length}`:""}`;
  load();
}
document.getElementById("importBtn").onclick = openImport;
document.getElementById("importClose").onclick = () => document.getElementById("importModal").hidden = true;
document.getElementById("importApply").onclick = applyImport;
```

- [ ] **Step 3: Verify manually**

```bash
npm run build && PORT=4319 node dist/index.js &
```
```bash
browser-harness <<'PY'
import time
new_tab("http://127.0.0.1:4319/"); wait_for_load(); time.sleep(1.2)
print("has import btn:", js("!!document.getElementById('importBtn')"))
PY
```
Expected: `has import btn: True`. (Full import flow needs an active testbed; exercise it by creating one against a temp folder, opening Import, checking a skill, clicking "Add to testbed", and confirming it appears in the left inventory.) Stop the server when done.

- [ ] **Step 4: Commit**

```bash
git add src/public/index.html
git commit -m "feat(ui): Import-from-machine modal writes global artifacts into the testbed"
```

---

## Task 8: UI — test-drive card + package-from-testbed

**Files:**
- Modify: `src/public/index.html` (test-drive card; ensure packaging/workspace uses the testbed selection)

**Interfaces:**
- Consumes: the existing workspace/materialize/archive flows (they already accept `projects` + project-namespaced `selection`).
- Produces: a test-drive card showing `cd <root> && claude` with a copy button; packaging from the testbed already works because `projects=[activeTestbed]` and selection uses `project*` kinds (set in Task 6).

- [ ] **Step 1: Add the test-drive card**

After the `<div id="inventory">…</div>` in the left pane, add:

```html
    <div id="testdrive" class="testdrive" hidden>
      <div class="hd">▶ Test-drive this agent <span class="pill">Claude Code</span></div>
      <div class="cmd"><span class="dollar">$</span> <code id="tdCmd"></code> <button id="tdCopy" class="ghost">Copy</button></div>
      <div class="ft">Runs your real harness in the testbed. Imported secrets are live there; the packaged gem stays redacted.</div>
    </div>
```

Add styles:

```css
  .testdrive{margin-top:18px;border:1px solid var(--line);border-radius:var(--r);background:var(--card);overflow:hidden;box-shadow:var(--shadow)}
  .testdrive .hd{display:flex;align-items:center;gap:9px;padding:11px 14px;border-bottom:1px solid var(--line);background:var(--paper-2);font-family:var(--display);font-weight:600}
  .testdrive .pill{margin-left:auto;font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--gem);background:var(--gem-soft);padding:3px 8px;border-radius:99px}
  .testdrive .cmd{display:flex;align-items:center;gap:10px;padding:12px 14px;font-family:var(--mono);font-size:12.5px}
  .testdrive .cmd .dollar{color:var(--accent);font-weight:600}.testdrive .cmd code{flex:1}
  .testdrive .ft{padding:0 14px 12px;color:var(--muted);font-size:11.5px}
```

- [ ] **Step 2: Wire the card (show when a testbed is active)**

Add to the `<script>` block, and call `renderTestDrive()` at the end of `load()`:

```js
function renderTestDrive(){
  const card = document.getElementById("testdrive");
  if(!activeTestbed){ card.hidden = true; return; }
  card.hidden = false;
  document.getElementById("tdCmd").textContent = `cd ${activeTestbed} && claude`;
}
document.getElementById("tdCopy").onclick = () => {
  navigator.clipboard?.writeText(`cd ${activeTestbed} && claude`);
  const b = document.getElementById("tdCopy"); b.textContent = "Copied ✓"; setTimeout(()=>b.textContent="Copy", 1400);
};
```

Add `renderTestDrive();` as the last line inside `load()` (after `refresh();`).

- [ ] **Step 3: Confirm packaging uses the testbed selection**

No code change expected — verify by reading: in Task 6 `load()` sets `projects = [activeTestbed]` and renders rows with `projectSkills`/`projectMcpServers`/`projectHooks`/`projectInstructions` kinds, which `onToggle`/`refresh` already route into `sel.projects[root]`. The existing "New workspace…", target, and archive buttons send `projects` + `selection` unchanged. If `refresh()`/`currentSelection()` hardcodes global kinds only, update it to include `sel.projects`; otherwise leave as-is.

- [ ] **Step 4: Verify manually (full loop)**

```bash
npm run build && PORT=4319 node dist/index.js &
```
```bash
browser-harness <<'PY'
import time
new_tab("http://127.0.0.1:4319/"); wait_for_load(); time.sleep(1.2)
# create a testbed against a temp dir via the chip flow is interactive; instead assert card wiring exists
print("testdrive el:", js("!!document.getElementById('testdrive')"))
PY
```
Expected: `testdrive el: True`. Then manually: create a testbed, import a skill, confirm the test-drive card shows `cd <path> && claude`, copy works, and "New workspace…" creates a workspace from the testbed selection. Stop the server when done.

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git commit -m "feat(ui): test-drive handoff card; package gem from the active testbed"
```

---

## Self-Review

**1. Spec coverage**
- §2 writer (scaffold + import, 4 types, merge, idempotency, source via raw introspection) → Tasks 1–4.
- §2 secret re-read raw → Task 1 (`redact:false`) + Task 4 (raw MCP/hook write).
- §3 endpoints (`/testbed/scaffold`, `/testbed/import`) + reuse of `/inventory`/`/gem`/workspaces → Task 5 (+ Task 8 step 3 confirms packaging reuse).
- §3 client-side tracking (`localStorage`) → Task 6.
- §4 UI: empty state, header chip, project-scoped pane, Import modal, test-drive card → Tasks 6–8. (Stage rail + certificate composition are §4 "deferred"/§8 out-of-scope — intentionally not tasked.)
- §6 secret containment (`.gitignore` + UI warning) → Task 2 (`.gitignore`) + Task 7 (warning copy).
- §7 testing: containment round-trip → Task 4 step 1 + Task 5 step 1; per-type merge/idempotency → Tasks 3–4; controller tests → Task 5; dist-clean discipline → every test step uses `npm run clean`.

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output. Task 8 step 3 is a *conditional verify-then-maybe-edit* with the exact condition stated (it is a real review step, not a placeholder).

**3. Type consistency:** `ImportSelection`/`ImportedRef`/`ImportSkip` defined in Task 3, consumed unchanged in Tasks 4–5; `scaffoldTestbed(root, name)` and `importArtifacts(root, selection, rawInv)` signatures identical across Tasks 2–5; schema field names (`root`, `name`, `selection`, `dir`, `written`, `skipped`, `created`) match the endpoint bodies in Task 5 and the UI fetches in Tasks 6–8; `redact` option name consistent between Task 1 and Task 5.

**Note on the stage rail:** the spec (§4) makes the rail "go live," but doing so depends on the certificate composition and is intertwined with deeper `#preview` JS. To keep this plan shippable and independently testable, the rail/certificate composition is left as a follow-up (consistent with §8). The functional testbed-first loop (scaffold → import → test-drive → package → workspace → deploy) is fully delivered by Tasks 1–8.
