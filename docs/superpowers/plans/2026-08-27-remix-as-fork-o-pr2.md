# Remix-as-Fork O-PR2 (console sends lineage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The console publishes `allowRemix` (a visible "Allow remixing" checkbox at the
publish step) and `remixOf` (read from the workspace's game artifact) in the signed
manifest; the OSS repo gains its byte-identical twins of the enterprise E-PR1 shared-layer
edits; two earmarked O-PR1 minors are folded in.

**Architecture:** The publish chain grows one field at each hop it already has
(Studio state → publish body → core route → manifest → signature), with `remixOf` sourced
server-side from the dual-written gem artifact — the client cannot forge lineage it didn't
fork, and the deployed aggregator (E-PR1, live as of 2026-08-27) re-gates it anyway. The
twins (originGuard entry, RegistryGem listing fields) keep the next enterprise upstream
sync auto-resolvable.

**Tech Stack:** TypeScript ESM, zod, React (Studio), vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-remix-as-fork.md` §2 D-b, §3.2, §5 step 3,
§6 O-PR2 — plus the enterprise-side ruling to replicate: §1 item 8's reject code is
`remix-not-allowed` (kebab), already amended in the enterprise copy of this spec.

## Global Constraints

- The deployed aggregator accepts `allowRemix`/`remixOf` in the signed manifest
  (verified live 2026-08-27: `game-meta` serves `allowRemix`, `game-remixes` answers) —
  the rollout gate for sending is OPEN. `CatalogManifest` (packages/contract) already has
  both optional fields; do not touch the contract.
- `remixOf` in the manifest comes ONLY from the workspace gem's game artifact
  (`GameArtifact.remixOf`, dual-written at save) — never from the client request body.
  `allowRemix` comes from the request body (the checkbox); default true.
- Checkbox default ON, rendered in the existing publish banner's `play-banner__opts`
  block beside Visibility/Tags; help copy: "Others can fork this game as a starting
  point. Remixes credit you."
- The `review.controller.ts` staging manifest deliberately excludes visibility — it must
  equally exclude `allowRemix`/`remixOf` (spec D-f). Verify by inspection; do not edit it.
- Twins byte-identical to enterprise E-PR1 Task 3 (`2b5a9cb2` there): originGuard entry
  `"/api/aggregator/game-remixes"`; `RegistryGemSchema` + local `RegistryGem` +
  `mapDbToGems` gain `allowRemix?: boolean` / `remixOf?: { gemKey, version }`.
- Spec §1 item 8: change ``(reject code `remix_not_allowed`)`` to ``(reject code
  `remix-not-allowed` — kebab-case matching the sibling rejection codes
  `invalid-key`/`conflict`; deviation from this spec's earlier draft, ruled at E-PR1)``
  — byte-identical to the enterprise amendment so the sync auto-resolves.
- Root tests run compiled dist (root `pnpm build` first, never bare tsc); console tests
  via `pnpm --filter @agentgem/console exec vitest run <file>` for iteration, full
  filter-suite once before commit.
- Style: 2-space, double quotes, surgical diffs; never write a literal NUL byte.
- Worktree `../agentgem-worktrees/remix-o-pr2`, branch `remix-o-pr2`; PR gated by CI
  `test (24)` (OSS CI is alive); `gh pr merge --rebase --delete-branch`; verify every
  commit's content on origin/main after merge.

---

### Task 1: Publish sends lineage — checkbox, wire, manifest

**Files:**
- Modify: `packages/console/src/panels/Play/Studio.tsx` (state ~96-97; `publishWorkspace`
  ~462-470; both version-confirm call sites ~693-694; banner opts block ~718-730 — line
  numbers pre-O-PR1, verify by reading)
- Modify: `packages/console/src/api/routes.ts` (`publishSetupRoute` body ~809-813)
- Modify: `packages/app/src/schemas.ts` (`PlaybookPublishBodySchema` ~552-557)
- Modify: `packages/app/src/gem.controller.ts` (`publishSetup` ~777-806)
- Test: `src/__tests__/publishManifestRemix.test.ts` (create);
  `packages/console/src/panels/Play/__tests__/Studio.publishRemix.test.tsx` (create,
  mirroring an existing Studio test's stubbing conventions)

**Interfaces:**
- Consumes: `GameArtifact.remixOf?: RemixRef` (O-PR1); `CatalogManifest.allowRemix?/remixOf?`
  (contract, already present).
- Produces: `publishSetupRoute` body gains `allowRemix?: boolean`;
  `buildPublishManifest(...)` exported from `gem.controller.ts` (or a sibling module if
  the controller file resists a clean export) so the manifest content is unit-testable.

- [ ] **Step 1: Failing tests.** Refactor target first: the manifest literal inside
  `publishSetup` (gem.controller.ts:785-792) moves into an exported pure helper —
  signature `buildPublishManifest(b: { scope: string; name?: string; workspace: string; version: string; description?: string; tags?: string[]; visibility?: Visibility; allowRemix?: boolean }, gem: Gem, gemDigest: string): CatalogManifest`
  — returning exactly today's object plus:

```ts
  ...(b.allowRemix === undefined ? {} : { allowRemix: b.allowRemix }),
  // Lineage comes from the ARTIFACT, never the request: the fork baked it at creation,
  // and a client cannot claim lineage its workspace doesn't carry. The deployed
  // aggregator re-gates it against the target's current allowRemix regardless.
  ...(() => { const g = gem.artifacts.find((a) => a.type === "game") as { remixOf?: { gemKey: string; version: string } } | undefined;
    return g?.remixOf ? { remixOf: g.remixOf } : {}; })(),
```

  `src/__tests__/publishManifestRemix.test.ts` asserts: (a) a gem whose game artifact
  carries `remixOf` yields a manifest with it; (b) a gem without lineage yields none;
  (c) `allowRemix: false` passes through; (d) omitted `allowRemix` stays absent (old-body
  shape preserved). Studio test: render Studio with the publish banner open (mirror an
  existing Studio test's fetch/route stubs), assert the "Allow remixing" checkbox renders
  checked by default, uncheck it, complete a stubbed publish, and assert
  `publishSetupRoute.call` received `allowRemix: false`; a second case asserts the default
  path sends `allowRemix: true`.
- [ ] **Step 2: RED** (compile errors on the missing helper/fields count).
- [ ] **Step 3: Implement.** Studio: `const [allowRemix, setAllowRemix] = useState(true);`
  beside `scope`/`tags`; checkbox in the opts block:

```tsx
            <label className="play-banner__opts-label" htmlFor="play-share-remix">
              <input id="play-share-remix" type="checkbox" checked={allowRemix} onChange={(e) => setAllowRemix(e.target.checked)} />
              Allow remixing
            </label>
            <span className="play-banner__opts-help">Others can fork this game as a starting point. Remixes credit you.</span>
```

  (reuse existing opts classes; add a `styles` rule ONLY if the checkbox misaligns —
  check the console stylesheet the way O-PR1's RemixConfirm did.) Thread
  `allowRemix` into `publishWorkspace(login, version, visibility)`'s body
  (`allowRemix,` beside `visibility`) — the state is read directly inside the function
  like `tags`, so the signature need not change; verify the two version-confirm call
  sites still compile unchanged. Wire: `allowRemix: z.boolean().optional()` in
  `publishSetupRoute` body and `PlaybookPublishBodySchema`. Controller: replace the
  inline literal with `manifest = buildPublishManifest(b, gem, meta.gemDigest)` (grade
  clamp and artifacts mapping move into the helper verbatim).
- [ ] **Step 4: GREEN** — new tests + existing publish-path suites
  (`grep -l publishSetup src/__tests__ packages/console/src/**/__tests__` for the
  regression set) + `pnpm build`.
- [ ] **Step 5: Commit** — `feat(publish): send allowRemix from the publish banner and remixOf from the fork's own artifact`

---

### Task 2: Twins + earmarked polish (batched — small same-shape edits)

**Files:**
- Modify: `packages/app/src/originGuard.ts` (+ test `src/__tests__/originGuard.test.ts`)
- Modify: `packages/app/src/schemas.ts` (`RegistryGemSchema`), `packages/app/src/gem/publicCatalog.ts`
  (+ test in `src/__tests__/schemas.test.ts` if present, else beside originGuard's)
- Modify: `docs/superpowers/specs/2026-08-21-remix-as-fork.md` (§1 item 8 ruling text)
- Modify: `packages/console/src/api/routes.ts` + `packages/console/src/panels/Play/RemixConfirm.tsx`
  (genre-enum dedupe: `export const GAME_GENRE_VALUES = ["replay", "skill-run", "project-fun", "session-heatmap", "project-map", "skill-tuner"] as const;`
  in routes.ts; the three play-route `z.enum([...])` sites become `z.enum(GAME_GENRE_VALUES)`;
  RemixConfirm's local `GENRES` const becomes an import of `GAME_GENRE_VALUES`)
- Modify: `packages/app/src/gem/remixSourceClient.ts` (wrap each `http(...)` call:
  a thrown fetch error — timeout AbortError, DNS TypeError — becomes
  `throw new InvalidInputError("could not reach the marketplace; try again in a moment");`
  so the confirm card shows clean copy instead of an opaque 500)
  (+ 1 test in `src/__tests__/remixSourceClient.test.ts`: an `http` that throws →
  the clean message)
- Test additions per file as listed; twins' test content byte-matches enterprise E-PR1
  Task 3's.

- [ ] **Step 1: Failing tests** (originGuard cross-origin game-remixes; RegistryGemSchema
  keeps-fields; remixSourceClient network-throw). The genre dedupe and spec edit are
  compile/inspection-verified.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement all five edits.** Twins byte-identical to enterprise
  (Global Constraints).
- [ ] **Step 4: GREEN** — originGuard suite, schemas, remixSourceClient, PlayDeepLink
  (genre-dedupe regression), `pnpm build`.
- [ ] **Step 5: Commit** — `feat(catalog): OSS twins for game-remixes + listing fields; record the remix-not-allowed ruling; dedupe the genre enum; clean proxy network errors`

---

### Task 3: Full verification + PR

- [ ] Root `pnpm build && pnpm test`; console `pnpm --filter @agentgem/console test`
  (assertions AND exit code).
- [ ] Push `remix-o-pr2`, open the PR (body: the chain now sends; aggregator deployed
  and verified live; twins for sync hygiene; the two folded O-PR1 minors).
- [ ] `gh pr checks --watch`, then verify the run's **conclusion** via
  `gh run list --branch remix-o-pr2 -L 1 --json conclusion`.
- [ ] `gh pr merge --rebase --delete-branch` (expect the local branch-delete error —
  remote merge still succeeds); `git fetch`; grep origin/main for a marker from EACH
  commit (`buildPublishManifest`, `GAME_GENRE_VALUES`, `game-remixes` in originGuard,
  `remix-not-allowed` in the spec).

## Self-Review Notes

- Spec D-b (checkbox default on, publish-step) → Task 1; §3.2 manifest/wire seams →
  Task 1; §5 step 3 (console flips after E-PR1 deploys) → satisfied, deploy verified
  live; §6 O-PR2 file list covered; D-f review-staging exclusion → inspection item in
  Task 1 (no edit).
- Type consistency: `buildPublishManifest` consumes the same body shape
  `publishSetupRoute` sends; `GAME_GENRE_VALUES` is the exact six-value list all three
  z.enum sites and RemixConfirm previously inlined.
- Not here: marketplace UI (E-PR2), any contract/aggregator change.
