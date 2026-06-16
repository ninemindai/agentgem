# Project-Level Artifact Discovery — Design

**Date:** 2026-06-15
**Status:** Approved design (key forks decided by user), pre-implementation
**Project:** `agentgem`
**Scope:** Let the operator point at a **project root** (via a server-backed folder browser) and discover **project-level** skills / MCP servers / instructions, shown in their **own group** alongside the global inventory — not merged with it.

---

## 1. Decisions (locked)

- **Picker:** a **server-backed folder browser**. The browser can't hand a real path to the server, so a new `GET /api/browse` lists real directories; the UI navigates them and returns an absolute path the server introspects.
- **Precedence:** **keep both, separate group.** Project artifacts are NOT deduped against global ones. A project `review` and a global `review` both appear, distinguished by `source: "project"`, each in its own selection namespace (so name-based selection stays unambiguous).

## 2. Project sources (at `<root>`)

Tagged `source: "project"`, agent-type **Project**:
- `<root>/.claude/skills/*/SKILL.md` → skills
- `<root>/.mcp.json` (bare map or `{mcpServers}`) **and** `<root>/.claude/settings.json` `.mcpServers` → MCP (redacted at capture via `redactMcpConfig`)
- `<root>/.agents/skills/*/SKILL.md` → skills
- `<root>/CLAUDE.md` and `<root>/AGENTS.md` → instructions

Deduped **within** the project by name (same precedence helper as global). `metadata.internal` skip honored. Redaction boundary unchanged — every MCP config routes through `redactMcpConfig`.

## 3. Data model

```ts
interface ProjectInventory { root: string; skills: SkillArtifact[]; mcpServers: McpServerArtifact[]; instructions: InstructionsArtifact[]; }
interface ConfigInventory { skills; mcpServers; instructions; project?: ProjectInventory | null; }
```
`introspectConfig` (global) is unchanged and never sets `project` (existing `toEqual({skills,mcpServers,instructions})` still holds). A new `introspectProject(root)` builds the project section. The controller composes them.

Selection gains a project namespace:
```ts
PackSelection += { projectSkills?: string[]; projectMcpServers?: string[]; includeProjectInstructions?: boolean }
```
`buildPack` selects project artifacts from `inventory.project` by name and pushes them (each already tagged `source:"project"`, so a name collision in the Pack's `artifacts[]` is fine — it's a list, not a map).

## 4. `GET /api/browse` (security-sensitive)

- Query `?path=` (default: home dir). Returns `{ path, parent, dirs: [{ name, path }] }`.
- **Directory names only — never file contents.** Lists immediate subdirectories (`readdir withFileTypes`, `isDirectory()`), sorted.
- **Home-scoped:** the resolved path must be within the user's home dir; anything outside is clamped back to home. `parent` is null at the home root (can't navigate above home). Prevents traversal to system dirs.
- Unreadable dir → empty `dirs`, no throw.

This is the only new filesystem-listing surface; it exposes folder *structure under home*, no contents, which the existing local-utility trust model already implies (the server reads the user's config). Documented in the UI.

## 5. Endpoints / wire

- `GET /api/inventory?dir=&project=` → global inventory + `project` section when `project` given (resolved + validated like browse).
- `POST /api/pack` body adds `project?: string`; re-introspects project and includes selected project artifacts.
- MCP `inventory`/`pack` tools gain an optional `project` input for parity.

## 6. UI

- A **"Project" bar**: a button `📁 Add project…` opens the folder-browser modal (breadcrumb + subfolder list + "Use this folder"). Once chosen, the root shows with a **✕ clear**.
- A **Project group** renders below the global groups (Skills/MCP/Instructions for the project), source chip `project`, its own checkboxes (kind `projectSkills`/`projectMcpServers`/`projectInstructions`), searchable + viewable (modal) like the rest.
- Agent-type filter gains a **Project** checkbox (only when a project is loaded). `agentOf("project") = "project"`.
- Trust-boundary note unchanged (project MCP is redacted; project skill/CLAUDE.md/AGENTS.md bodies bundle verbatim).

## 7. Out of scope (later)

Browsing above home / configurable roots; project plugins; nested/monorepo multi-root; watching for changes; remembering recent projects.
