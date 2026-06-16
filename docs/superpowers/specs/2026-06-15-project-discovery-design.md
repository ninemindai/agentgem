# Project-Level Artifact Discovery — Design

**Date:** 2026-06-15
**Status:** Approved design (key forks decided by user), pre-implementation
**Project:** `agentgem`
**Scope:** Let the operator point at a **project root** (via a server-backed folder browser) and discover **project-level** skills / MCP servers / instructions, shown in their **own group** alongside the global inventory — not merged with it.

---

## 1. Decisions (locked)

- **Picker:** an **OS-native folder dialog** (revised — the server-backed in-page browser was too heavy and added a directory-enumeration surface to harden). agentgem runs locally, so `GET /api/pick-folder` pops the OS dialog server-side (`osascript` on macOS, `zenity` on Linux, `FolderBrowserDialog` on Windows) and returns the chosen absolute path (null on cancel). The user explicitly selects the folder — no server-side directory crawling, nothing to home-scope.
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

## 4. `GET /api/pick-folder` (native dialog)

- Pops the OS-native folder chooser server-side and returns `{ path: string | null }` (null on cancel / unavailable). The command is platform-specific (`pickFolderCommand`): macOS `osascript … choose folder`, Linux `zenity --file-selection --directory`, Windows `FolderBrowserDialog`.
- **No directory enumeration, no contents read.** The server never lists folders; the OS dialog does, under the user's own credentials, and only the single chosen path comes back. This removes the home-scoping / path-traversal / symlink-escape surface the in-page browser would have required.
- The chosen path is the user's explicit selection; `introspectProject` canonicalizes it with `resolveProject` (absolute path) and reads only the specific known files (skills/`.mcp.json`/`CLAUDE.md`/`AGENTS.md`), with MCP redacted.

## 5. Endpoints / wire

- `GET /api/inventory?dir=&project=` → global inventory + `project` section when `project` given (canonicalized to an absolute path).
- `POST /api/pack` body adds `project?: string`; re-introspects project and includes selected project artifacts.
- MCP `inventory`/`pack` tools gain an optional `project` input for parity.

## 6. UI

- A **"Project" bar**: a button `📁 Add project…` opens the folder-browser modal (breadcrumb + subfolder list + "Use this folder"). Once chosen, the root shows with a **✕ clear**.
- A **Project group** renders below the global groups (Skills/MCP/Instructions for the project), source chip `project`, its own checkboxes (kind `projectSkills`/`projectMcpServers`/`projectInstructions`), searchable + viewable (modal) like the rest.
- Agent-type filter gains a **Project** checkbox (only when a project is loaded). `agentOf("project") = "project"`.
- Trust-boundary note unchanged (project MCP is redacted; project skill/CLAUDE.md/AGENTS.md bodies bundle verbatim).

## 7. Out of scope (later)

Browsing above home / configurable roots; project plugins; nested/monorepo multi-root; watching for changes; remembering recent projects.
