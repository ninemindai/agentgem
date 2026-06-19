# agentgem — Gem Workspaces: a managed local home for gems + their rendered target layouts (Design)

**Date:** 2026-06-18
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Give a gem a **persistent local home** under a managed root (`~/.agentgem/workspaces/<name>/`). Each workspace holds the **canonical gem archive at its root** (the editable source of truth) plus a `.targets/<target>/` subtree of **rendered harness layouts** (eve, flue, codex, …) that are *derived build outputs* regenerated from the archive. Adds workspace-lifecycle ops (create/list/read/render/delete) and a UI switcher so you can browse a gem's project layout for any target on disk. Pure rendering is unchanged — workspaces are an orchestration + persistence layer over the existing `writeGemArchive`/`readGemArchive`/`materialize` core.

---

## 0. Motivation

The archive made a gem a durable artifact, and `materialize(gem, target)` already produces every harness's on-disk layout. What's missing is **lifecycle and place**: somewhere a gem *lives* between sessions, that you can name, list, reopen, and from which you can see "what does this gem look like as an Eve project? as a Flue project?" — on disk, browsable, not just an in-memory preview. Today every op rebuilds from a transient selection; nothing persists and target layouts are never written for inspection.

A workspace supplies that home and draws the line the rest of the system needs: **the archive is source; rendered target layouts are build output.** Conflating them is the central risk this design exists to prevent.

## 1. Design decisions (locked)

1. **Workspace = archive (source) + `.targets/` (build).** The canonical archive sits at the workspace root; rendered harness layouts live under `.targets/<target>/` and are *derived* — regenerable, never hand-edited, gitignore-able. (User decision.)
2. **Managed root.** agentgem owns `~/.agentgem/workspaces/`; workspaces are named subdirectories there, created/listed/opened via ops and a UI switcher. Root overridable via `AGENTGEM_HOME` (default `~/.agentgem`). (User decision.)
3. **Orchestration only — no new rendering.** A new `src/gem/workspaces.ts` composes the existing pure core (`writeGemArchive`, `readGemArchive`, `materialize`, `compatibility`). It owns disk layout + lifecycle; it invents no new layout logic.
4. **Explicit render, no watcher (YAGNI).** Targets render on an explicit op (a button / per-target tab), not via a filesystem watcher. Edit the archive → render → `.targets/<target>/` refreshes.
5. **`readArchiveDir` must ignore top-level dot-entries.** The archive's own files are never dot-prefixed, so reading a workspace archive must skip `.targets/` (and `.git/`, etc.) — otherwise `verifyLock` rejects them as `extra` files and every workspace read fails. This is the load-bearing integration change.
6. **Create-only in v1; edit is the manifest-editor's job.** `createWorkspace` errors if the name exists (no silent clobber). Mutating an existing archive's bodies (then recomputing the lock) is a separate follow-up (the manifest editor). Workspaces v1 = create, list, read, render, delete.
7. **Name is untrusted input — sanitize + confine.** Workspace `name` is `safePathSegment`-sanitized AND the resolved path is asserted to stay under `workspacesRoot` (path-traversal guard) before any disk op.
8. **Secret-safe, consistent with the write-into-agentgem trust decision.** Workspaces persist an already-redacted archive under a managed root; no secret values touch disk. This matches the prior decision to keep local writes inside agentgem.

## 2. On-disk layout

```
~/.agentgem/workspaces/<name>/        # name = safePathSegment(requested name)
  gem.json  gem.lock                # canonical archive = source of truth
  skills/<n>/SKILL.md
  instructions/<n>.md
  mcp/<n>.json   hooks/<n>.json   checks/<n>.json
  .targets/                           # derived; cleared+rewritten per render; gitignore-able
    eve/    agent/skills/<n>.md  agent/instructions.md  agent/connections/<n>.ts  agent/proxies/<n>.mjs
    flue/   agents/*.ts  skills/<n>/SKILL.md  …          (once the flue target ships)
    codex/  AGENTS.md  config.toml
    claude/ skills/<n>/SKILL.md  CLAUDE.md  .mcp.json  settings.json
```

`.targets/<target>/` is the verbatim `FileTree` returned by `materialize(gem, target)` written to disk under that subdir. A render **clears `.targets/<target>/` first** so artifacts removed from the archive don't leave stale files behind.

## 3. Module — `src/gem/workspaces.ts` (new; orchestration, owns workspace disk I/O)

```ts
import type { Gem } from "./types.js";
import type { TargetId, SkippedArtifact } from "./targets.js";

export interface WorkspaceSummary {
  name: string;                 // directory name (sanitized)
  packName: string;             // gem.json "name"
  version: string;              // gem.json "version"
  artifactCounts: { skill: number; mcp_server: number; instructions: number; hook: number };
  checks: number;
  renderedTargets: TargetId[];  // which .targets/<t>/ dirs currently exist
}

export interface WorkspaceDetail extends WorkspaceSummary {
  files: Record<string, string>;                       // the archive tree (no .targets)
  compatibility: Record<TargetId, { supported: number; skipped: number }>;
}

export interface RenderResult { target: TargetId; files: Record<string, string>; skipped: SkippedArtifact[]; path: string }

export function workspacesRoot(): string;              // ${AGENTGEM_HOME ?? ~/.agentgem}/workspaces
export function workspaceDir(name: string): string;    // sanitize + confine under root (throws on traversal)

export function createWorkspace(name: string, gem: Gem, opts?: { version?: string }): WorkspaceSummary; // throws if exists
export function listWorkspaces(): WorkspaceSummary[];  // [] if root missing
export function readWorkspace(name: string): WorkspaceDetail;          // readArchiveDir → readGemArchive (verifies lock)
export function renderTarget(name: string, target: TargetId): RenderResult; // materialize → clear+write .targets/<target>/
export function deleteWorkspace(name: string): void;   // rm -rf the workspace dir
```

`workspaces.ts` holds the only new filesystem code (mkdir/read/rm under the root); it reuses `writeArchiveDir`/`readArchiveDir` from `archiveFs.ts`. The pure core (`archive.ts`, `targets.ts`) stays untouched except for the `readArchiveDir` dot-entry change (§5).

## 4. Surface — five ops (REST + MCP) + a UI switcher

| Op | REST | Shape |
|----|------|-------|
| create | `POST /api/workspaces` | `{ name, selection, dir?, projects?, version? }` → `WorkspaceSummary` (introspect → buildPack → writeArchive into the workspace) |
| list | `GET /api/workspaces` | `{}` → `{ workspaces: WorkspaceSummary[] }` |
| read | `GET /api/workspaces/:name` | → `WorkspaceDetail` (archive tree + compatibility + rendered targets) |
| render | `POST /api/workspaces/:name/render` | `{ target }` → `RenderResult` (writes `.targets/<target>/`) |
| delete | `DELETE /api/workspaces/:name` | → `{ deleted: name }` |

Handlers mirror the existing controller pattern (`resolveDirs` → `introspectAll` → `buildPack` for create; `readWorkspace`/`renderTarget` otherwise). Delete is destructive: the UI confirms; the op deletes the directory tree (including any stray hand-edits under it).

**Schemas (`src/schemas.ts`):** `WorkspaceSummarySchema`, `WorkspaceDetailSchema`, `RenderResultSchema`, `CreateWorkspaceRequestSchema`, `RenderRequestSchema`, plus path-param handling for `:name`.

**UI (`src/public/index.html`):** a **workspace switcher** (dropdown of `listWorkspaces`, + "New workspace…" using the current selection/name), and, when a workspace is open, **per-target tabs** (Claude/Codex/Eve/…) that call render and show the `.targets/<target>/` file tree with the existing click-to-view modal — i.e. "see the project layout for Eve" is a tab click. Reuses the existing materialize file-tree preview component.

## 5. The load-bearing integration change — `readArchiveDir` ignores top-level dot-entries

`readArchiveDir(root)` currently walks every file under `root`. A workspace root also contains `.targets/` (and may contain `.git/`). Those are **not** part of the archive; if read, `verifyLock` flags them as `extra` and the read throws. Fix: `readArchiveDir` skips any **top-level** entry whose name starts with `.`. The archive's own files (`gem.json`, `gem.lock`, `skills/…`, etc.) are never dot-prefixed, so this is lossless for archives and makes "read/materialize from a workspace dir" correct. Covered by a new test (a fake archive dir with a `.targets/` subtree round-trips identically with and without the dot-dir present).

## 6. Incidental fix — double-extension body filenames

An instructions artifact literally named `CLAUDE.md` currently serializes to `instructions/CLAUDE.md.md` (the writer appends `.md` to the name). It is **lossless** (the manifest stores `name: "CLAUDE.md"` and round-trips), but the filename is ugly and surfaces in `.targets` inspection. Fix in `writeGemArchive`: when forming an instructions body path, don't append `.md` if the sanitized name already ends in `.md`; likewise guard `.json` for mcp/hook/check bodies. Round-trip identity is unaffected (name is restored from the manifest entry, not the filename). A focused test asserts an instruction named `CLAUDE.md` lands at `instructions/CLAUDE.md` and still round-trips.

## 7. Module changes

- `src/gem/workspaces.ts` *(new)* — root/dir resolution + traversal guard, `create/list/read/renderTarget/delete`, `WorkspaceSummary`/`WorkspaceDetail`/`RenderResult` types.
- `src/gem/archiveFs.ts` — `readArchiveDir` skips top-level dot-entries (§5).
- `src/gem/archive.ts` — `writeGemArchive` body-path no-double-extension guard (§6).
- `src/schemas.ts` — workspace request/response schemas.
- `src/gem.controller.ts` — five workspace ops.
- `src/public/index.html` — workspace switcher + per-target tabs.

## 8. Testing

Per the per-module `__tests__` + controller (`@agentback/testing`) + page-smoke pattern:

- **`src/gem/__tests__/workspaces.test.ts` (unit, temp `AGENTGEM_HOME`):**
  - `createWorkspace` writes the archive tree into `<root>/<name>/`; `listWorkspaces` returns its summary; `readWorkspace` round-trips the Gem and reports `compatibility`.
  - `renderTarget(name, "eve")` writes `.targets/eve/agent/…` and reports it in `renderedTargets`; re-render after removing an artifact leaves no stale file (clear-then-write).
  - `createWorkspace` throws on a duplicate name; `workspaceDir` throws on a traversal name (`../x`, `a/b`).
  - `deleteWorkspace` removes the tree; `listWorkspaces` is `[]` when root is missing.
- **`src/gem/__tests__/archiveFs.test.ts` (or archive.test.ts):** `readArchiveDir` skips a top-level `.targets/` subtree — an archive dir read with and without `.targets/` present yields the identical `Gem` (no `extra`-file verify failure).
- **`src/gem/__tests__/archive.test.ts`:** an instructions artifact named `CLAUDE.md` serializes to `instructions/CLAUDE.md` (not `.md.md`) and still round-trips (§6).
- **Controller (`@agentback/testing`, temp `AGENTGEM_HOME` + fake `~/.claude`):** `POST /api/workspaces` → `GET /api/workspaces` lists it → `POST /api/workspaces/:name/render {target:"eve"}` returns the Eve tree and writes `.targets/eve/` → `GET /api/workspaces/:name` reports `renderedTargets:["eve"]` → `DELETE` removes it. No secret value in any response.
- **Page (gstack at verify time):** create a workspace from a selection, switch to it, click the **Eve** tab → see `agent/skills/…` in the file tree.

## 9. Out of scope (named follow-ups)

- **Editing an existing workspace archive** (mutate bodies → recompute lock) — the **manifest editor** subsystem; v1 is create-only.
- **Filesystem watch / auto-render** on archive change — explicit render only in v1.
- **Deploy from a workspace** (`publish`/deploy-registry reading a workspace) — the deploy-registry follow-up; a workspace is the natural input but not wired here.
- **Flue / OpenAI-SandboxAgent targets** — once those `TargetSpec`s exist they render into `.targets/<target>/` for free; no workspace change needed.
- **Workspace rename / duplicate / export-as-tarball** — straightforward later additions over the same module.

## 10. Platform fit

Workspaces turn the archive from a thing you *produce* into a thing you *keep and work in* — the persistent home the discovery and editor surfaces were going to need, delivered now with the source-vs-build split that keeps "the gem" and "its Eve/Flue/Codex projects" cleanly separated. It stays small (one orchestration module + five ops + a UI switcher + one surgical `readArchiveDir` change) because all rendering already exists: a workspace is just where the archive lives and where `materialize` writes its output for you to see.
