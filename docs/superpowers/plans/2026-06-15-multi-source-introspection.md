# Multi-Source Introspection + Search UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agentgem's introspection multi-source — fold plugin-bundled skills + MCP servers and a generic `~/.agent/skills` path into the inventory, each tagged by `source` (honoring `metadata.internal`) — then add an all-artifacts search box to the UI.

**Architecture:** `introspectConfig(opts)` runs an ordered list of discovery sources (standalone → user-MCP → enabled-plugins → generic-agent), merges + dedups by name, redacts MCP secrets at capture. Artifacts gain a `source` tag. The web page gains a client-side filter over all rows.

**Tech Stack:** TypeScript (NodeNext, zod v4, AgentBack), vitest from `dist` (`pnpm test` = `tsc -b && vitest run`), vanilla JS page. Project `/Users/rfeng/Projects/ninemind/agentgem`.

**Spec:** `docs/superpowers/specs/2026-06-15-multi-source-introspection-design.md`

> NodeNext: every relative import ends in `.js`. Tests live under `src/**/__tests__/`, run from compiled `dist/`.

---

## File Structure

```
src/gem/types.ts        # MODIFY: SkillArtifact.source widen to string; McpServerArtifact gains source?
src/schemas.ts           # MODIFY: SkillArtifactSchema.source z.string(); McpServerArtifactSchema.source optional
src/gem/introspect.ts   # REWRITE: discovery-sources architecture (standalone/user/plugins/agent) + dedup
src/gem.controller.ts   # MODIFY: introspectConfig({ claudeDir }) call shape
src/gem.tools.ts        # MODIFY: introspectConfig({ claudeDir }) call shape
src/public/index.html    # MODIFY: all-artifacts search box + per-row source tag
```

---

### Task 1: Type + schema changes for `source`

**Files:**
- Modify: `src/gem/types.ts`
- Modify: `src/schemas.ts`

- [ ] **Step 1: Update `src/gem/types.ts`**
- Change `SkillArtifact.source` from the literal to a string:
```typescript
export interface SkillArtifact {
  type: "skill";
  name: string;
  description?: string;
  source: string;        // "standalone" | "agent" | "plugin:<name>@<marketplace>"
  content: string;
}
```
- Add an optional `source` to `McpServerArtifact`:
```typescript
export interface McpServerArtifact {
  type: "mcp_server";
  name: string;
  transport: "stdio" | "http" | "sse";
  config: Record<string, unknown>;
  source?: string;       // "user" | "plugin:<name>@<marketplace>"
}
```
(Leave `InstructionsArtifact`, `PackArtifact`, `ConfigInventory`, `Gem` unchanged.)

- [ ] **Step 2: Update `src/schemas.ts`**
- `SkillArtifactSchema`: change `source: z.literal("standalone")` to `source: z.string()`.
- `McpServerArtifactSchema`: add `source: z.string().optional(),`.

- [ ] **Step 3: Verify** — `pnpm test` (all existing 18 still green: skill literals with `source:"standalone"` validate as `z.string()`; mcp fixtures without `source` validate with the optional field) and `pnpm build` clean.

- [ ] **Step 4: Commit**
```bash
git add src/gem/types.ts src/schemas.ts
git commit -m "feat: source tag on skill/mcp artifacts (widen skill source, add optional mcp source)"
```

---

### Task 2: Rewrite introspectConfig as discovery sources

**Files:**
- Modify: `src/gem/introspect.ts` (full rewrite)
- Modify: `src/gem/__tests__/introspect.test.ts` (adapt existing 3 to the new opts signature + add multi-source tests)

- [ ] **Step 1: Replace `src/gem/__tests__/introspect.test.ts` entirely** with the adapted + new tests:
```typescript
// src/gem/__tests__/introspect.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { introspectConfig } from "../introspect.js";

let dir: string;       // fake ~/.claude
let agentDir: string;  // fake ~/.agent/skills

function skill(root: string, name: string, body: string) {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), body);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfg-"));
  agentDir = mkdtempSync(join(tmpdir(), "agent-"));

  // standalone skills (one normal, one internal -> skipped, plus a name that collides with a plugin skill)
  skill(join(dir, "skills"), "review", "---\nname: review\ndescription: Review code\n---\nbody");
  skill(join(dir, "skills"), "secret-skill", "---\nname: secret-skill\nmetadata:\n  internal: true\n---\nhidden");

  // user MCP with a secret
  // plus enabledPlugins: p@mp enabled, q@mp NOT enabled
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      mcpServers: { user1: { command: "x", env: { TOK: "secretval" } } },
      enabledPlugins: { "p@mp": true },
    }),
  );

  // installed plugins: p@mp (enabled) and q@mp (disabled), installPaths under dir
  const pPath = join(dir, "plugins", "p");
  const qPath = join(dir, "plugins", "q");
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(
    join(dir, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 1, plugins: { "p@mp": [{ installPath: pPath }], "q@mp": [{ installPath: qPath }] } }),
  );
  // plugin p: a bare .mcp.json server (with secret) + a skill + a colliding "review" skill
  writeFileSync(join(pPath, ".mcp.json"), JSON.stringify({ psrv: { command: "go", env: { KEY: "sekret" } } }));
  skill(join(pPath, "skills"), "pskill", "---\nname: pskill\ndescription: Plugin skill\n---\nx");
  skill(join(pPath, "skills"), "review", "---\nname: review\ndescription: PLUGIN review\n---\ndup");
  // plugin q (disabled): a server that must NOT appear
  writeFileSync(join(qPath, ".mcp.json"), JSON.stringify({ qsrv: { command: "no" } }));

  // CLAUDE.md
  writeFileSync(join(dir, "CLAUDE.md"), "global instructions");

  // generic agent skill
  skill(agentDir, "agentskill", "---\nname: agentskill\ndescription: From agent dir\n---\nz");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

describe("introspectConfig (multi-source)", () => {
  it("collects skills from standalone, plugin, and agent sources with source tags; skips internal; dedups by name", () => {
    const inv = introspectConfig({ claudeDir: dir, agentDir });
    const byName = Object.fromEntries(inv.skills.map((s) => [s.name, s]));
    // internal skipped
    expect(byName["secret-skill"]).toBeUndefined();
    // dedup: "review" appears once, standalone wins
    expect(inv.skills.filter((s) => s.name === "review").length).toBe(1);
    expect(byName["review"].source).toBe("standalone");
    expect(byName["review"].description).toBe("Review code");
    // plugin skill present, tagged
    expect(byName["pskill"].source).toBe("plugin:p@mp");
    // agent skill present, tagged
    expect(byName["agentskill"].source).toBe("agent");
  });

  it("collects MCP servers from user + enabled plugin (.mcp.json bare map), redacted, sourced; skips disabled plugins", () => {
    const inv = introspectConfig({ claudeDir: dir, agentDir });
    const byName = Object.fromEntries(inv.mcpServers.map((m) => [m.name, m]));
    // user server redacted + sourced
    expect((byName["user1"].config.env as Record<string, string>).TOK).toBe("<redacted>");
    expect(byName["user1"].source).toBe("user");
    // enabled plugin's bare-map server present + redacted + sourced
    expect((byName["psrv"].config.env as Record<string, string>).KEY).toBe("<redacted>");
    expect(byName["psrv"].source).toBe("plugin:p@mp");
    // disabled plugin's server absent
    expect(byName["qsrv"]).toBeUndefined();
    // nothing leaks
    expect(JSON.stringify(inv)).not.toContain("sekret");
    expect(JSON.stringify(inv)).not.toContain("secretval");
  });

  it("captures CLAUDE.md and returns empty for missing dirs", () => {
    const inv = introspectConfig({ claudeDir: dir, agentDir });
    expect(inv.instructions[0].content).toBe("global instructions");
    const empty = introspectConfig({ claudeDir: join(dir, "nope"), agentDir: join(agentDir, "nope") });
    expect(empty).toEqual({ skills: [], mcpServers: [], instructions: [] });
  });
});
```

- [ ] **Step 2: Run it (FAIL — new signature/behavior):** `pnpm test`

- [ ] **Step 3: Replace `src/gem/introspect.ts` entirely** with:
```typescript
// src/gem/introspect.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { redactMcpConfig } from "./redact.js";
import type {
  ConfigInventory,
  SkillArtifact,
  McpServerArtifact,
  InstructionsArtifact,
} from "./types.js";

export interface IntrospectOptions {
  claudeDir?: string;
  agentDir?: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function parseFrontmatter(content: string): { description?: string; internal: boolean } {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { internal: false };
  const fm = m[1];
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const internal = /^\s*internal:\s*true\s*$/m.test(fm); // vercel-labs/skills hide convention
  return { description, internal };
}

function inferTransport(config: Record<string, unknown>): "stdio" | "http" | "sse" {
  if (typeof config.url === "string") return config.type === "sse" ? "sse" : "http";
  return "stdio";
}

// Read <skillsRoot>/<name>/SKILL.md into skill artifacts, tagging source. Skips internal.
function readSkillsDir(skillsRoot: string, source: string): SkillArtifact[] {
  const out: SkillArtifact[] = [];
  if (!existsSync(skillsRoot)) return out;
  let names: string[];
  try {
    names = readdirSync(skillsRoot);
  } catch {
    return out;
  }
  for (const name of names) {
    const skillMd = join(skillsRoot, name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    try {
      const content = readFileSync(skillMd, "utf8");
      const { description, internal } = parseFrontmatter(content);
      if (internal) continue;
      out.push({ type: "skill", name, description, source, content });
    } catch {
      // skip unreadable skill
    }
  }
  return out;
}

function serversToArtifacts(servers: Record<string, unknown>, source: string): McpServerArtifact[] {
  return Object.entries(servers).map(([name, cfg]) => {
    const config = isObj(cfg) ? cfg : {};
    return { type: "mcp_server", name, transport: inferTransport(config), config: redactMcpConfig(config), source };
  });
}

// settings.json keeps servers under .mcpServers; a .mcp.json may be {mcpServers:{}} OR a bare {name:{}} map.
function serversFromMcpJson(parsed: unknown): Record<string, unknown> {
  if (!isObj(parsed)) return {};
  if (isObj(parsed.mcpServers)) return parsed.mcpServers;
  return parsed;
}

function dedupByName<T extends { name: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (seen.has(it.name)) continue;
    seen.add(it.name);
    out.push(it);
  }
  return out;
}

export function introspectConfig(opts: IntrospectOptions = {}): ConfigInventory {
  const claudeDir = opts.claudeDir ?? join(homedir(), ".claude");
  const agentDir = opts.agentDir ?? join(homedir(), ".agent", "skills");

  const skillList: SkillArtifact[] = [];
  const mcpList: McpServerArtifact[] = [];

  // Source 1: standalone user skills
  skillList.push(...readSkillsDir(join(claudeDir, "skills"), "standalone"));

  // Source 2: user MCP (settings.json .mcpServers + .mcp.json)
  const settings = readJson(join(claudeDir, "settings.json"));
  if (isObj(settings) && isObj(settings.mcpServers)) {
    mcpList.push(...serversToArtifacts(settings.mcpServers, "user"));
  }
  mcpList.push(...serversToArtifacts(serversFromMcpJson(readJson(join(claudeDir, ".mcp.json"))), "user"));

  // Source 3: enabled plugins (their bundled .mcp.json + skills)
  const enabled = isObj(settings) && isObj(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const installed = readJson(join(claudeDir, "plugins", "installed_plugins.json"));
  const pluginsMap = isObj(installed) && isObj(installed.plugins) ? installed.plugins : {};
  for (const [key, entry] of Object.entries(pluginsMap)) {
    if (enabled[key] !== true) continue;
    const installPath = Array.isArray(entry) && isObj(entry[0]) ? (entry[0].installPath as string | undefined) : undefined;
    if (!installPath || typeof installPath !== "string") continue;
    const source = `plugin:${key}`;
    mcpList.push(...serversToArtifacts(serversFromMcpJson(readJson(join(installPath, ".mcp.json"))), source));
    skillList.push(...readSkillsDir(join(installPath, "skills"), source));
  }

  // Source 4: generic agent skills (~/.agent/skills)
  skillList.push(...readSkillsDir(agentDir, "agent"));

  // Instructions (CLAUDE.md)
  const instructions: InstructionsArtifact[] = [];
  const claudeMd = join(claudeDir, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    try {
      instructions.push({ type: "instructions", name: "CLAUDE.md", content: readFileSync(claudeMd, "utf8") });
    } catch {
      // skip unreadable CLAUDE.md
    }
  }

  return { skills: dedupByName(skillList), mcpServers: dedupByName(mcpList), instructions };
}
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm test` (the 3 multi-source tests pass; full suite green) and `pnpm build` clean.

- [ ] **Step 5: Commit**
```bash
git add src/gem/introspect.ts src/gem/__tests__/introspect.test.ts
git commit -m "feat: discovery-sources introspection (standalone/user/plugins/agent) + dedup + internal skip"
```

---

### Task 3: Update controller + tools to the opts signature

**Files:**
- Modify: `src/gem.controller.ts`
- Modify: `src/gem.tools.ts`
- Modify: `src/__tests__/gem.controller.test.ts` (assert a `source` field)

- [ ] **Step 1: `src/gem.controller.ts`** — change both `introspectConfig(resolveDir(...))` calls to the opts shape:
  - in `inventory`: `return introspectConfig({ claudeDir: resolveDir(input.query.dir) });`
  - in `gem`: `const inventory = introspectConfig({ claudeDir: dir });` (where `dir = resolveDir(input.body.dir)`).

- [ ] **Step 2: `src/gem.tools.ts`** — same change in both tools:
  - `inventory`: `return introspectConfig({ claudeDir: resolveDir(input.dir) });`
  - `gem`: `return buildPack(introspectConfig({ claudeDir: dir }), input.selection, { name: input.name ?? "gem", createdFrom: dir });`

- [ ] **Step 3: Add a `source` assertion** to `src/__tests__/gem.controller.test.ts` — inside the existing "GET /api/inventory returns redacted inventory" test, after the existing assertions, add:
```typescript
    expect(r.body.skills[0].source).toBe("standalone");
    expect(r.body.mcpServers[0].source).toBe("user");
```
(The fixture's `gh` server comes from `settings.json.mcpServers`, so its source is `"user"`.)

- [ ] **Step 4: Verify** — `pnpm test` (all green) and `pnpm build` clean.

- [ ] **Step 5: Commit**
```bash
git add src/gem.controller.ts src/gem.tools.ts src/__tests__/gem.controller.test.ts
git commit -m "feat: controller + tools use introspectConfig opts; assert source in inventory"
```

---

### Task 4: All-artifacts search + source tags in the UI

**Files:**
- Modify: `src/public/index.html`

- [ ] **Step 1: READ `src/public/index.html`.** It has a left `.pane` with a `.bar` (gem name + Select all), a `#inventory` div populated by `load()` via `group(title, items, kind)`, and `onToggle`/`refresh`/`build`. You will: (a) add a search input, (b) show each row's `source`, (c) filter rows live without unchecking.

- [ ] **Step 2: Add a search input** — in the left `.pane`, immediately BEFORE `<div id="inventory">Loading…</div>`, add:
```html
    <div class="bar"><input id="search" type="text" placeholder="search skills, MCP servers, sources…" style="flex:1" /></div>
```

- [ ] **Step 3: Show `source` on each row + make rows searchable.** Replace the `group(title, items, kind)` function with this version (adds a source chip + a `data-search` attribute carrying lowercased name+description+source):
```javascript
function group(title, items, kind) {
  if (!items.length && kind !== "instructions") return "";
  const rows = items.map(it => {
    const meta = it.description || it.transport || "";
    const src = it.source ? ` <span class="src">${esc(it.source)}</span>` : "";
    const hay = `${it.name} ${meta} ${it.source || ""}`.toLowerCase();
    return `<label class="row" data-search="${esc(hay)}"><input type="checkbox" data-kind="${kind}" data-name="${esc(it.name)}"> <span>${esc(it.name)}${src} ${meta ? `<span class="d">— ${esc(meta)}</span>` : ""}</span></label>`;
  }).join("");
  return `<div class="group" data-group="${kind}"><h2>${title} (${items.length})</h2>${rows}</div>`;
}
```
Add a `.src` style — in the `<style>` block, after the `label.row .d` rule, add:
```css
  label.row .src{font:11px/1 ui-monospace,monospace;color:var(--accent);border:1px solid var(--line);border-radius:4px;padding:1px 4px;margin-left:4px}
```

- [ ] **Step 4: Wire the live filter.** Add this `filterRows` function (near `refresh`) and call it from a `search` input listener; it hides non-matching rows by `display`, never touching the checkbox state:
```javascript
function filterRows() {
  const q = (document.getElementById("search").value || "").trim().toLowerCase();
  document.querySelectorAll("#inventory label.row").forEach(row => {
    const hay = row.getAttribute("data-search") || "";
    row.style.display = !q || hay.includes(q) ? "" : "none";
  });
  // update each group's "(showing X of N)" heading
  document.querySelectorAll("#inventory .group").forEach(g => {
    const all = g.querySelectorAll("label.row");
    const shown = [...all].filter(r => r.style.display !== "none").length;
    const h2 = g.querySelector("h2");
    if (h2 && !h2.dataset.base) h2.dataset.base = h2.textContent.replace(/\s*\(showing.*$/, "");
    if (h2) h2.textContent = q ? `${h2.dataset.base} — showing ${shown}` : h2.dataset.base;
  });
}
```
At the END of `load()` (after the `document.querySelectorAll('input[type=checkbox]')...addEventListener` line and `refresh()`), add:
```javascript
  document.getElementById("search").addEventListener("input", filterRows);
  filterRows();
```

- [ ] **Step 5: Smoke test (build + run + headless check)**
```bash
pnpm build
PORT=4318 node dist/index.js > /tmp/ap.log 2>&1 &  SRV=$!
sleep 1.5
echo "--- inventory has source tags ---"; curl -s localhost:4318/api/inventory | grep -o '"source":"[^"]*"' | sort -u | head
kill $SRV 2>/dev/null
```
Expected: `"source":"standalone"` (and on this machine, plugin sources like `"source":"plugin:superpowers@claude-plugins-official"` now that plugins are introspected). Then `pnpm test` (all green) and `pnpm build` clean. (The browser search interaction is verified with gstack at the acceptance step by the controller.)

- [ ] **Step 6: Commit**
```bash
git add src/public/index.html
git commit -m "feat: all-artifacts search box + per-row source tags in the gem UI"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** discovery-sources architecture + ordered v1 sources (Task 2 — spec §2); both MCP shapes incl. bare plugin maps (Task 2 `serversFromMcpJson` — spec §3); `metadata.internal` skip (Task 2 `parseFrontmatter` — spec §4); dedup by name + precedence (Task 2 `dedupByName` ordering — spec §5); source type changes (Task 1 — spec §6); redaction unchanged (reused `redactMcpConfig` — spec §3); enabled-only plugins + generic agent path (Task 2 — spec §2); tests incl. internal-skip/dedup/disabled-plugin/redaction-leak (Task 2 — spec §7); controller/tools updated + source asserted (Task 3). Search UI over all artifacts (Task 4) is the user's original ask, now meaningful.
- **Type consistency:** `IntrospectOptions { claudeDir?, agentDir? }`; `introspectConfig(opts)` used in controller + tools (Task 3) and tests (Task 2); `SkillArtifact.source: string`, `McpServerArtifact.source?: string` (Task 1) ↔ schemas (Task 1) ↔ introspect emits both (Task 2). Relative imports `.js`.
- **No placeholders:** complete code + commands throughout.
- **Out of scope (later):** project-level discovery, more agent paths, plugin commands/agents, gem-core dedup with workflow-profiler, publish.
