# agentgem — Pack Archive Format: a manifest + filesystem the targets consume (Design)

**Date:** 2026-06-18
**Status:** Approved design, pre-implementation
**Project:** `agentgem` (`/Users/rfeng/Projects/ninemind/agentgem`)
**Scope:** Make a Pack a **durable, portable, verifiable on-disk artifact** instead of an ephemeral in-memory object. A pack becomes a directory — a human-authored `pack.json` manifest, a generated `pack.lock` for integrity, and artifact bodies as real files — that serializes to/from the existing `Pack` type. `materialize()` and `publish` are **unchanged**: they keep consuming a `Pack`, now optionally one loaded from an archive instead of built from a live introspection. The archive is the neutral upstream side of the existing canonical→harness seam, made persistable.

---

## 0. Motivation

Today a Pack is built fresh on every operation: `introspect(~/.claude) → buildPack → materialize | publish`. Nothing is ever persisted. The JSON wire form (`PackSchema`) inlines every artifact body as an escaped string — skill content, instructions, MCP configs all live inside one blob. That makes a Pack:

- **Non-portable** — you can't save, version-in-git, share, or install a pack later; it only exists for the duration of a request bound to a live `~/.claude`.
- **Hostile to authoring/diffing** — a 200-line SKILL.md as a JSON string is unreadable and produces noisy diffs.
- **Single-pipeline-coupled** — every consumer must rebuild from introspection rather than from a stable interchange artifact.

A Pack archive fixes all three at once and gives a clean producer/consumer split:

```
Produce:  introspect → buildPack(Pack) → writePackArchive(pack)  ─► [ archive on disk ]
Consume:  [ archive ] → readPackArchive() → Pack ─┬─ materialize(pack, target) → eve / flue / codex / claude on-disk
                                  (verifyLock)     └─ publish(pack)             → claude managed agents (network)
```

One archive → N deployments. The archive is the **interchange artifact**; a *deployment* is whatever `materialize`/`publish` produces from it for a specific harness.

## 1. Design decisions (locked)

1. **The archive is a serialization of the existing `Pack`, at the edges** — add `writePackArchive` / `readPackArchive`; `Pack` stays the in-memory hub and the single contract every consumer already takes. No target or publish code changes. (Rejected: making the archive tree the canonical contract and rewriting targets to read files directly — it would duplicate the artifact typing `types.ts`/`buildPack.ts` already own, for no gain.)
2. **Neutral canonical layout, deliberately not any harness's shape** — the archive is *not* the `claude` `.mcp.json`/`CLAUDE.md` layout nor Eve's `agent/…` layout. A neutral layout maps cleanly to *every* target; adopting one harness's shape would force un-translation to reach the others.
3. **Manifest + lock split** (package.json / package-lock.json model) — `pack.json` is human-authored and lists artifacts by **path**; `pack.lock` is generated and carries per-file `sha256` plus an overall `packDigest`. You edit files and re-bless the lock; integrity and authoring stay separated so body edits don't churn the manifest.
4. **Bodies are real files, never inline strings** — `skills/<n>/SKILL.md`, `instructions/<n>.md`; structured artifacts (`mcp`, `hook`, `checks`) are one JSON file each. Git-diffable, hand-editable.
5. **Secret-safe by construction** — the archive serializes an *already-redacted* Pack: `mcp/*.json` and `hook/*.json` carry redacted `config` + `secretRefs` (names only); `requiredSecrets` carries names + locations, never values. The whole tree is committable to git. (Same trust boundary as `materialize`.)
6. **Pure core returns a `FileTree`; the controller owns disk I/O** — `writePackArchive(pack): FileTree` and `readPackArchive(files: FileTree): Pack` are pure (same `Record<path,string>` `materialize` already returns). Disk read/write and tar (de)compression live in the controller, exactly as the harness-targets design keeps writing out of the pure layer.
7. **`packDigest` is the signable surface; signing itself is deferred** — `pack.lock` reserves a `signature: null` slot. We compute and verify a stable digest now (over canonicalized JSON + sorted file digests); actual signing is a future layer, not v1.
8. **Tar is the only transport form** — directory is canonical; `.tar.gz` is the single-file shipping form via a thin `packTar`/`unpackTar` over the same `FileTree`. (Zip skipped — YAGNI.)
9. **Additive surface** — a new `archive` op; `materialize`/publish ops gain an *optional* "load from archive path" input. No existing request shape breaks.

## 2. On-disk layout

```
mypack/
  pack.json                     # manifest (human-authored)
  pack.lock                     # integrity (generated)
  skills/<name>/SKILL.md        # SkillArtifact.content
  instructions/<name>.md        # InstructionsArtifact.content
  mcp/<name>.json               # { transport, config(redacted), secretRefs, source? }
  hooks/<name>.json             # { event, matcher?, config(redacted), secretRefs, source? }
  checks/<name>.json            # one PackCheck (behavioral | external)
```

Path segments are sanitized with the **same `safePathSegment`** rule already used in `targets.ts` (NFKC, `[^A-Za-z0-9._-]→_`, `.`/`..`/empty→`unnamed`). Name collisions after sanitization are handled exactly like materialize: the later artifact is dropped from the write with a recorded reason (writes never silently overwrite).

### `pack.json` (manifest)

```jsonc
{
  "formatVersion": 1,                 // archive schema version (bump on layout change)
  "name": "mypack",
  "version": "0.1.0",                 // semver of the pack itself (author-set)
  "createdFrom": "~/.claude",
  "artifacts": [
    { "type": "skill",        "name": "code-review", "path": "skills/code-review/SKILL.md" },
    { "type": "instructions", "name": "soul",        "path": "instructions/soul.md" },
    { "type": "mcp_server",   "name": "context7",    "path": "mcp/context7.json" },
    { "type": "hook",         "name": "fmt",         "path": "hooks/fmt.json" }
  ],
  "requiredSecrets": [
    { "name": "CONTEXT7_KEY", "artifact": "context7", "location": "headers.authorization" }
  ],
  "checks": [ { "name": "smoke", "path": "checks/smoke.json" } ]
}
```

The manifest is the index: every artifact and check is referenced by `type` + `name` + `path`. `requiredSecrets` is copied verbatim from the Pack (it is already names+locations only). Skill/MCP/hook/instruction *metadata* not carried in the body file (e.g. `SkillArtifact.description`, `McpServerArtifact.transport`) is preserved — instructions/skills via their file content + manifest entry; mcp/hook via the structured JSON body (so `transport`, `event`, `matcher`, `secretRefs` round-trip exactly).

> **Note on skill metadata:** `SkillArtifact` has `description?` and `source` beyond `content`. To keep `SKILL.md` a pure body and still round-trip losslessly, the manifest `artifacts[]` entry for a skill carries the extra fields it needs (`description?`, `source`). The plan will pin whether these live in the manifest entry or YAML frontmatter in `SKILL.md`; the spec mandates only that round-trip is lossless (§4).

### `pack.lock` (integrity, generated)

```jsonc
{
  "formatVersion": 1,
  "files": {
    "pack.json": "sha256:…",
    "skills/code-review/SKILL.md": "sha256:…",
    "instructions/soul.md": "sha256:…",
    "mcp/context7.json": "sha256:…",
    "hooks/fmt.json": "sha256:…",
    "checks/smoke.json": "sha256:…"
  },
  "packDigest": "sha256:…",     // hash over canonicalized manifest + sorted (path,digest) list
  "signature": null              // reserved; digest is what a signature will later cover
}
```

`packDigest` is computed over a **canonical** serialization: the manifest re-serialized with sorted keys, concatenated with the lexicographically-sorted list of `path → sha256` entries (every file *except* `pack.lock` itself). This makes the digest stable across key ordering, whitespace, and OS line endings, and makes it the exact thing a future signature signs.

## 3. Module API — `src/pack/archive.ts` (new, pure)

Mirrors `targets.ts`: pure functions over a `FileTree`, no disk I/O.

```ts
import type { Pack } from "./types.js";
export type FileTree = Record<string, string>; // shared shape with targets.ts

export interface PackLock {
  formatVersion: number;
  files: Record<string, string>;       // path → "sha256:…"
  packDigest: string;                  // "sha256:…"
  signature: string | null;            // reserved
}

export interface VerifyResult { ok: boolean; mismatches: string[]; missing: string[]; extra: string[] }

// Pack → in-memory archive tree (pack.json, pack.lock, and all body files).
export function writePackArchive(pack: Pack): FileTree;

// Archive tree → Pack, AFTER verifying the lock. Throws on integrity failure (controller decides
// whether a flag downgrades to a warning).
export function readPackArchive(files: FileTree): Pack;

// Recompute integrity for a tree (used by write, and to "bless" intentional edits).
export function computeLock(files: FileTree): PackLock;

// Compare a tree against a lock without rebuilding the Pack.
export function verifyLock(files: FileTree, lock: PackLock): VerifyResult;
```

`writePackArchive` builds the body files, then the manifest, then calls `computeLock` over the whole tree and emits `pack.lock`. `readPackArchive` parses `pack.json`, runs `verifyLock` against the embedded `pack.lock` (mismatch → throw with the offending paths), reattaches each body file to its artifact (`content` for skill/instructions; parsed JSON for mcp/hook/checks), and returns a `Pack` byte-for-byte equivalent to the one that was written.

Tar transport (thin, in the controller layer, not `archive.ts`):

```ts
// src/pack/archiveTar.ts (or inline in controller) — FileTree ⇄ .tar.gz buffer
export function packTar(files: FileTree): Buffer;
export function unpackTar(buf: Buffer): FileTree;
```

## 4. Round-trip contract (the core invariant)

```
readPackArchive(writePackArchive(pack))  deep-equals  pack
```

This identity is what proves "the archive *is* the Pack" and therefore "single source for all targets": any consumer fed `readPackArchive(dir)` sees exactly the Pack it would have gotten from `buildPack`. The plan's first test asserts this against the existing Pack fixtures (skills, instructions, mcp with `secretRefs`, hooks, checks, `requiredSecrets` all present). Lossiness anywhere (a dropped `description`, a coerced `transport`) fails this test.

## 5. Trust boundary

Identical to `materialize`: the archive **re-serializes an already-redacted Pack and never re-secrets**. `mcp/*.json` and `hooks/*.json` contain `<redacted>` placeholders where `secretRefs` point; `requiredSecrets` lists names+locations only. A test asserts no archive file contains a secret *value*. The runner rebinds real secrets from `requiredSecrets` at install — unchanged from today.

## 6. Surface — one new op + two augmented ops

| Op | REST | MCP tool | Shape |
|----|------|----------|-------|
| `archive` *(new)* | `POST /api/archive` | `archive` | `{ selection, name?, version?, dir?, projects?, format?: "dir"\|"tar" }` → writes archive, returns `{ files, lock, path? }` |
| `materialize` *(augmented)* | `POST /api/materialize` | `materialize` | now accepts **either** `{ selection, … }` (today) **or** `{ archivePath }` → `readPackArchive` then existing flow |
| `publish*` *(augmented)* | existing | existing | same optional `{ archivePath }` alternative to a live selection |

The handler for `archive` resolves dirs, `introspect`s, `buildPack`s, `writePackArchive`s, and (controller-side) writes the `FileTree` to `dir` — or `packTar`s it when `format:"tar"`. The augmented consumers gain one branch: if `archivePath` is given, load+verify the tree and `readPackArchive` instead of introspecting. No existing field changes meaning.

**Schemas (`src/schemas.ts`):** `PackManifestSchema`, `PackLockSchema`, `ArchiveRequestSchema`, `ArchiveResponseSchema`; an optional `archivePath` added to the materialize/publish request schemas (union, not a breaking edit).

**UI (`src/public/index.html`):** an **"Archive"** action beside Materialize that POSTs `/api/archive` and shows the produced tree (paths click-to-view via the existing modal) plus the `packDigest`. Out of scope for v1: a browser download of the tar (the runner/controller writes; consistent with materialize previewing rather than writing).

## 7. Module changes

- `src/pack/archive.ts` *(new)* — `PackLock`, `VerifyResult`, `writePackArchive`, `readPackArchive`, `computeLock`, `verifyLock`; reuses `safePathSegment` (extract to a shared util if not already shared with `targets.ts`).
- `src/pack/archiveTar.ts` *(new, optional split)* — `packTar`/`unpackTar`.
- `src/pack/types.ts` — no `Pack` shape change. (Manifest/lock types live in `archive.ts`.)
- `src/schemas.ts` — manifest/lock/archive schemas; optional `archivePath` on materialize+publish requests.
- `src/pack.controller.ts` — `@post("/archive", …)`; `archivePath` branch in materialize + publish handlers; disk write + tar.
- `src/public/index.html` — "Archive" action (tree preview + digest).

## 8. Testing

Following the per-module `__tests__` + controller (`@agentback/testing`) + gstack page-smoke pattern:

- **`src/pack/__tests__/archive.test.ts` (unit):**
  - **Round-trip identity** (§4): `readPackArchive(writePackArchive(pack))` deep-equals a fixture Pack covering all four artifact types + checks + `requiredSecrets`.
  - **Body extraction**: skill content lands at `skills/<n>/SKILL.md` (exact bytes); instructions at `instructions/<n>.md`; mcp/hook/check JSON files parse back to the exact objects (`transport`, `event`, `matcher`, `secretRefs` preserved).
  - **Lock**: `computeLock` produces a `sha256` per file and a `packDigest`; recomputed digest is stable across key reordering / trailing whitespace.
  - **Tamper detection**: mutate one body byte → `verifyLock` reports it in `mismatches`; `readPackArchive` throws naming that path. Re-`computeLock` "blesses" the edit and read succeeds.
  - **Secret safety**: no archive file contains a secret value; `<redacted>` present where `secretRefs` point.
  - **Collision**: two skills sanitizing to the same path → later one dropped with a recorded reason (no overwrite).
- **`src/pack/__tests__/archiveTar.test.ts`:** `unpackTar(packTar(tree))` deep-equals `tree`.
- **Controller (`@agentback/testing`, temp fake `~/.claude`):** `POST /api/archive {dir, selection}` returns a tree with `pack.json` + `pack.lock` + bodies and a `packDigest`; then `POST /api/materialize {archivePath, target:"eve"}` returns the Eve `agent/…` layout — proving archive→deployment with no live introspection. No secret value in either response.
- **Page (gstack at verify time):** load `/`, select a skill + an MCP server, click **Archive** → see `pack.json`/`pack.lock`/body paths and the digest; open `SKILL.md` in the modal.

## 9. Out of scope (named follow-ups, each its own spec)

These are deliberately *not* in this spec; the archive is built backend-agnostic precisely so they slot in without touching it. (See memory notes.)

1. **Flue target** (`materialize`, code-gen TypeScript) — a new `TargetSpec`: `agents/<n>.ts` via `createAgent()` + `skills/<n>/SKILL.md` + MCP connections (reusing `mcpProxy.ts` for stdio, like Eve). Layout known (flueframework.com). Parallels the Eve target.
2. **OpenAI SandboxAgent target** (`materialize`, code-gen TypeScript) — `new SandboxAgent({ instructions, mcpServers, capabilities:[skills(), filesystem()], defaultManifest })`; skills→capabilities+manifest entries, hooks→skipped. Distinct from the existing `codex` (Codex CLI: `AGENTS.md`+`config.toml`).
3. **Publish registry generalization** — refactor `publish.ts` into a `PUBLISH_REGISTRY` of `PublishTarget { render(pack)→payload; send(payload) }`, mirroring `TARGET_REGISTRY`. Earns its keep once a 2nd network backend exists.
4. **AWS Bedrock managed agents (OpenAI / AgentCore) publish backend** — a second `PublishTarget`. **Gated on AWS shipping the API** (currently limited preview, no published payload/SDK).

**Explicit non-goal — runtime workspace seed:** the pack archive carries agent *configuration* (skills/instructions/mcp/hooks/checks), **not** arbitrary runtime workspace files. OpenAI's sandbox `Manifest` (`entries: { "file.md": file({content}) }`) is a *different* manifest — "what's on disk when the agent wakes up," vs. the pack manifest's "what the agent *is*." (The Pack's `EvalSetup.files` is a narrow, check-only version of workspace seeding and stays scoped to checks.) Shipping packs with seed files, if ever wanted, is a separate deliberate extension.

Also out of scope: actual cryptographic **signing** (digest + reserved `signature` slot only), browser **download** of the tar, and a **pack registry / push-pull** transport (the archive is the unit a registry would later carry).

## 10. Platform fit

The archive turns a Pack from a request-scoped value into a **durable, verifiable, shareable artifact** — the interchange unit that decouples "build a pack once" from "deploy it to N harnesses, whenever, wherever." It does so with a small, pure addition (`archive.ts` + thin tar + one op) that leaves the entire target/publish machinery untouched, because the archive round-trips to the very `Pack` they already consume. Every harness reference checked during design (Eve, Flue, Codex, Claude managed agents, OpenAI sandboxes, Bedrock) maps off this one neutral artifact — which is the evidence the format is at the right altitude.
