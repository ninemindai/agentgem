# Rename `Gem` → `Gem`

**Date:** 2026-06-19
**Status:** Approved (design)

## Goal

Rename the core domain concept from **`Gem`** to **`Gem`** across the whole
codebase. The project is named `agentgem`; "agentgem produces a **gem**" reads
naturally, whereas reusing `agentgem` as the concept noun would be circular.

A `Gem` is the portable bundle of agent artifacts (skills, MCP servers,
instructions, hooks) plus embedded checks and a declared secret surface — the
neutral source that all targets / publish / deploy consume.

## Scope

All surfaces are in scope:

1. **Code symbols + files** — internal, non-breaking.
2. **MCP tool name** — `@tool("gem")` → `@tool("build_gem")` (agent-visible).
3. **On-disk archive format** — `gem.json`/`gem.lock`/`gemDigest` →
   `gem.json`/`gem.lock`/`gemDigest`. **Breaking; clean break, no read-compat
   shim** (project is ~5 days old, no published archives in the wild).
4. **Docs + memory** — `docs/superpowers/**` files and the auto-memory.

## Naming scheme

This is a **curated rename by symbol class — not a blind `s/gem/gem/g`.**

### Renamed (Gem concept)

| Old | New |
|---|---|
| `Gem` (interface) | `Gem` |
| `PackArtifact` | `GemArtifact` |
| `PackCheck` | `GemCheck` |
| `PackVerificationReport` | `GemVerificationReport` |
| `PackLock` | `GemLock` |
| `PackManifest`, `PackManifestArtifact` | `GemManifest`, `GemManifestArtifact` |
| `PackSelection` | `GemSelection` |
| `PackController` | `GemController` |
| `PackTools` | `GemTools` |
| `PackInput` | `GemInput` |
| `PackSchema`, `PackRequestSchema`, `PackSelectionSchema`, `PackCheckSchema`, `PackManifestSchema`, `PackManifestArtifactSchema`, `PackLockSchema`, `PackArtifactSchema` | corresponding `Gem*Schema` |
| `buildPack` | `buildGem` |
| `writePackArchive` / `readPackArchive` | `writeGemArchive` / `readGemArchive` |
| `gemDigest` (field + locals) | `gemDigest` |
| `packName` / `packname` | `gemName` |
| Test fixtures `mypack` / `my_pack` | `mygem` / `my_gem` |
| lowercase `gem` used as the noun (variables, comments, prompt strings like "gem-loaded agent") | `gem` |

### Files renamed

| Old path | New path |
|---|---|
| `src/gem/` (directory) | `src/gem/` |
| `src/gem.controller.ts` | `src/gem.controller.ts` |
| `src/gem.tools.ts` | `src/gem.tools.ts` |
| `src/gem/buildPack.ts` | `src/gem/buildGem.ts` |
| `src/__tests__/gem.controller.test.ts` | `src/__tests__/gem.controller.test.ts` |
| `src/gem/__tests__/buildPack.test.ts` | `src/gem/__tests__/buildGem.test.ts` |
| `docs/superpowers/plans/2026-06-16-gem-checks.md` etc. (5 doc files matching `*gem*`) | `*-gem-*` equivalents |

Imports referencing `./gem/...`, `../gem/...`, `./buildPack` must be updated to
the new paths.

### Deliberately NOT renamed

These contain the letters "gem" but are **not** the Gem concept:

- `packTar`, `unpackTar`, `unpacked`, `unpacks` — the generic **tar** verb
  ("packing a tarball"). `writeGemArchive` may *call* `packTar`; that's correct.
- Anything containing `package`: `allow_package_managers`, `packageManager`,
  `package.json`, npm "package" references.

A reviewer must confirm no `package*` or `*Tar` identifier was altered.

## On-disk format change

In `src/gem/archive.ts` (formerly `src/gem/archive.ts`):

- `MANIFEST_PATH = "gem.json"` → `"gem.json"`
- `LOCK_PATH = "gem.lock"` → `"gem.lock"`
- Lock field `gemDigest` → `gemDigest`
- Error strings: `"archive missing gem.json"` → `"archive missing gem.json"`,
  `"gem.lock verification failed …"` → `"gem.lock verification failed …"`,
  and the `mismatches.push("gemDigest")` → `"gemDigest"`.

No backward-compatible reading of legacy `gem.json`/`gem.lock`.

## MCP tool change

In `src/gem.tools.ts`:

- `@tool("gem", …)` → `@tool("build_gem", …)`
- default name fallback `input.name ?? "gem"` → `?? "gem"`
- The sibling `@tool("inventory", …)` is unchanged.

## Docs + memory

- Rename the 5 `*gem*` files under `docs/superpowers/plans/` and
  `docs/superpowers/specs/` to `*gem*` and update their prose.
- Update the auto-memory: rename/rewrite `gem-archive-format-spec.md`
  (now describing `gem.json`/`gem.lock`/`gemDigest`) and refresh the
  `MEMORY.md` index line. Other memory files that mention "Gem" in prose
  (target fast-follows) get a light prose pass.

## Execution approach

Curated find-replace per symbol class (longest/most-specific identifiers first to
avoid partial-match damage, e.g. replace `PackArtifactSchema` before `Gem`),
then `git mv` for file/dir renames, then fix imports.

Order:
1. Rename files/dirs with `git mv` (preserves history).
2. Replace identifiers per the table, specific-before-general.
3. Update on-disk strings and the MCP tool name.
4. Update docs + memory.

## Testing / verification

The existing vitest suite is the safety net (it already covers archive,
buildPack/buildGem, checks, deploy, targets, workspaces, schemas, publish).

- `pnpm build` (tsc) must pass — catches missed imports/symbols.
- `pnpm test` must pass — including archive round-trip tests now asserting
  `gem.json`/`gem.lock`/`gemDigest`.
- Final grep gate: `grep -rInE '\b[A-Za-z_]*[Pp]ack[A-Za-z_]*\b' src` returns
  **only** intentional `*Tar`/`unpack*`/`package*` matches.

## Out of scope

- No behavioral changes. Pure rename.
- No new compatibility layer.
- The repo / npm package name `agentgem` is unchanged.
