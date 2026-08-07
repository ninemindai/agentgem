# Gem Archive v2 — Agent Plugins Alignment

**Date:** 2026-08-07
**Status:** Approved design, pre-implementation
**Builds on:** `2026-06-18-gem-archive-format-design.md` (archive format v1)

## Goal

Make every written gem archive simultaneously a conformant [Agent Plugin
1.0.0](https://agent-plugins.org/specification) — the vendor-neutral packaging
spec stewarded by Amazon, Cursor, Microsoft, OpenAI, Vercel, and Google — and
accept any conformant Agent Plugin as an importable Gem. AgentGem's richer
format (subagents, hooks, rubrics, games, checks, lock/digest, secrets) stays
the source of truth; the spec-shaped surface (`plugin.json`, `skills/`,
`mcp.json`) becomes a portable projection that any compliant client can consume
directly.

Non-goals: an ARD/AI Catalog discovery integration; surfacing the importer in
console UI (an entry point is chosen in the implementation plan, the UI around
it is not); migrating published v1 archives.

## Layout (formatVersion 2)

```
my-gem/
├── plugin.json        # generated: { $schema, name: <slug>, version }
├── mcp.json           # generated iff ≥1 portable MCP server; spec-shaped
├── skills/<n>/SKILL.md            # unchanged (already spec-compatible)
├── gem.json           # source of truth, formatVersion: 2
├── gem.lock           # unchanged mechanics; covers plugin.json + mcp.json
├── instructions/ agents/ hooks/ channels/ refs/ games/ rubrics/ checks/
└── mcp/<n>.json       # only for non-portable servers (fallback)
```

`ARCHIVE_FORMAT_VERSION` becomes 2; `gem.json` and `gem.lock` both carry it.

Invariants preserved from v1:

- `readGemArchive(writeGemArchive(gem)) == gem` (structural equality, and only
  when the write reported zero `skipped` artifacts — colliding artifacts were
  already lossy in v1). The Gem is reconstructed from `gem.json` + body files
  only. `plugin.json` is derived output: written, lock-verified, never read
  back.
- Serialization stays at the edges (`packages/archive`); `materialize`/
  `publish` still take a `Gem` and need no changes.
- Secret-safety: archives serialize an already-redacted Gem.
- Deterministic output: `plugin.json` content is a pure function of the Gem
  and version (no timestamps), so unchanged gems produce unchanged digests
  across repeated v2 writes.

## plugin.json

Minimal, closed-schema-conformant manifest:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "<pluginNameSlug(gem.name)>",
  "version": "<same version as gem.json>"
}
```

`pluginNameSlug()` (new, `packages/model/src/targets.ts` beside
`safePathSegment`): NFKC-normalize → lowercase → replace chars outside
`[a-z0-9.-]` with `-` → collapse consecutive `-` and `.` runs → trim leading/
trailing non-alphanumerics → clamp to 64 chars (re-trim after clamp) →
fallback `"gem"` when empty. No `description`/`author`/`keywords` until the
Gem type carries those fields (YAGNI).

## mcp.json — single source of truth for portable servers

A `McpServerArtifact` is **portable** when its redacted `config` supplies the
spec's required fields:

- `stdio`: `config.command` is a non-empty string.
- `http` / `sse`: `config.url` is an absolute `http(s)` URL (per spec:
  non-loopback requires `https`).

**Portable server (write):** body goes only into `mcp.json` under its
`safePathSegment` name key; the reader resolves entries by the same derived
key. Two servers slugging to the same key is a collision — the later one is
skipped with a `SkippedArtifact`, matching `place()`'s path-collision
semantics. Transport maps `stdio → "stdio"`,
`http → "streamable-http"`, `sse → "sse"`. Recognized config keys are copied
when shape-valid: `command`, `args` (string[]), `env` (string map), `cwd` for
stdio; `url`, `headers` (string map) for http/sse. `cwd` is additionally
pattern-gated — the official schema requires it to start with `./`,
`${PLUGIN_ROOT}`, or `${PLUGIN_DATA}`, so the absolute paths mined configs
usually carry ride in `extra` instead. The spec schema is closed, so
everything else moves to the server's `gem.json` manifest entry:

```json
{ "type": "mcp_server", "name": "...", "path": "mcp.json",
  "source": "...?", "secretRefs": [...]?, "extra": { ...unrecognized-or-wrong-shaped config keys... } }
```

Reserved-name guard: the spec invalidates servers whose `env` contains
`PLUGIN_ROOT` or `PLUGIN_DATA` — such entries stay in `extra` rather than
`mcp.json`'s `env`.

**Portable server (read):** `config` = spec fields from the named `mcp.json`
entry (transport-mapped back, spec `type` key dropped) merged with `extra`.
The merge restores the original `config` object structurally (key order is
immaterial: digest hashing canonicalizes via `stableStringify`).

**Non-portable server:** keeps the v1-style `mcp/<n>.json` body file and is
omitted from `mcp.json` — mirroring the spec's own skip-and-continue
component semantics. If no server is portable, `mcp.json` is not written.

`mcp.json` carries `"$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"`.

## Secrets

`config` is redacted before serialization (secrets live as `secretRefs`
name+location pairs), so `mcp.json` ships redacted values. That is spec-legal:
unrecognized `${...}` text stays literal, and the spec declares env/headers
"visible package data, not a secret mechanism". Foreign clients get the server
minus secrets; AgentGem's materialize step keeps injecting real values.
No new leakage surface.

## Reading & migration

`readGemArchive` dispatches on `gem.json` `formatVersion`:

- `1` (or absent): current code path, unchanged — published registry archives
  stay readable indefinitely. `mcp_server` entries resolve from `mcp/<n>.json`.
- `2`: new MCP resolution as above; all other artifact types unchanged.
- Anything else: error (same posture as today's unknown-artifact-type error).

`readGemMeta`, lock computation/verification, and the tar/fs layers are
unchanged — `plugin.json` and `mcp.json` are ordinary lock-covered files.
New v2 writes produce new `gemDigest`s (expected for a format bump);
existing published digests are untouched, and no re-publish is required.

Manifest-allowlist gotcha (from v1 hard-won experience): the new
`mcp_server` entry fields (`extra`) and the v2 write/read paths must be
covered by the digest-safety test so that gems without MCP servers remain
**byte-identical** between consecutive v2 writes.

## Import adapter

New `readAgentPlugin(files: FileTree): { gem: Gem; skipped: SkippedArtifact[] }`
in `packages/archive`, accepting any conformant plugin directory tree:

- `plugin.json`: required; checked by a hand-rolled closed-schema validation
  (known-field set + the official name pattern) — deliberately NOT strict ajv
  validation, because the spec makes unknown top-level fields non-fatal:
  they are reported via a `notes: string[]` channel (manifest-level
  diagnostics; `SkippedArtifact` is reserved for per-component failures).
  Invalid `name` or missing/unparseable manifest → `InvalidInputError`.
  `name`/`version` seed the Gem; `createdFrom` is the model's free-form
  provenance string (e.g. `Imported from Agent Plugin '<name>' v<version>`).
- `skills/`: each immediate child directory containing `SKILL.md` becomes a
  `SkillArtifact` (no recursion, per spec discovery rules). Extra files under
  a skill dir (`scripts/`, `references/`) land in the existing
  `SkillArtifact.files` field, which v2 serializes (see below) so a subsequent
  write preserves them. Invalid skills → `SkippedArtifact`.
- `mcp.json`: optional; each server maps back to a `McpServerArtifact`
  (`streamable-http → http`). Unsupported/invalid entries → `SkippedArtifact`,
  isolation per spec.
- Extension namespace dirs (`com.example.*`) and unknown root files are
  ignored, per spec conformance rules.

The result is a plain Gem: gradeable, publishable, and writable as a v2
archive. Decision (recorded from the implementation plan): the user-facing
entry point (likely a SourceSpec adapter next to the existing multi-agent
source adapters) ships as a follow-up branch — `readAgentPlugin` is the
library seam this iteration delivers.

Resolved during planning: v1 archives silently **drop** `SkillArtifact.files`
(sibling `scripts/`/`references/` files — the field exists in the model but
was never added to the manifest allowlist). v2 fixes this: each sibling file
is placed at `skills/<n>/<relative-path>` (collision-checked, `..`-free), the
skill's manifest entry lists the relative paths in a new `files: string[]`
field (plus `filesTruncated` when set), and read restores them. Skills
without sibling files serialize byte-identically to before.

## Wire-schema mirrors (found in engineering review)

The "serialization stays at the edges" framing missed that archive/artifact
shape is *also* mirrored in `packages/app/src/schemas.ts`, whose Zod
boundaries strip unknown keys by design. `SkillArtifactSchema` must gain
`files`/`filesTruncated`, and `GemManifestArtifactSchema` must gain the v2
entry fields (`files`, `filesTruncated`, `secretRefs`, `extra`, `metadata`)
plus the artifact kinds its enum already lags behind on (`game`, `rubric`,
`reference`). Otherwise skill sibling files and MCP extras are silently
stripped at publish/install boundaries — the known silent-strip bug class.
Guarded by a preserve-not-strip test in the style of the existing
`contract.schema.test.ts`.

## Error handling

- Write: unchanged collision/skip semantics (`SkippedArtifact`).
- Read v2: `mcp.json` missing while a manifest entry points at it, or a named
  server absent from it → error (same posture as today's
  "manifest references missing file").
- Import: plugin-level schema violations fatal (`InputError`);
  component-level failures isolated as `SkippedArtifact` — matching the
  spec's failure-handling table.

## Testing

1. **Round-trip:** v2 write→read equality for gems with mixed portable and
   non-portable MCP servers, `extra` merge fidelity, secretRefs preservation,
   and every other artifact type unchanged.
2. **Digest safety:** consecutive v2 writes of the same Gem are
   byte-identical; v1 archive fixtures still read (including one whose MCP
   server lives at `mcp/<n>.json` — the read branch v2 rewrites); v2 writes
   produce new digests (new derived files + relocated MCP bodies, i.e. the
   format bump in the broad sense).
3. **Conformance:** vendor the published `plugin.schema.json` and
   `mcp.schema.json` (1.0.0 URIs are immutable per spec) as test fixtures and
   validate generated `plugin.json`/`mcp.json` against them with `ajv`
   (**new dev-only dependency** — flagged deliberately; nothing in the
   existing zod stack validates foreign JSON Schema documents).
4. **Import:** fixture plugin built from the spec's own examples, including
   an extension-namespace dir to ignore, an invalid server to skip, and a
   skill with `scripts/` to preserve; `pluginNameSlug` edge cases (unicode,
   leading/trailing separators, >64 chars, all-illegal input).

## Decisions called out

- **Portable MCP bodies move out of `mcp/<n>.json`** — a real v2 format
  change, not an addition; v1 read support is what makes it safe.
- **v1 stays read-supported indefinitely** rather than migrating published
  archives.
- **`plugin.json` is write-only** — never consulted when reading a gem
  archive, so hand-edits to it cannot desync a Gem (the lock still catches
  tampering).
- **`ajv` (dev-only)** added for schema-conformance tests.
