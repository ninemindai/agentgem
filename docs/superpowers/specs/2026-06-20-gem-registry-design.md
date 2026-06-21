# Gem Registry — Design

**Date:** 2026-06-20
**Status:** Approved (brainstorm); pending implementation plan
**Approach:** A — "a capability is just a small Gem" (reuse the existing Gem + archive machinery as the registry item)

## Motivation

shadcn's thesis (X thread, June 2026): *agents are file graphs, and a registry is a protocol for distributing files*. The interesting, borrowable part is the **GitHub-backed registry** — a plain git repo serves as the registry (an index plus per-item archives), resolved client-side with no backend, supporting composition via `registryDependencies`, namespaces for private catalogs, and `--dry-run`/`--diff` as the trust surface.

agentgem already owns the two hard primitives this needs:

- A **content-addressed archive** — `writeGemArchive`/`readGemArchive`, `computeLock`/`verifyLock`, `gemDigest`, plus a `version` field and a `signature: null` slot that already anticipate distribution (`src/gem/archive.ts`).
- **Placement** — `materialize(gem, target)` renders a neutral Gem into any harness layout (`src/gem/targets.ts`).

What is missing is purely the distribution layer: an index, a resolver, a merge, and a git-repo-as-store convention. This design adds exactly that and nothing more.

### Decisions captured during brainstorming

- **Direction:** full round trip — publish to *and* install from a git-repo registry.
- **Granularity:** composable items with `registryDependencies` (shadcn's "real unlock"). A single-capability item and a whole multi-artifact Gem are the same kind of thing — a Gem — distinguished only by size.
- **Registry shape:** one registry repo + an index; `@scope/name` resolves to a path within it.
- **Visibility:** public *and* private (private via `GITHUB_TOKEN`), fetched uniformly through the GitHub API.
- **Install output:** user picks — materialize into a harness layout, *or* land the neutral Gem in the existing workspace store.

## Non-goals (YAGNI)

- New artifact types (subagents / channels / schedules) — a separate effort.
- Cryptographic signing — the `signature` slot is left in place for a future design; this work writes `null`.
- A hosted/browsable web catalog UI.
- Resolving across multiple registry sources in one install (the interface allows it later; v1 configures one source).
- Yank / delete semantics beyond per-version immutability.

## 1. Item refs & the registry index

**Ref grammar:** `@scope/name` or `@scope/name@<range>`, where `<range>` is an exact semver or a caret range (`^1.2.0`); a bare ref means `latest`. `scope` and `name` match `[a-z0-9-]+`.

**Single registry repo layout** — each item version *is* exactly today's Gem archive:

```
registry.json                          ← the index
items/<scope>/<name>/<version>/        ← gem.json · gem.lock · skills/… mcp/… instructions/… hooks/… checks/…
```

**`registry.json`** carries `gemDigest` and `dependencies` per version, so the resolver builds the full dependency graph from one small JSON and fetches only the archives it actually needs:

```json
{
  "formatVersion": 1,
  "items": {
    "@acme/github-search": {
      "latest": "1.2.0",
      "versions": {
        "1.2.0": {
          "path": "items/acme/github-search/1.2.0",
          "gemDigest": "sha256:…",
          "dependencies": ["@acme/http-base@^1.0.0"]
        }
      }
    }
  }
}
```

The index's `gemDigest` is the **integrity anchor**: a fetched archive whose recomputed `gemDigest` disagrees with the index is rejected, so the index cannot point at swapped content.

## 2. Schema change (`src/gem/archive.ts`)

Add a single optional field to `GemManifest`:

```ts
dependencies?: string[];   // item refs; absent on existing archives → backward-compatible
```

`writeGemArchive(gem, { version, dependencies })` writes it. The `Gem` type in `types.ts` stays untouched — `dependencies` is a property of a *published item*, not of composed in-memory content. A small new reader `readGemMeta(files) → { name, version, dependencies, gemDigest }` reads only `gem.json` + `gem.lock` for the resolver; `readGemArchive` is unchanged and is used by the merge step.

## 3. `RegistrySource` / `RegistryPublisher` (mirrors the `DeployTarget` idiom)

Pure logic plus an injected network client — the same split as `deploy.ts` ↔ `../publish.js`, following the existing kind-discriminated style:

```ts
interface RegistrySource {
  id: string;
  label: string;
  ready(): boolean;                              // repo configured; token present when private
  getIndex(): Promise<RegistryIndex>;
  fetchItem(path: string): Promise<FileTree>;    // one item version's archive files
}

interface RegistryPublisher {
  putCommit(files: FileTree, message: string): Promise<{ commit: string }>;  // item files + index in ONE atomic commit
}
```

- **`src/gem/registry.ts`** — pure: `parseRef`, `RegistryIndex` types, `resolveGraph`, `mergeGems`, `updateIndex`, the interfaces, and a `REGISTRY_SOURCE` env-config factory.
- **`src/gem/registryGithub.ts`** — the network client, isolated like `src/publish.ts` / `src/gem/agentcoreRun.ts`: fetch via the GitHub Contents API (`GET /repos/{owner}/{repo}/contents/{path}?ref=` — token-optional, so public and private resolve uniformly), commit via the Trees API (atomic multi-file). Configured by `AGENTGEM_REGISTRY_REPO` (`owner/repo`), `AGENTGEM_REGISTRY_REF` (default `main`), and `GITHUB_TOKEN`.

## 4. Resolution & merge — the only new algorithm (`src/gem/registry.ts`)

**`resolveGraph(rootRefs, index) → ResolvedGraph`**, working off the index alone:

- **Version selection:** exact or caret; pick the highest matching version. Two requesters with incompatible ranges raise a conflict error naming both requesters.
- **Cycle detection:** color-marked DFS; a cycle throws, listing the cycle path.
- **Dedup:** each `(ref, version)` is visited once.
- **Output:** items in topological order (dependencies before dependents).

**`mergeGems(orderedItems, source) → Gem`** — for each node: `fetchItem` → `verifyLock` → confirm the recomputed `gemDigest` matches the index → `readGemArchive` → fold artifacts in topological order:

- The same artifact reached via two paths (identical content digest) is silently deduped.
- A dependent declaring an artifact whose name collides with an **ancestor's** artifact ⇒ the dependent **overrides** (shadcn's override story), recorded in provenance.
- A same-name / different-content collision between **unrelated siblings** ⇒ error, naming both sources (reuses the collision-report shape already in `materialize` / `writeGemArchive`).
- `requiredSecrets` is unioned by `name`+`location`; `checks` are concatenated and deduped by name; `createdFrom = "registry:<rootRef>@<version>"`.

The result is an ordinary `Gem`, so it flows straight into the existing `materialize()` and `createWorkspace()` with no new placement code.

## 5. Publish flow (`src/gem/registry.ts` + `registryGithub.ts`)

`publishGem({ gem, scope, name?, version, dependencies?, publisher })`:

1. `writeGemArchive(gem, { version, dependencies })` → files.
2. Compute the item path `items/<scope>/<name ?? gem.name>/<version>/`.
3. Read the current index. **Immutability guard:** refuse to overwrite an existing version unless its `gemDigest` is identical (idempotent re-publish); bump `latest` when the new version is a higher semver.
4. `publisher.putCommit({ …itemFiles, "registry.json": updatedIndex }, message)` — one atomic commit.
5. Return `{ ref, version, gemDigest, commit, path }`.

## 6. Install flow & trust surface (`src/gem/registry.ts`)

`installGem({ refs, mode, target?, dest?, source })`, where `mode ∈ {"materialize", "workspace"}`:

- **Dry-run / diff (the trust surface):** `resolveGraph` produces a plan — items + versions, the dependency tree, total artifact count, and aggregated `requiredSecrets`. For `mode: "materialize"`, also return `materialize(mergedGem, target)`'s `{ files, skipped }` and, against an existing `dest`, an added / would-overwrite diff. This reuses `materialize`'s existing FileTree + skipped output — no new preview machinery.
- **Apply:** `mergeGems` (with per-item `verifyLock` and digest checks) → `Gem` → either write the materialized tree into `dest` (the `writeArchiveDir` / `renderTarget` path) or `createWorkspace(name, gem, { version })`.
- **Integrity:** every fetched archive is lock-verified; digests are checked against the index; secrets remain names-only (already redacted at capture). The `signature` slot is left for future signing.

## 7. API & MCP surface (`gem.controller.ts`, `gem.tools.ts`, `schemas.ts`)

Mirrors the existing `/deploy-targets` · `/publish-preview` · `/publish` shape:

- `GET /registry/ready` — is the source configured?
- `GET /registry/index` — browse the catalog.
- `POST /registry/resolve` — dry-run plan for refs (plus optional `target` ⇒ materialize preview).
- `POST /registry/install` — resolve + fetch + merge → materialize into `dest`, or land in a workspace.
- `POST /registry/publish` — publish a Gem (from a workspace or a request body).

Each endpoint gets a matching MCP tool in `gem.tools.ts` and zod schemas in `schemas.ts`.

## 8. Testing (`src/gem/__tests__/`)

- **Pure unit** tests with an in-memory fake `RegistrySource` / `RegistryPublisher` (FileTree maps): ref parsing, version selection, cycle detection, dedup, override-vs-sibling collision, index immutability, and secret / check merge — mirroring the existing `*.test.ts` style.
- **Integrity:** tamper a file ⇒ `verifyLock` fails; tamper an index digest ⇒ mismatch is rejected.
- **`registry.network.test.ts`** — gated / mocked, following the existing `publish.network.test.ts` pattern. No live GitHub calls in unit tests; the client is injected.

## File-change summary

| File | Change |
| --- | --- |
| `src/gem/archive.ts` | Add `dependencies?` to `GemManifest` + `writeGemArchive` opts; add `readGemMeta`. |
| `src/gem/registry.ts` | New. Pure: refs, index types, `resolveGraph`, `mergeGems`, `updateIndex`, `publishGem`, `installGem`, interfaces, `REGISTRY_SOURCE`. |
| `src/gem/registryGithub.ts` | New. GitHub Contents/Trees network client (token-aware). |
| `src/schemas.ts` | New zod schemas for the five `/registry/*` endpoints. |
| `src/gem.controller.ts` | Five `/registry/*` REST endpoints. |
| `src/gem.tools.ts` | Matching MCP tools. |
| `src/gem/__tests__/registry*.test.ts` | New pure + integrity tests; gated network test. |
