# Archive format

A Gem serializes to an archive with two parts: a **manifest** (`gem.json`) and a **lock**
(`gem.lock`). This split is what lets Gems compose — merging reconciles manifests and
re-resolves a single lock, rather than diffing opaque blobs. This page specifies the
on-disk format produced by `packages/archive/src/archive.ts`.

`ARCHIVE_FORMAT_VERSION` is currently `1`.

## File layout

`writeGemArchive(gem, opts?)` produces a flat map of POSIX paths → string content:

```
skills/<name>/SKILL.md       # skill body (markdown)
mcp/<name>.json              # { transport, config, source?, secretRefs? }
hooks/<name>.json            # { event, matcher?, config, source?, secretRefs? }
instructions/<name>.md       # instructions body (markdown)
checks/<name>.json           # one file per embedded GemCheck
gem.json                     # manifest
gem.lock                     # lock
```

Artifact names are run through `safePathSegment()` so they're safe as filenames; path
collisions are detected and surfaced as `skipped` rather than silently overwritten.

## The manifest — `gem.json`

The human-meaningful declaration of what the Gem contains:

```ts
interface GemManifest {
  formatVersion: number;
  name: string;
  version: string;
  createdFrom: string;
  artifacts: ManifestArtifactEntry[];   // { type, name, path, description?, source? }
  requiredSecrets: SecretRequirement[]; // { name, artifact, location } — names only
  checks: ManifestCheckEntry[];         // { name, path }
  dependencies?: string[];              // registry refs this Gem builds on
}
```

The manifest is an **index**: it lists what's in the archive and where, the declared secret
surface (by name), and any registry dependencies. It never contains secret values.

## The lock — `gem.lock`

The resolved, pinned detail that makes a build verifiable:

```ts
interface GemLock {
  formatVersion: number;
  files: Record<string, string>; // path -> "sha256:<hex>" for every file except the lock
  gemDigest: string;             // "sha256:<hex>"
  signature: string | null;      // reserved for future signing
}
```

### Digest computation

`computeLock(files)`:

1. Hashes each file's content as `sha256:<hex>`. The manifest is hashed via a **canonical
   stable JSON** serialization so logically-equal manifests hash identically regardless of
   key order.
2. Derives `gemDigest` deterministically from the sorted file paths and their hashes.

Because hashing is order-independent and tar packing uses sorted paths with a fixed mtime,
the same Gem always produces the same archive bytes and the same digest — important for the
registry's immutability check (a re-publish of an existing version with a different digest is
rejected).

## Reading and verifying

- `readGemArchive(files)` parses `gem.json` + `gem.lock`, calls `verifyLock`, and
  reconstructs the full `Gem` (artifacts, checks, required secrets).
- `verifyLock(files, lock)` returns `{ ok, mismatches, missing, extra }` — hash mismatches,
  files present in the lock but missing on disk, and files on disk not in the lock.
- `readGemMeta(files)` reads just `{ name, version, dependencies, gemDigest }` without
  reconstructing artifacts — used by the registry when indexing.

## Serialization

The file tree is format-neutral; two serializers turn it into bytes:

| Serializer | Functions | Use |
| --- | --- | --- |
| Directory | `writeArchiveDir` / `readArchiveDir` | Local workspaces and testbeds. `readArchiveDir` skips dot-prefixed entries (e.g. `.targets/`) and normalizes paths to POSIX. |
| Tar.gz | `packTar` / `unpackTar` | Transport, download, and registry storage. Deterministic: sorted paths, fixed mtime `0`, POSIX ustar. |

## Related

- [The build pipeline](pipeline.md) — how the Gem that gets archived is built
- [Registry](registry.md) — how archives are published, resolved, and merged
- [Redaction](redaction.md) — why `secretRefs` / `requiredSecrets` carry names, never values
