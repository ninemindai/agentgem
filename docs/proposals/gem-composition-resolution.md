# Artifact-level gem references — do we need `ref.kind: "gem"` at all?

_Draft 2026-07-08. Base: `origin/main` @ 91488a9e._

## What is already shipped (read this before proposing anything)

**Gem-to-gem composition works today.** `resolveInstall` (`packages/distribute/src/registry.ts:286`)
takes registry refs and produces a merged, materializable Gem:

- `resolveGraph` (`registry.ts:79`) — walks `manifest.dependencies`, selects versions (exact or `^`
  caret ranges via `selectVersion`), dedups diamonds, **throws on dependency cycles**
  (`registry.ts:101`) and on **version conflicts between two dependents** (`registry.ts:89`).
- `mergeGems` (`registry.ts:135`) — fetches each node, **verifies `gem.lock`** and re-checks that
  `computeLock(files).gemDigest` agrees with the registry index (`registry.ts:154`), then unions
  artifacts, checks and `requiredSecrets`.
- **Artifact name collisions are already decided.** Identical content via two paths dedups
  (`registry.ts:164`); a **dependent overrides its ancestor**, recording
  `provenance.overrides {artifact, winner, loser}` (`registry.ts:165-168`); two **unrelated** items
  defining the same name **throw** (`registry.ts:170`). Same rule for checks.
- Reachable by users: MCP tool (`src/gem.tools.ts:127,134`) and REST route
  (`src/gem.controller.ts:1175,1183`), in both `materialize` and `workspace` modes.
- Tested: `registryResolve.test.ts`, `registryMerge.test.ts`, `registryInstall.test.ts`.

So the correct statement of the gap is **narrow**, not architectural:

> `resolveArtifactRef` (`packages/model/src/artifactRef.ts:20`) returns
> `{ ok: false, reason: "gem reference resolution is not implemented yet" }` for
> `ref.kind: "gem"`. That is an **artifact-level, digest-addressed** reference — a Gem embedding
> *one artifact* pulled from *another Gem by `sha256:` digest* — and it is a different mechanism
> from the registry dependency graph, which merges **whole Gems** by `@scope/name@range`.

**This proposal is therefore mostly a question, not a plan.**

## The two mechanisms, side by side

| | registry dependency (`manifest.dependencies`) | artifact ref (`ArtifactRef.kind: "gem"`) |
|---|---|---|
| Granularity | whole Gem | one artifact |
| Addressing | `@scope/name@^1.2.3` (semver) | `sha256:<hex>` (content) |
| Resolution | `resolveGraph` + `mergeGems` — **shipped** | `resolveArtifactRef` — **not implemented** |
| Mutability | version can float within a caret range | immutable by construction |
| Merge policy | dependent overrides ancestor; unrelated collide → throw | undefined |
| Reachable | MCP tool + REST route | nothing calls it for `kind: "gem"` |

`ArtifactRef` (`packages/model/src/types.ts:118`) commits to content-addressing:

```ts
export interface ArtifactRef {
  kind: "package" | "gem";  // npx/npm package  |  registry gem digest
  id: string;               // e.g. "npx:@scope/pkg"  |  "sha256:<hex>"
  digest?: string;          // pinned in the lock at resolve time
}
```

## Goal

Decide whether artifact-level gem refs earn their existence, and if so, define resolution. The
honest default is **no**: duplication is cheaper than the wrong abstraction, and the registry graph
already delivers "gems build on gems."

### The case for `kind: "gem"` (steelman)

1. **Granularity.** Depending on a 12-artifact setup Gem to get *one* skill drags in eleven others,
   their `requiredSecrets`, and their collision surface. A ref to a single artifact is surgical.
2. **Immutability where it matters.** Registry deps use caret ranges, so a dependency's content can
   change under you within a minor version. A `sha256:` ref cannot. For a Gem sold on its
   proven-use record, "the thing I tested is the thing that ships" is a real property.
3. **It is already in the format.** `ReferenceArtifact` and `ArtifactRef.kind: "gem"` are in
   `types.ts` and in `GemArtifact`'s union. The archive can already carry one. Leaving a documented
   type permanently unresolvable is worse than either building it or removing it.

### The case against

1. **Two composition systems is one too many.** Every consumer (materialize, install, publish,
   royalty attribution) must now understand both. `mergeGems`' careful override/provenance rules
   would need a parallel implementation at artifact granularity, or the two would disagree.
2. **Nobody is asking.** There is no caller, no route, no test, no issue. The `package` kind is used;
   the `gem` kind never has been.
3. **Registry deps can express it with one more hop.** Publish the single skill as its own Gem and
   depend on it. That is the npm answer, and it keeps one graph, one merge policy, one royalty path.

## Recommendation

**Do not implement it. Narrow the type instead**, and revisit only when a real caller appears.

Concretely:

- Change `ArtifactRef.kind` to `"package"` only, and delete the `"gem"` arm of `resolveArtifactRef`.
  The `digest?` field stays — it is meaningful for `package` pinning too.
- If the type must be preserved for forward compatibility, keep it but change the failure text from
  *"not implemented yet"* (which reads as a TODO and misleads audits — it misled this one) to
  *"artifact-level gem refs are not supported; depend on the gem via manifest.dependencies"*, and
  add a test asserting that error.

**[DECIDE — remove the `"gem"` arm, or keep it as an explicit "unsupported"? Removing is honest and
reduces surface; keeping preserves the archive format's forward compatibility. Recommend removing:
`formatVersion` exists to make that safe.]**

## If we build it anyway — the sketch

Resolution must be **async** (a fetch by digest) while `materialize()` (`targets.ts:1013`) is
sync/pure/offline across 14 targets. So it cannot live inside `resolveArtifactRef`. It would be a
pass above, mirroring `resolveInstall`:

```ts
// packages/distribute/src/resolveArtifacts.ts
export async function resolveArtifactRefs(gem: Gem, source: RegistrySource): Promise<Gem>;
```

…fetching each `sha256:` digest, verifying via `readGemArchive` (which re-checks the lock), lifting
out the single named artifact, and splicing it in. It must reuse `mergeGems`' collision rule rather
than inventing a second one. A content-addressed cache (`~/.agentgem/cache/gems/<digest>.gem`) never
invalidates, which is the one genuinely nice property here.

## A real gap found while writing this

`publishGem`'s `dependencies` are **caller-supplied and unverified**. `gem.tools.ts:27` accepts
`dependencies: z.array(z.string()).optional()` and passes it straight through
(`gem.tools.ts:144`). Nothing checks that the declared dependencies correspond to anything the Gem
actually references, and nothing derives them from the Gem's content.

That matters beyond tidiness: **`manifest.dependencies` is the royalty attribution graph.** A
publisher can today declare no dependencies while building entirely on someone else's Gem, or
declare spurious ones. It is tamper-*evident* (the manifest is inside `gemDigest` via `computeLock`
at `archive.ts:46-56`, so it cannot be changed after publish) but it is not *verified* at publish
time.

Before royalties ship, `publishGem` should derive the dependency list from the Gem — or at minimum
reject a publish whose declared deps disagree with its resolved graph. **This is a smaller, more
tractable, and more urgent piece of work than artifact-level refs**, and it is the one that actually
gates "royalties compose."

## Open questions

1. **Do royalties flow along `dependencies` (whole-Gem) or along artifact provenance
   (`provenance.overrides` / per-artifact owner)?** `mergeGems` already knows which item owns each
   surviving artifact. Attribution by *artifact actually used* is fairer and more defensible than
   attribution by *declared dependency*, and the data is already there.
2. **Should `resolveInstall` record the resolved graph into the installed workspace?** Today the
   `InstallPlan` is returned to the caller and not persisted. Per-call royalty accounting needs to
   know, at run time, what the running Gem was composed from.
3. **Caret ranges vs digests for dependencies.** The registry allows `^1.2.3`; proven-use and royalty
   correctness both argue for pinning the resolved digest into the dependent's lock (npm's
   `package-lock` split). `RegistryItemVersion` already carries `gemDigest` per version, so the data
   exists.
