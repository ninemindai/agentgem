# Import-into-flavor writers (Codex / Hermes) — design

**Status:** approved (pre-implementation)
**Date:** 2026-06-22
**Topic:** Make "Import from machine" write into Codex and Hermes testbeds (not just Claude), so imported artifacts land in each flavor's on-disk shape and round-trip through introspect → package.

Relates to: [[testbed-first-onramp]] (testbed flavors + the import path this extends), gem-archive (secret containment).

---

## 1. Problem & decision

`importArtifacts` (src/gem/testbed.ts) currently writes **Claude-shaped** files only (`.claude/skills/<n>/SKILL.md`, `CLAUDE.md`, `.mcp.json`, `.claude/settings.json` hooks). When testbed flavors shipped, the Import-from-machine button was **gated to Claude** (`importSupported: false` for codex/hermes). This makes import flavor-aware so Codex and Hermes testbeds can be populated from global config too.

Each flavor's writer mirrors that flavor's introspect read-set, so the cycle **import → introspect → package** round-trips.

### Locked decisions (from brainstorming)

1. **Codex MCP merge:** strip the existing `[mcp_servers.*]` blocks from `.codex/config.toml`, merge the new server into the parsed set, regenerate just that block, and re-append — preserving any non-MCP content.
2. **Hermes MCP: not applicable.** Verified against the real `~/.hermes/config.yaml`: Hermes has **no MCP-server config concept** (its tool model is `toolsets`/`platform_toolsets`/`gateway`; the only `mcp` key is `auxiliary.mcp`, a model-provider config). Hermes MCP import is **skipped-and-reported**, not built. (No YAML reader/writer, no introspect round-trip change, no secrets-file handling needed.)
3. **Write rules live in the `TESTBED_FLAVORS` registry** (an `import` block per flavor); `importArtifacts` keeps the shared machinery and dispatches.

### Per-flavor write mapping

| artifact | claude (today) | codex | hermes |
|---|---|---|---|
| skill | `.claude/skills/<n>/SKILL.md` | `.agents/skills/<n>/SKILL.md` | `.hermes/skills/<n>/DESCRIPTION.md` |
| instructions | `CLAUDE.md` (marked block) | `AGENTS.md` (marked) | `.hermes/SOUL.md` (marked) |
| mcp_server | `.mcp.json` (JSON merge) | `.codex/config.toml` `[mcp_servers]` (strip+re-append) | **skip+report** ("Hermes has no MCP-server config") |
| hook | `.claude/settings.json` | **skip+report** ("Codex has no hooks") | **skip+report** ("Hermes has no hooks") |

These mirror the flavor-agnostic `introspectProject` read-sets exactly (skills under `.claude/skills`+`.agents/skills`+`.hermes/skills`; instructions `CLAUDE.md`/`AGENTS.md`/`SOUL.md`; codex MCP `.codex/config.toml`), so re-import + introspect see the same artifacts.

---

## 2. Registry `import` block

Extend `TestbedFlavor` (src/gem/testbedFlavors.ts):

```ts
export interface FlavorImport {
  skillRel(name: string): string;                                  // testbed-relative skill body path
  instructionsFile: string;                                        // marked-block target
  writeMcp?: (root: string, name: string, rawConfig: Record<string, unknown>) => boolean; // undefined => skip
  supportsHooks: boolean;
}
export interface TestbedFlavor { /* …existing… */ import: FlavorImport; }
```

Per flavor:
- **claude:** `skillRel = .claude/skills/<n>/SKILL.md`, `instructionsFile = CLAUDE.md`, `writeMcp = writeMcpJson` (the existing `.mcp.json` merge, extracted), `supportsHooks = true`.
- **codex:** `skillRel = .agents/skills/<n>/SKILL.md`, `instructionsFile = AGENTS.md`, `writeMcp = writeMcpCodexToml`, `supportsHooks = false`.
- **hermes:** `skillRel = .hermes/skills/<n>/DESCRIPTION.md`, `instructionsFile = .hermes/SOUL.md`, `writeMcp = undefined`, `supportsHooks = false`.

`importSupported` becomes `true` for all three (the gate is removed). (Keep the field — it stays meaningful if a future flavor genuinely can't be imported into.)

## 3. `importArtifacts` (flavor-aware)

Signature: `importArtifacts(root, selection, rawInv, flavor: TestbedFlavorId = "claude")`. Dispatch via `const imp = TESTBED_FLAVORS[flavor].import`:
- **skills:** write `sk.content` to `join(root, imp.skillRel(name))`; `overwritten` = file existed.
- **instructions:** `upsertMarkedBlock(root, imp.instructionsFile, ins.name, ins.content)` (unchanged marker machinery).
- **mcp_server:** if `imp.writeMcp` → `overwritten = imp.writeMcp(root, name, m.config)` (raw config — local testbed only); else `skipped.push({ artifact: name, reason: "<Flavor> has no MCP-server config" })`.
- **hooks:** if `imp.supportsHooks` → existing settings.json merge; else `skipped.push({ artifact: name, reason: "<Flavor> has no hooks" })`.

Shared helpers `writeMcpJson` (the current `.mcp.json` block, extracted) and `writeMcpCodexToml` live in testbed.ts.

### `writeMcpCodexToml(root, name, rawConfig) → boolean`
1. `abs = join(root, ".codex", "config.toml")`; `text = existsSync(abs) ? read : ""`.
2. `existing = parseTomlMcpServers(text)`; `overwritten = name in existing`.
3. `existing[name] = rawConfig`.
4. Strip `[mcp_servers...]` blocks from `text` (regex on section headers, dropping each block through to the next top-level `[` or EOF) → `nonMcp`.
5. Rebuild servers as `McpServerArtifact[]` shape (`{ type:"mcp_server", name, config }`) and regenerate via `tomlMcpServers(...)`.
6. Write `nonMcp.trimEnd() + "\n\n" + regenerated` (or just the regenerated block when `nonMcp` is empty), creating `.codex/` as needed.
7. Return `overwritten`.

## 4. Wiring

- **Schema:** add `flavor?: TestbedFlavorIdSchema` to `TestbedImportRequestSchema`.
- **Controller:** `/api/testbed/import` passes `(input.body.flavor ?? "claude")` to `importArtifacts`.
- **UI:** `applyImport` sends `flavor: activeFlavor`; the `FLAVORS` table sets `importSupported: true` for codex/hermes (Import button un-gated); `openImport`'s gate is removed (or always-true).

## 5. Secret containment (unchanged invariant)

Raw secret values are written **only into the local testbed** (`.codex/config.toml`, `.mcp.json`). Packaging re-redacts: `introspectProject` reads `.codex/config.toml` via `parseTomlMcpServers` → `serversToArtifacts(..., "project")` (redacts) → `buildGem`. A round-trip test asserts a raw secret imported into a codex testbed is **absent** from the packaged Gem and declared in `requiredSecrets`.

## 6. Testing

- **Codex import:** writes `.agents/skills/<n>/SKILL.md`, `AGENTS.md` marked block, `.codex/config.toml` `[mcp_servers.<n>]`; hooks → skip-reported.
- **Codex `config.toml` merge:** importing a second server into a config.toml that already has a non-MCP section (e.g. `[model]\nx = 1`) keeps the non-MCP section and contains both servers; re-importing the same server is idempotent (`overwritten: true`, no duplicate block).
- **Hermes import:** writes `.hermes/skills/<n>/DESCRIPTION.md` + `.hermes/SOUL.md` marked block; mcp → skip-reported ("no MCP-server config"); hooks → skip-reported.
- **Claude regression:** claude import output is byte-identical to today.
- **Secret round-trip (codex):** import a raw-secret MCP into a codex testbed → `introspectProject` + `buildGem` → Gem has no raw value + a `requiredSecrets` entry.
- **Controller:** `/api/testbed/import` with `flavor:"codex"` writes the codex shape.
- Reuse the dist-clean test discipline.

## 7. Out of scope

- Hermes MCP (no such config concept — permanently skip+report, not deferred).
- Changing the Gem/archive or any materialize/deploy target.
- Codex hooks (Codex has no hook concept).
