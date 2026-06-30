# Proposal: Full decomposition of the backend into monorepo packages

Status: proposed · Author: derived from a dependency audit of `src/` at v0.3.1

This proposal breaks the single root package (`@ninemind/agentgem`, ~10.2k LOC under
`src/`) into a set of workspace packages along the seams the code already has. It is the
"full decomposition" path: the framework-agnostic kernel (`src/gem/`) is split by bounded
context, not left as one library. For the conceptual map of the layers being split, read
[Architecture](../architecture.md) first.

## Why now

`src/gem/` is already a clean, framework-agnostic kernel — but it's a flat bag of 54
files spanning ~10 distinct concerns, built and shipped as one unit. Splitting it lets us:

- **Publish/embed the engine** without dragging in a web framework (the desktop app, the
  CLI, and the MCP server all embed this logic).
- **Isolate heavy dependencies** behind the package that actually needs them — Postgres
  (`aggregator`), AWS Bedrock (`deploy`), NATS (`transfer`), MCP SDK (`mcpProxy`).
- **Deploy independently** — the aggregator is a separate service (Render + Neon) and
  shouldn't share a release unit with the local console app.
- **Enforce layering** — the import direction below is currently a convention; packages
  make it a compile error to violate.

This was previously deferred (the kernel split was on hold; only the React `console`
workspace was carved out). This proposal revisits it with the dependency graph measured
rather than assumed.

## What the dependency audit found

All figures are from a static import-edge scan of `src/` (tests excluded).

- **Clean top-level DAG.** `gem/` imports nothing from its siblings; `aggregator/`,
  `transfer/`, and `distill/` all import *into* `gem/`. No cross-directory cycles.
- **The kernel is framework-agnostic** — only 3 of 54 `gem/` files touch a web framework:
  `mcpProxy.ts` and `targets.ts` import `express`; `inputError.ts` is shaped around
  `@agentback/rest` error semantics. All other `@agentback` coupling lives in the 3
  controller-layer files (`gem.controller.ts`, `aggregator.controller.ts`, `gem.tools.ts`)
  plus `index.ts`.
- **The kernel's internal graph is an 8-layer DAG** (verified via Tarjan SCC) with only
  three 2-node cycles, each *inside* a single domain: `{acpRun ↔ sandbox}`,
  `{deploy ↔ agentcorePublish}`, `{acpRecommender ↔ distill}`. These never cross the
  proposed package lines, so they don't block decomposition.
- **`targets.ts` is the central hub** (`channels`/`toml`/`mcpProxy`/`types` below it;
  `archive`, `registry`, `run`, `share`, `buildGem` above it). It belongs in the
  foundation package.
- **Materialize-target SDKs are codegen, not runtime deps.** `targets.ts` references
  `eve`, `@flue/runtime`, `@openai/agents`, `@a2a-js/sdk`, and `ai` only inside emitted
  code strings — its real imports are just `channels`, `toml`, `mcpProxy`, `types`. So a
  `targets` split yields little dependency isolation; the genuine heavy-dep boundaries are
  `aggregator`, `deploy`, `transfer`, and `mcpProxy`.

## Target shape

Domain-bounded packages (grouped by bounded context, not by graph layer, to keep the
count manageable). Dependency arrows point *down*; the package graph is a DAG.

```
packages/
  model        types, inputError, channels, toml, canonicalize, targets,
                 mcpProxy, binPath, identity
                 └ the gem format + materialize-target codegen. Foundation; no deps.
  capture      introspect, redact, scrub, configAccess, credentials, recents,
                 globalUsage, usageCache, workspaces            → model
  archive      archive, archiveFs, archiveTar, attestation, attestationArchive → model
  build        buildGem, checks, draftStage, gemVerify          → model, capture, archive
  distribute   registry, registryGithub, share, search, ingestClient, safeFetch → model, archive
  run          run, runGem, acpRun, acpSession, sandbox, sandboxLaunch,
                 testbed, testbedFlavors                        → model, archive, build
  insight      workflowScan, observeScan, analysisCache, distill, distillTypes,
                 extract, reflectionStore, acpRecommender        → model, capture
  deploy       deploy, deployRecord, agentcorePublish, agentcoreRun  (isolates @aws-sdk) → model
  ── edge / app ──
  aggregator   src/aggregator/*  (isolates drizzle/pg/pglite; deploys independently) → model
  transfer     src/transfer/*    (isolates @nats-io)            → model, distribute
  console      (exists) React SPA
root @ninemind/agentgem
                 controllers, gem.tools, index, streams, schemas, originGuard, 2 bins
                 └ the @agentback REST/MCP server that composes everything above
```

## Phasing

Each phase ships green (the suite is `tsc -b && vitest run`) and is independently
reversible.

0. **De-leak the kernel.** ✅ *Verified a no-op (no code change needed).* The apparent
   `express`/`@agentback` coupling in `mcpProxy.ts`/`targets.ts`/`inputError.ts` lives
   only inside codegen template strings and a comment — not module-level imports. The
   kernel was already framework-free at the module level. (A file-level grep mis-flagged
   the template strings; reading the module scope cleared it.)
1. **Extract `model`.** ✅ *Shipped on branch `pkg-split-model`.* The 9-file, import-closed,
   zero-runtime-dep foundation moved to `packages/model`; 76 consumer imports rewritten to
   `@agentgem/model` (barrel); wired via TS project references + `workspace:*`. Full build +
   722 tests green. The repo's first compiled runtime workspace package.

   > **Publish caveat:** the root package publishes to npm, so its new `workspace:*` dep on
   > the private, unpublished `@agentgem/model` must be resolved before publish — either
   > publish `@agentgem/model` publicly (lockstep version) or bundle it into the root `dist`
   > at pack time.
2. **`archive` (the one true leaf).** ✅ *Shipped on `pkg-split-model`.* Extracted
   `packages/archive` = `{archive, archiveFs, archiveTar}` (deps: model only); 18 consumer
   imports rewritten to `@agentgem/archive`. Full build + 722 tests green.

   > **Plan correction (measured post-Phase-1):** the original "leaf domains: capture,
   > archive, deploy — parallelizable" framing was wrong against the real import graph.
   > Only `archive`-core is a model-only leaf. `attestation`/`attestationArchive` import
   > `workflowScan` (insight), so they defer with insight. **`capture` is not a leaf** — it
   > pulls `../resolveDir` (a top-level node-only helper that should move into `model`),
   > `sandboxLaunch` (run), `testbedFlavors` (testbed), `workflowScan` (insight), and
   > `archive`. **`deploy` is near the top** (its `agentcoreRun` imports `run`, `archive`,
   > `workspaces`), not a leaf — it extracts near-last.

   Corrected bottom-up order (by real dependency layer):
3. **`resolveDir` → `model`.** ✅ *Shipped.* Moved the node-only path helper
   (`resolveDir`/`resolveProject`/`resolveDirs`/`agentgemHome`) into `model`; 16 refs
   rewritten. It had ~12 kernel dependents and was the dominant shared blocker.
4. **`distribute`** (`registry`, `registryGithub`, `share`, `search`, `safeFetch`,
   `publish`) → deps: model, archive. ✅ *Shipped on `pkg-split-model`.* 39 imports across
   23 files rewritten via a resolution-aware codemod (basename rewrite was unsafe: `publish`
   exists in both `gem/publish.ts` and the top-level `src/publish.ts`). **`ingestClient`
   deferred** — it imports `attestation`, whose only tie to insight is a type-only
   `import type { WorkflowSignal }`; `ingestClient` + `attestation*` fold in with `insight`
   (relocating `WorkflowSignal` into `model` was rejected — it drags `ArtifactUsage`/
   `SessionSequence`/`ProcedureGroup` and would pollute `model`'s conceptual integrity).
5. **`testbed`** = `{testbed, testbedFlavors}` → deps: model only. ✅ *Shipped* (after
   step 3 unblocked `testbedFlavors → resolveDir`). 10 refs across 6 files rewritten.
6. **`base`** = `{workspaces, deployRecord, acpSession, redact}` → deps: model, archive.
   ✅ *Shipped (chosen approach: base-first).* The genuinely cross-domain helpers:
   `acpSession` (run+insight — the enabler for splitting them), `workspaces`
   (run+deploy+capture), `deployRecord` (run+deploy), `redact` (capture+build). 24 refs
   across 17 files. **Excluded** (not cross-cutting): `scrub` (insight-only → goes to
   insight), `buildGem` (build domain), `gemVerify` (run; and `gemVerify → acpRun` would
   pull run into base).
7. **`build`** = `{buildGem, checks}` → deps: base, model. ✅ *Shipped.* `draftStage`
   stayed in `gem` (a server-level consumer of both build + insight — keeping it in `build`
   would create a `build ↔ insight` cycle via `draftStage → distill`).
8. **`run`** = `{run, runGem, acpRun, sandbox, sandboxLaunch, gemVerify, configAccess}` →
   deps: base, model, archive, testbed. ✅ *Shipped.* `configAccess` (used only by `sandbox`,
   and itself `→ sandboxLaunch`) was folded in to close the package.
9. **`insight`** = `{workflowScan, scrub, observeScan, analysisCache, distill, distillTypes,
   extract, reflectionStore, acpRecommender, attestation, attestationArchive, ingestClient}`
   → deps: base, model, archive, **build** (`acpRecommender → buildGem`). ✅ *Shipped.* This
   finally resolved the long-deferred `attestation*`/`ingestClient` (the `WorkflowSignal`
   type-edge is now intra-package). 57 refs across 28 files rewritten.
10. **`capture`** (remnant in `gem`: `introspect, credentials, recents, usageCache,
    globalUsage`, + `draftStage`) → deps: base, model, testbed, insight. ✅ *Shipped.*
11. **`deploy`** = `{deploy, agentcorePublish, agentcoreRun, publish}` (the top-level
    `src/publish.ts` — Anthropic managed-agent publish — folded in as a deploy target) →
    deps: archive, base, distribute, model, run; isolates `@anthropic-ai/sdk` +
    `@aws-sdk/client-bedrock-agentcore-control` (dynamic import). ✅ *Shipped.* **`src/gem/`
    source is now empty** — all 11 domain packages extracted; only `gem/__tests__` remain.
12. **Edges:** `aggregator` (`src/aggregator/*` → deps: insight, model, drizzle-orm, pglite)
    + `transfer` (`src/transfer/*` → deps: distribute, model, `@nats-io/*`). ✅ *Shipped.*
    Root collapsed to the server/wiring only: controllers (`gem.controller`,
    `aggregator.controller`, `gem.tools`), `index`, `schemas`, `originGuard`, `pickFolder`,
    the SSE streams, and the CLIs/bins (`cli` → `agentgem`, `distill/mcpServer` →
    `agentgem-distill`, `bind/`). **Decomposition complete: 12 `@agentgem/*` packages +
    `@agentgem/console` + the root server.**

## Final package graph

```
model
 ├─ archive ── distribute ── transfer
 ├─ testbed
 └─ base
       ├─ build ── insight ──┬─ capture
       ├─ run ───────────────┤
       │                     └─ aggregator
       └─ deploy ←(archive, distribute, run)
root @ninemind/agentgem  →  depends on all; owns controllers + index + schemas + 2 bins
```

> **Known flaky test (pre-existing, not from the split):** `distill.test.ts >
> distillWorkflow resilience` intermittently fails (~1/4 full runs; passes in isolation).
> Cause: `reflectionStore.writeReflections` defaults its base to `agentgemHome()` (the real
> `~/.agentgem`), and two distill describe-blocks share `root: "/r"` → same `<root-hash>.json`
> → a write race across parallel vitest workers. Fix (follow-up): thread a temp base through
> `distillWorkflow` in tests, or have tests pass an explicit `base`.

## Tradeoffs

11 packages for ~10k LOC and a small team is real ceremony: 11 `package.json` + `tsconfig`
files, a project-reference graph, `workspace:*` wiring, and the `build-console.mjs`
dist-folding pattern generalized to siblings. The payoff is strongest where a **dependency
or deploy boundary** justifies it (`model`, `aggregator`, `deploy`, `transfer`); it is
thinner for `capture`/`build`/`insight`, which share deps and release cadence.

**Lighter alternative (same decomposition, less wiring):** ship Phase 0–1 plus the
deps-justified cuts (`model`, `aggregator`, `deploy`, `transfer`) as durable package
boundaries, and keep `capture`/`build`/`distribute`/`run`/`insight` as *enforced internal
modules* inside `model` (import-boundary lint rules / subpath exports) until a second
consumer or a slow build demands separate packages. Use lockstep `workspace:*` versions
throughout; reach for independent semver only when an external consumer appears.

## Conventions

- **Versioning:** lockstep `workspace:*` across internal packages until an external
  consumer needs independent semver.
- **Build:** TypeScript project references; each package owns its `tsconfig` extending the
  root. The console dist-folding step generalizes per package that ships static assets.
- **Boundary enforcement:** the package graph above is the allowed import direction; a
  back-edge should fail the build.
