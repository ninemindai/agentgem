# Multi-Source Config Introspection — Design

**Date:** 2026-06-15
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (extends `src/pack/` pack-core)
**Scope:** Generalize introspection from "user-level Claude config" to an extensible **set of discovery sources**, so the inventory/Pack includes **plugin-bundled** skills + MCP servers and a **generic non-Claude agent** skill path — each artifact tagged by `source`. Borrows the multi-location discovery strategy and the `metadata.internal` hide convention from `vercel-labs/skills`.

---

## 1. Why

The current `introspectConfig` reads only `~/.claude/skills`, `~/.claude/settings.json`/`.mcp.json`, and `CLAUDE.md`. On a real machine that finds **0 MCP servers** and misses ~half the skills, because the operator's real capability stack is **plugin-bundled** (e.g. the `github` MCP server, the `superpowers` skills). It is also Claude-Code-specific. We fold plugin artifacts into the existing `skills`/`mcpServers` lists with a `source` tag (the chosen model), and structure discovery as a list of **sources** so other agents/paths are appendable, not a rewrite.

## 2. Discovery-sources architecture

`introspectConfig(opts)` runs an ordered list of **discovery sources**, each returning `{ skills, mcpServers }` with `source` tags, then merges + dedups.

```ts
interface IntrospectOptions {
  claudeDir?: string;   // default ~/.claude
  agentDir?: string;    // default ~/.agent/skills  (the generic, agent-agnostic global skills root)
}
```

**v1 sources, in precedence order:**
1. **standalone** — skills at `<claudeDir>/skills/*/SKILL.md` → `source: "standalone"`.
2. **user MCP** — servers from `<claudeDir>/settings.json` (`.mcpServers` only) and `<claudeDir>/.mcp.json` → `source: "user"`.
3. **plugins** — for each *enabled* plugin (`settings.json.enabledPlugins[key] === true`) whose `installed_plugins.json` entry gives an `installPath`:
   - `<installPath>/.mcp.json` servers → `source: "plugin:<key>"`.
   - `<installPath>/skills/*/SKILL.md` skills → `source: "plugin:<key>"`.
   (`<key>` is the `"<name>@<marketplace>"` plugin id. A plugin may bring MCP only, skills only, or both — read each independently.)
4. **agent** (generic, non-Claude) — skills at `<agentDir>/*/SKILL.md` → `source: "agent"`. Proves the multi-agent abstraction; more agent paths (`.agents/skills`, Cursor, Codex) are future sources behind this same shape.

`CLAUDE.md` instructions: unchanged (`<claudeDir>/CLAUDE.md`).

## 3. MCP config shapes (both supported)

- **settings.json**: servers live under `.mcpServers` only (the file has many other keys). `serversFromSettings = parsed.mcpServers ?? {}`.
- **`.mcp.json`** (user or plugin): may be `{ "mcpServers": { … } }` *or* a **bare server map** `{ "<name>": { … } }` (plugin `.mcp.json` uses the bare form, e.g. `{ "github": { type, url, headers } }`). `serversFromMcpJson(parsed) = (parsed.mcpServers && typeof parsed.mcpServers === "object") ? parsed.mcpServers : (isObject(parsed) ? parsed : {})`.

All server configs are redacted at capture via the existing `redactMcpConfig` (value + key-name + env/headers + high-entropy). The plugin `github` server's `headers` (which carry auth) are therefore redacted.

## 4. Skill frontmatter handling (borrowed)

Parse each `SKILL.md`'s YAML frontmatter for:
- `description:` → `SkillArtifact.description` (unchanged behavior).
- `metadata.internal: true` (nested) → **skip the skill** (the `vercel-labs/skills` hide convention). Detection: within the frontmatter block, a line matching `^\s*internal:\s*true\s*$` under a `metadata:` key. v1 uses a simple check: frontmatter contains `internal: true` → skip. Document the heuristic.

## 5. Dedup & precedence

- **Skills**: deduped by `name`. First source in the order above wins (standalone > plugins > agent). Keeps `buildPack`'s by-name selection unambiguous. The kept artifact's `source` records its origin.
- **MCP servers**: deduped by `name` (user > plugins).

## 6. Type changes

```ts
// SkillArtifact.source widens from the literal to a string union of conventions:
interface SkillArtifact { type: "skill"; name; description?; source: string; content: string; }
//   source ∈ "standalone" | "agent" | "plugin:<name>@<marketplace>"

// McpServerArtifact gains source:
interface McpServerArtifact { type: "mcp_server"; name; transport; config; source: string; }
//   source ∈ "user" | "plugin:<name>@<marketplace>"
```
`ConfigInventory`, `Pack`, `buildPack`, the REST controller, and the MCP tools are otherwise unchanged (they pass artifacts through). `src/schemas.ts` updates: `SkillArtifactSchema.source = z.string()`; `McpServerArtifactSchema` gains `source: z.string()`.

## 7. Testing (hermetic)

`introspectConfig({ claudeDir, agentDir })` against temp fixtures:
- `<claudeDir>/skills/review/SKILL.md` (standalone) + a `secret-skill/SKILL.md` with `metadata:\n  internal: true` → **internal skipped**.
- `<claudeDir>/settings.json` with `{ mcpServers: { user1: {…, env:{TOK:"secret"}} }, enabledPlugins: { "p@mp": true } }` → user MCP redacted, `source:"user"`.
- A fake plugin: `installed_plugins.json` `{ plugins: { "p@mp": [{ installPath: "<claudeDir>/plugins/p" }] } }`; `<claudeDir>/plugins/p/.mcp.json` = bare `{ "psrv": { command, env:{K:"sekret"} } }`; `<claudeDir>/plugins/p/skills/pskill/SKILL.md` → plugin MCP `source:"plugin:p@mp"` redacted, plugin skill `source:"plugin:p@mp"`.
- A **disabled** plugin "q@mp" present in installed_plugins but not in enabledPlugins → its artifacts absent.
- `<agentDir>/agentskill/SKILL.md` → `source:"agent"`.
- **Dedup**: a `review` skill in BOTH standalone and the plugin → one `review`, `source:"standalone"`.
- Missing dirs → empty, no throw.
- Plus the existing redact/buildPack tests (unchanged) and the controller test (now asserts a `source` field present).

## 8. Out of scope (later)

Project-level discovery (`./.claude/skills`, `./.agents/skills` relative to cwd), additional agent paths (Cursor `~/.cursor`, Codex), plugin commands/agents, a top-level "enabled plugins" summary list, and the search UI (next sub-project). The discovery-source list makes each a small additive change.

## 9. Platform fit

Borrows `vercel-labs/skills`' multi-location discovery + portable-`SKILL.md` + `metadata.internal` conventions, scoped to YAGNI. Makes the Pack reflect the operator's *actual* capability stack (plugins included) and sets up "multi-agent config discovery" — the inventory becomes source-aware, which the upcoming search UI surfaces (filter/group by source).
