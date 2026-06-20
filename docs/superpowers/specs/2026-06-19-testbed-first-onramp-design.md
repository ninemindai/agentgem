# Testbed-first on-ramp — design

**Status:** approved (pre-implementation)
**Date:** 2026-06-19
**Topic:** Invert agentgem's entry point — author/test-drive a local `.claude/` project, then package → workspace → target → deploy.

Relates to: [[gem-archive-format-spec]], [[eve-target-fast-follow]], gem-workspaces, multi-source-introspection.

---

## 1. Problem & decision

Today agentgem is **harvest-first**: `introspectConfig()` scans the user's already-configured
machine (`~/.claude`, `~/.agents`, `~/.codex`, `~/.hermes` + added project roots) and the user
cherry-picks artifacts into a Gem. There is **no place to run the agent as a coherent unit and
iterate** before committing to a package — the only runtime that exists is the eve materialize
target (`run.ts`), which runs a *rendered* target, not a neutral local agent.

**Decision (locked):** invert the on-ramp. A **testbed project** — a real on-disk `.claude/`
directory the user test-drives with their own Claude Code — becomes the canonical authoring
surface and the default entry point. Global introspection is demoted from on-ramp to an
*"Import from my machine"* dialog. The Gem becomes an **export** of the testbed.

### Locked decisions (from brainstorming)

1. **Testbed role:** *replace* harvest as the default on-ramp. Project is canonical; Gem is an export.
2. **Test-drive runtime:** the user's **real Claude Code**, run in the testbed dir. Agentgem
   manages config; it does not host a runtime. (`introspectProject(root)` already reads exactly
   this `.claude/` shape.)
3. **Authoring model:** *import-only, then hand-edit.* Agentgem scaffolds the project and writes
   selected global artifacts into `.claude/` **once**; thereafter the user (or Claude Code) edits
   by hand. Agentgem re-reads on package. No ongoing CRUD.
4. **Secret handling on import:** *re-read the real value at import.* The writer re-opens the
   source file and copies the original (unredacted) config through into the testbed so the
   test-drive runs immediately. See §6 for containment.
5. **Package scope:** *re-select within the project.* Packaging re-introspects the testbed and
   presents the existing selection UI scoped to that project; the user picks what enters the Gem.
6. **UI shape (Approach A):** project-first UI; the project is the single spine. Global harvest
   lives only inside an Import dialog. The workspace concept is untouched.

### Lifecycle (the spine)

```
Testbed project (.claude/)  ──package──▶  Workspace (gem home)  ──render──▶  Target  ──▶  Deploy
   ▲ import from machine            (~/.agentgem/workspaces, existing)   (existing)      (existing)
   ▲ hand-edit + `claude` run
```

### What existing concepts become

- **Global introspection** (`introspectConfig`) — demoted from on-ramp to the data source behind
  an "Import from my machine" dialog.
- **"Add project…"** harvest affordance — replaced by **"Open/Create testbed."** Same
  `pickFolder`, new meaning: the chosen folder is the active authoring project, not one of N
  harvest sources.
- **Selection pane** — same widget, re-pointed: inventory is `introspectProject(activeTestbed)`
  instead of `introspectConfig() + projects[]`.
- **Workspace** — unchanged. Still the gem's post-package home; render/run/deploy hang off it.

> **Why testbed and workspace do not conflict:** a *workspace* (`~/.agentgem/workspaces/<n>/` =
> canonical archive + `.targets/`) is a *post-package* home. A *testbed* (`.claude/` you
> test-drive) is *pre-package*. They are different lifecycle stages; the testbed inserts a stage
> *before* the workspace.

---

## 2. The writer module — `src/gem/testbed.ts` (net-new)

The inverse of `introspect.ts`. Three of four artifact types map back trivially; MCP/hooks are
copy-through-from-source because of decision (4).

### `scaffoldTestbed(root: string, name: string)`

Creates a minimal runnable skeleton (idempotent — never clobbers existing files):

```
<root>/.claude/settings.json   → {}
<root>/.claude/skills/          → (dir)
<root>/CLAUDE.md                → "# <name>\n"
<root>/.gitignore               → ".mcp.json\n.claude/settings.json\n.env\n.targets/\n"
```

The `.gitignore` ignores the files that will hold plaintext secrets after import — the deliberate
containment guard for decision (4) (see §6).

### `importArtifacts(root, selection, dirs)`

Merges selected **global** artifacts into the testbed, re-reading raw config from source.
Returns `{ written: ImportedRef[]; skipped: { artifact: string; reason: string }[] }`.

| Type | Re-read from source | Write into testbed |
|---|---|---|
| skill | `<src>/skills/<n>/SKILL.md` | `.claude/skills/<n>/SKILL.md` (verbatim incl. body + frontmatter) |
| mcp_server | source file `mcpServers[n]` (**raw, secrets intact**) | merge into `.mcp.json` → `mcpServers[n]` |
| hook | source `settings.json` `hooks[event]` group (**raw**) | merge into `.claude/settings.json` → `hooks[event]` (append group) |
| instructions | source file | append into `CLAUDE.md` under a `<!-- imported: <name> -->` marker |

**Merge rules**
- Merge, never wholesale-clobber: existing `.mcp.json` / `settings.json` entries are preserved.
- Name collisions are overwritten and reported in `written` (so the UI can flag them).
- Re-importing the same artifact is idempotent (same name → same target file/key).
- Instruction markers make appends idempotent: re-import replaces the marked block, not appends a duplicate.

**Source resolution** — a small `sourceFile(source, kind, dirs)` helper maps an artifact's
`source` tag to its origin file:
- `user` → `~/.claude/settings.json` (mcp/hooks) · `~/.claude/.mcp.json` (mcp) · `~/.claude/skills/` · `~/.claude/CLAUDE.md`
- `plugin:<key>` → installPath `.mcp.json` / `skills/` / `hooks/hooks.json` (looked up via `installed_plugins.json`, as `introspect.ts` already does)
- `agent` / `codex` / `hermes` → their respective skill dirs / rules / SOUL.md
- This re-uses the location logic already in `introspect.ts`; extract the shared path-resolution into a tiny helper rather than duplicating.

**Raw re-read fallback:** if the source file is missing/unreadable at import time, fall back to
the redacted value carried by the inventory artifact and add the artifact to `skipped` with reason
`"source unreadable — wrote redacted; fill in secret manually"`.

### Purity / layout

Follows the codebase seam (pure core + thin fs orchestrator, like `archive.ts` + `archiveFs.ts`):
`scaffoldTestbed` returns a `FileTree` written by a thin fs wrapper; `importArtifacts` must
*read-merge-write* existing testbed files, so it owns its disk I/O directly (it is inherently an
orchestrator, not a pure transform). Both live in `testbed.ts`.

---

## 3. Endpoints + tracking

**New (in `GemController`):**
- `POST /api/testbed/scaffold` — body `{ dir, name }` → `{ root }`. Scaffolds skeleton at `dir`.
- `POST /api/testbed/import` — body `{ root, selection, dir }` → `{ written[], skipped[] }`.
  Re-reads raw global artifacts per `selection`, merges into the testbed.

**Reused unchanged:**
- `GET /api/inventory?projects=[root]` **is** the testbed inventory (`introspectProject`).
- `POST /api/gem`, `/api/materialize`, `/api/archive`, `/api/workspaces`, `/api/run*` already take
  `projects` + `selection`. **Packaging from a testbed needs zero new packaging code** — send the
  testbed as the sole project and select its `project*`-kind artifacts. `buildGem` already supports
  the project-namespaced selection kinds (`projectSkills`, `projectMcpServers`, …).

**Tracking:** server stays stateless. The client remembers recent testbed paths in `localStorage`
(same pattern as today's `projects[]`). No new server-side persistence.

New schemas in `src/schemas.ts`: `TestbedScaffoldRequest`, `TestbedScaffoldResponse`,
`TestbedImportRequest`, `TestbedImportResponse`.

---

## 4. UI (Approach A) — `src/public/index.html`

Builds on the Increment-1 Lapidary Ledger reskin (already shipped).

- **Empty state:** no active testbed → left pane shows a "Create or open a testbed" prompt
  (two actions: scaffold new via `pickFolder`+name, or open existing via `pickFolder`), not the
  global inventory.
- **Header:** testbed chip (path + "Switch testbed") replaces the "introspecting ~/.claude…"
  subtitle. Shows the active testbed root.
- **Left pane:** the active testbed's inventory (`/api/inventory?projects=[root]`, rendered as the
  project's groups only) + the **test-drive card** (`cd <root> && claude` with a copy button) +
  an **"Import from machine"** button.
- **Import modal:** contains the *current* global selection UI (the existing checkbox inventory
  over `introspectConfig`). "Add to testbed" → `POST /api/testbed/import` → reload the testbed
  inventory. After import, show the one-line plaintext-secret warning (§6).
- **Stage rail goes live:** Testbed (authoring) → Package (`Cut & package` = createWorkspace) →
  Workspace (open existing) → Target (materialize) → Deploy (run/publish). Reflects real state;
  clicking a completed stage navigates back to it.
- **Package selection:** the existing checkboxes scoped to the testbed's `project*` artifacts,
  default all-checked (the re-select step from decision 5).
- **Certificate composition (optional, deferred to a follow-up):** richer `#preview` (tally grid,
  secrets/checks rows, wax seal) requires changing the JS that builds the summary; out of scope
  for this spec unless pulled in.

---

## 5. Workspace reconciliation

Workspace stays exactly as-is. "Cut & package gem" calls the existing `POST /api/workspaces`
(`createWorkspace`) with the testbed selection → creates `~/.agentgem/workspaces/<name>/`.
Render/run/deploy hang off the workspace unchanged. The **only** change is *where the selection
originates* (testbed instead of global). The current "New workspace…" flow is re-pointed, not
rebuilt.

---

## 6. Secrets — containment model

Decision (4) writes **plaintext secrets** into the testbed `.claude/` so the test-drive runs.
This crosses agentgem's usual never-touch-raw-secrets seam, so it is contained:

- **Local only:** the raw value lands *only* in the testbed (the user's own machine, where it must
  be to run). It is never sent over the network and never enters a Gem.
- **Re-redacted on package:** packaging runs `introspectProject` → `redactMcpConfig`, so the Gem
  carries **redacted config + a `secretRef` (name only)**. Secrets do not propagate downstream
  (workspace, archive, materialize, publish all consume the redacted Gem).
- **Git guard:** `scaffoldTestbed` writes a `.gitignore` excluding `.mcp.json`,
  `.claude/settings.json`, `.env`, `.targets/`. The UI shows a one-line warning after import:
  *"This testbed holds plaintext secrets — don't commit `.mcp.json`/`settings.json`."*
- **Accepted residual risk:** a user who force-adds or relocates those files can still leak. This
  is acceptable per decision; `.gitignore` + warning is the agreed guard (not a hard block).

---

## 7. Testing

- **Containment round-trip (key test):** `importArtifacts` writes a raw key into a temp testbed →
  `introspectProject` + `buildGem` over that testbed yields **redacted config + a `secretRef`**,
  and the raw value appears **nowhere** in the Gem. Proves secrets don't leak into the export.
- `testbed.ts` units: scaffold FileTree shape (incl. `.gitignore`); per-type import merge;
  merge-preserves-existing; idempotent re-import (mcp key, hook group, instruction marker);
  raw-re-read fallback → `skipped`.
- Controller tests: `/api/testbed/scaffold` creates the skeleton; `/api/testbed/import` returns
  `written`/`skipped` and the testbed inventory reflects the import.
- Reuse the existing dist-runs-compiled-tests discipline ([[test-setup-runs-compiled-dist]]):
  clean `dist` before testing after any rename/move.

---

## 8. Out of scope

- Certificate composition in `#preview` (tally/seal) — separate frontend follow-up.
- Multi-testbed simultaneous editing — one active testbed at a time.
- Ongoing config CRUD from the UI — explicitly excluded by decision (3).
- Non-Claude testbeds (Codex/Hermes as the test-drive runtime) — decision (2) fixes Claude Code.
- Server-side testbed persistence — client `localStorage` only.
