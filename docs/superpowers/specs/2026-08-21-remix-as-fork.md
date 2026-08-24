# Remix-as-Fork

**Goal:** Replace the prompt-string "Make your own" deep link with a true fork: one tap on a
published game seeds the local Studio with the game's actual sealed HTML, records lineage
(`remixOf`), respects a creator-controlled `allowRemix` opt-out chosen at publish, and surfaces
remix counts + attribution on marketplace cards.

**Why:** Meta Pocket/Gizmo validated remix-as-fork as the core social mechanic of the
AI-minigame category (creator opt-in at post time, one-tap remix, remixes survive deletion of
the original). Our current "remix" (`remixAppUrl`) copies a *sentence describing* the game, not
the game. Our sealed self-contained artifacts give us Pocket's "remixes survive deletion"
property for free — a fork is a full copy.

**Repos:** `agentgem` (OSS: meta plumbing, fork UX, publish toggle) and `agentgem-enterprise`
(aggregator persistence/enforcement, marketplace UI). Enterprise merges upstream from OSS.

---

## 1. Product behavior

### Remix flow (viewer side)

1. On a marketplace card (Feed + Minigames grid), the "Make your own" action becomes **"Remix"**
   and links to `agentgem://play?remix=<gemKey>` (falling back to
   `http://localhost:4317/#/play?remix=<gemKey>` exactly as today's link falls back). Shown only
   when the game's `allowRemix` is true.
2. The desktop routes it unchanged (`deeplink.ts` forwards query params verbatim; `play` is
   already allowlisted). **Nothing is fetched or written on arrival.** The console's Play panel
   shows a confirm card: *"Remix `<key>` into your arcade? This copies the published game so you
   can make it your own."* with Remix / Cancel.
3. On confirm, the console asks the local core (same-origin proxy) for the game's meta + HTML;
   the core fetches `game-meta` + `game-html` from the aggregator, **checks `allowRemix` and
   `visibility === "public"` fail-closed**, and returns `{ title, genre, version, html }`.
4. The console creates the fork via the existing import path (`importStudio`) with:
   - name/title `<short>-remix` (existing convention from `remixAppUrl`)
   - the original's `genre` (not the import default `project-fun`)
   - `remixOf: { gemKey, version }` pinned to the version fetched
   - needs **derived from the HTML minus AUTO_CAPS**, exactly like any import — a remix
     inherits zero capability grants; it re-earns everything through the normal save gates.
5. Studio opens on the fork with a short seed prompt: `This is a remix of "<gemKey>" — make it
   your own.` (auto-sent as the studio agent's first message, same mechanism as the Blank tab).

### Publish flow (creator side)

6. The publish banner (the existing cover/visibility/tags step in Studio) gains an
   **"Allow remixing"** checkbox next to Visibility. Default **on**. Help text: *"Others can
   fork this game as a starting point. Remixes credit you."*
7. The publish manifest carries `allowRemix` and (for forks) `remixOf`. The aggregator persists
   both; republish that omits `allowRemix` preserves the stored value (same rule as
   `visibility`).
8. The aggregator **rejects** publishing a gem whose `remixOf` names a game that doesn't exist,
   isn't public, or has `allowRemix = false` (reject code `remix_not_allowed`). UI-hiding is
   not enforcement; this is.

### Display

9. Feed/grid cards show **"N remixes"** in the counts row (next to plays) when N > 0, and a
   **"remix of `<orig-key>`"** attribution line linking to `/games/<orig-key>` when the game
   has `remixOf`. A dead original renders the same link — it lands on the existing "This game
   link doesn't exist" page; the remix itself keeps working (full copy).
10. Remix count = `count(distinct gem_key)` of **public** gems whose `remix_of_key` matches,
    across versions (a remix counts once no matter how many versions it publishes).

### Out of scope (explicitly)

- Post-play end card on `/games/:key` (separate scope item from the Pocket comparison).
- Remix *trees* / transitive lineage display — only the direct parent is shown.
- Remixing unlisted or private games (fail-closed to public-only; revisit if asked).
- Notifying the original author, remix leaderboards, collections.
- Any marketplace-side (web) editing — forks are edited in the local Studio like everything else.
- Builder-brief changes — the authoring contract does not change (`MINIAPP_BUILDER_BRIEF`
  untouched; a fork is a normal miniapp the moment it exists).

---

## 2. Decisions (flagged, with rationale)

| # | Decision | Call | Rationale |
|---|----------|------|-----------|
| D-a | `allowRemix` default for existing published games | **true** (DB default) | Their HTML is already publicly served to every browser; the toggle governs the *product affordance + lineage*, not secrecy. Defaulting false would dead-on-arrival the feature (every existing game refuses). Creators opt out at next publish. |
| D-b | `allowRemix` default for new publishes | **on**, visible checkbox at the publish step | Pocket prompts at post time; TikTok-style platforms default remix on. The choice is explicit and in view, satisfying the opt-in spirit. |
| D-c | Where consent for the deep-link arrival lives | **Console-side confirm before any fetch/write** | `deeplink.ts` stays untouched and its "play installs nothing" comment stays true on arrival; the write happens only after a user act in the console. Mirrors spec I3 (§7.3). |
| D-d | Lineage storage | `remixOf: { gemKey, version }` in **both** meta.json (travels with the artifact) and the catalog row (queryable) | The archive must carry its own lineage (portability); the DB must group counts. |
| D-e | Capability inheritance | **None** — fork re-derives needs from HTML minus AUTO_CAPS and passes every save gate again | This is the D10 tightening paired with the widening: remix adds distribution power but cannot add capability power. |
| D-f | Review staging | `allowRemix`/`remixOf` **excluded** from the review-staging manifest | Mirrors the existing deliberate exclusion of `visibility` (`review.controller.ts:27-28`). |
| D-g | Remix counts transport | Live bulk-counts endpoint (like plays), **not** a catalog field | Counts change without republish; `Gem` catalog fields are publish-time facts. |
| D-h | Cross-repo rollout | Contract types land OSS-first; aggregator accepts before any console sends | See §5 — signature-over-manifest makes this mandatory, not stylistic. |

---

## 3. Data model & wire changes (exact seams)

### 3.1 meta.json / artifact (OSS) — `remixOf?: { gemKey: string; version: string }`

zod strips unknown keys at every hop and two writers rebuild meta field-by-field, so the field
must be added in **all seven** places or it silently vanishes:

1. `MiniappMeta` — `packages/play/src/miniapps.ts:20`
2. `writeGameGem` field-by-field rebuild — `packages/play/src/miniapps.ts:87-98` — plus
   `GameArtifact` — `packages/model/src/types.ts:103-118`
3. `PlaySaveRequestSchema` — `packages/app/src/schemas.ts:893-903`
4. `PlayMiniappSchema` (GET response) — `packages/app/src/schemas.ts:968-972`
5. Server re-projection — `packages/app/src/play.controller.ts:152-160`
6. Console client mirrors — `packages/console/src/api/routes.ts:1053-1057` (`PlayMetaSchema`)
   and `:1062-1069` (`playMiniappRoute`)
7. Console save body rebuild — `packages/console/src/panels/Play/Studio.tsx:427-437`

Carry-forward: like `uploads` (`miniapps.ts:180-186`), `remixOf` is set once at fork creation
and preserved on later saves (the Studio echoes it back through #7; the `uploads`-style
prev-read guard covers a client that doesn't).

Fork creation: `importStudio(title, html, name?, files?)` —
`packages/play/src/studio.ts:111-128` — gains an optional
`opts?: { remixOf?: { gemKey: string; version: string }; genre?: GameGenre }`, threaded into
the meta literal at `:124`. Wire: `playImportRoute` body (`routes.ts:1090-1093`) + the
`/api/play/import` server schema gain the same optional fields.

### 3.2 Publish manifest (shared contract, OSS-owned)

`CatalogManifest` + `CatalogRow` — `packages/contract/src/catalog.ts:37-44` / `:12-20` — gain
`allowRemix?: boolean` and `remixOf?: { gemKey: string; version: string }`. The manifest is
hashed whole by `catalogSigningPayload` (`catalog.ts:52-56`), so the fields are
signature-bound automatically; the client must sign and send the identical object
(`packages/app/src/gem/gemPublishClient.ts:26-37`).

Console → core: `PlaybookPublishBodySchema` (`packages/app/src/schemas.ts:552-557`) +
`publishSetupRoute` (`packages/console/src/api/routes.ts:809-813`) gain `allowRemix?`;
`remixOf` is **not** client-supplied at publish — the core reads it from the workspace's
meta.json (the artifact is the source of truth; a client can't forge lineage it doesn't have…
locally it can edit meta.json, but the aggregator check in §4 is the real gate).
Manifest build: `GemController.publishSetup` — `packages/app/src/gem.controller.ts:777-806` —
adds both fields at `:785-792`.

Studio UI: checkbox state beside `scope`/`tags` (`Studio.tsx:96-97`), rendered in the
`play-banner__opts` block (`Studio.tsx:719-729`), threaded through
`publishWorkspace(login, version, visibility)` (`:462`, both version-confirm call sites
`:692-693`).

### 3.3 Aggregator (enterprise)

- zod accept: `CatalogManifestSchema` — `enterprise/src/aggregator.controller.ts:141-148`.
- Persist: `recordCatalogShare` — `enterprise/packages/aggregator/src/catalog.ts:222-249`
  (omitted `allowRemix` preserves prior value, same as visibility at `:246-248`);
  `upsertCatalogGem` — `:17-37` — **both** the `values` and `set` blocks.
- DB: `catalog_gems` pgTable — `enterprise/packages/aggregator/src/schema.ts:306-328` — plus
  the paired idempotent DDL right after `:733` (repo convention, memory-trap
  `ensureschema-column-drift`):
  ```ts
  await db.execute(sql`alter table catalog_gems add column if not exists allow_remix boolean not null default true`);
  await db.execute(sql`alter table catalog_gems add column if not exists remix_of_key text`);
  await db.execute(sql`alter table catalog_gems add column if not exists remix_of_version text`);
  ```
- `game-meta` response (`aggregator.controller.ts:412`, `GameMetaResult:160-164`) gains
  `allowRemix: boolean` (drives both the marketplace button and the OSS remix-source proxy).
- New **`GET /api/aggregator/game-remixes?keys=a,b,c`** → `{ items: { gemKey, remixes }[] }`,
  modeled exactly on `game-plays` (`:440`, `gamePlays.ts:21`): count distinct `gem_key` of
  public rows grouped by `remix_of_key`. **Must be added to `PUBLIC_READ_PATHS`**
  (`packages/app/src/originGuard.ts:36` — exact-match, memory-trap
  `originguard-public-read-cors`) in **both repos'** originGuard copies, with the regression
  test extended (`src/__tests__/originGuard.test.ts:224+`).

### 3.4 Catalog listing → marketplace `Gem` (enterprise, 4-hop chain)

`remixOf` + `allowRemix` per published game surface through: `RegistryGemSchema`
(`packages/app/src/schemas.ts:885-899`) → `mapDbToGems`
(`packages/app/src/gem/publicCatalog.ts:46-53`) → marketplace `RegistryGem`
(`enterprise/packages/marketplace/src/types.ts:1-15`) → `toGem`
(`enterprise/packages/marketplace/src/gems/catalog.ts:165-167`), and `listCatalogGems`'s
explicit `db.select({...})` column list + row mapping
(`enterprise/packages/aggregator/src/catalog.ts:50-70`).

### 3.5 Marketplace UI (enterprise)

- `remix.ts` `remixAppUrl` → `agentgem://play?remix=<key>` (drop the prompt sentence); only
  rendered when `gem.allowRemix !== false` — call sites `FeedCard.tsx:104-106` and
  `pages/Minigames.tsx:67-68` (+ the `.mg-foot` explainer copy at `:122`).
- Counts: 4th bulk fetch in `useMiniappsData` (both `Promise.allSettled` sites, `:96-100` and
  `:133-137`), new `remixes: Bulk<Record<string, number>>` + snapshot field; **not** part of
  `countsSettled` (`:181`) — remix counts must never delay first feed render. `api.ts` gains
  `getGameRemixes` copied from `getGamePlays` (`:162-164`), best-effort `.catch(() => ({}))`
  variant like `gemAdoption` (`:169-173`).
- `FeedCard` props gain `remixCount: number | null` and render in `.ex-feed-counts`
  (`:109-111`); attribution line in the header block (`:81-84`). Every new `ex-*` class gets a
  matching rule in `src/styles.css` (repo rule: no CSS-less classNames).

### 3.6 OSS console fetch path

New same-origin GET proxy following `benchmark.proxy.controller.ts` verbatim:
`GET /api/play/remix-source?key=…` → core fetches aggregator `game-meta` (checks
`allowRemix === true`; the endpoint only resolves public/unlisted, and the proxy additionally
requires the key to resolve via the public catalog) then `game-html`, returns
`{ title, genre, version, html }`. Client in `packages/app/src/gem/` beside
`hostedInstall.ts`, base resolution `AGENTGEM_AGGREGATOR_URL ?? "https://api.agentgem.ai"`.
Registered in `gemCore.component.ts` (both entries).

Deep link: console handler (`packages/console/src/panels/Play/index.tsx:32-41`) learns
`remix=<key>` → new `View` variant `{ kind: "remix-confirm"; gemKey: string }` → confirm card →
proxy fetch → `playImportRoute` with `remixOf`/`genre` → `onCreated(name, seedPrompt)`.
`desktop/src/deeplink.ts` unchanged. Test file to extend:
`packages/console/src/panels/Play/__tests__/PlayDeepLink.test.tsx`.

---

## 4. Enforcement (the D10 pairing)

**Widening:** one-tap forking of published artifacts, with distribution credit.

**Tightenings shipped in the same feature:**
1. Creator `allowRemix` gate enforced at **three** layers: marketplace hides the button; the
   OSS remix-source proxy refuses to seed (fail-closed on missing/false); the aggregator
   rejects publishing a manifest whose `remixOf` target is missing, non-public, or
   `allow_remix = false` (`recordCatalogShare`, before `upsertCatalogGem`).
2. Zero capability inheritance: the fork's needs are re-derived from its HTML minus AUTO_CAPS
   (`importStudio` precedent, `studio.ts:117-123`) and every save re-runs the full gate chain
   (S1–S9). Lineage metadata never grants anything.
3. No write without a user act: the deep-link arrival renders a confirm card only; fetch and
   fork happen after the click (I3 mirror).

Conformance checklist (§10) impact: no runtime/protocol change, no builder-brief change; add a
row to the §9 implementation map for the remix flow, and record the widening/tightening pair as
a new entry in `docs/miniapps/evolution.md` (D10 table).

---

## 5. Rollout order (mandatory, not stylistic)

The aggregator zod-parses the manifest **before** verifying the signature, and zod strips
unknown keys — so a console that signs a manifest containing `allowRemix` and sends it to an
aggregator that doesn't know the field gets a **signature mismatch and every publish fails**.
Order:

1. **O-PR1 (OSS):** contract types + all meta/fork/console plumbing, **console does not yet
   include the new fields in the publish manifest** (the checkbox ships disabled-hidden or the
   field is simply not sent).
2. **E-PR1 (enterprise, after merging upstream O-PR1):** aggregator accepts + persists +
   enforces; DB columns; `game-meta.allowRemix`; `game-remixes` endpoint + originGuard entries.
   **Deploy api.agentgem.ai** (and the `.ent` twin).
3. **O-PR2 (OSS, small):** console sends `allowRemix` + `remixOf` in the publish body/manifest;
   publish checkbox goes live.
4. **E-PR2 (enterprise):** marketplace UI — remix link/gating, counts, attribution, styles.

Old console → new aggregator stays green throughout (absent optional fields hash identically on
both ends). E-PR2 can ship any time after E-PR1; listing it last keeps the button from
appearing before local consoles can honor it.

---

## 6. PR breakdown

### O-PR1 — fork plumbing + remix UX (OSS `agentgem`)
- `packages/contract/src/catalog.ts` — manifest/row types (types only; nothing sends yet)
- `packages/play/src/miniapps.ts`, `packages/model/src/types.ts` — `remixOf` in meta +
  artifact + `writeGameGem`
- `packages/play/src/studio.ts` — `importStudio` opts (`remixOf`, `genre`)
- `packages/app/src/schemas.ts`, `play.controller.ts` — wire schemas both directions
- `packages/app/src/playRemixSource.proxy.controller.ts` (new) + client + registration
- `packages/console/src/api/routes.ts`, `panels/Play/index.tsx`, `Composer.tsx` (import call),
  `Studio.tsx` (meta echo in save body; publish checkbox rendered but **not sent**)
- `docs/miniapps/spec.md` §9 row; `docs/miniapps/evolution.md` D10 entry
- Tests: meta round-trip through save/load/gem-write; importStudio bakes remixOf + genre;
  deep-link `remix=` shows confirm and does not fetch before it; proxy fail-closed on
  `allowRemix: false`

### E-PR1 — aggregator accept/persist/enforce (enterprise)
- Merge upstream O-PR1 first
- `enterprise/src/aggregator.controller.ts` — manifest zod, `game-meta.allowRemix`,
  `game-remixes`
- `enterprise/packages/aggregator/src/catalog.ts`, `schema.ts` — persistence + paired DDL +
  `remix_not_allowed` rejection + count query (new `gameRemixes.ts` beside `gamePlays.ts`)
- `packages/app/src/originGuard.ts` + test — `game-remixes` in `PUBLIC_READ_PATHS` (and the
  matching OSS-repo originGuard entry rides O-PR2)
- `packages/app/src/gem/publicCatalog.ts`, `schemas.ts` `RegistryGemSchema` — listing fields
- Tests: signature round-trip **with and without** the new fields (old-console compat);
  reject matrix (missing / private / allowRemix=false); count distinct-across-versions;
  republish-omits-preserves

### O-PR2 — console sends lineage (OSS, small)
- `Studio.tsx` / `routes.ts` / `schemas.ts` / `gem.controller.ts` — `allowRemix` in publish
  body, `remixOf` read from workspace meta into the manifest; OSS originGuard `game-remixes`
  entry
- Test: manifest built from a fork contains pinned `remixOf`; publish body carries the toggle

### E-PR2 — marketplace surfaces (enterprise)
- `src/remix.ts`, `FeedCard.tsx`, `pages/Minigames.tsx`, `gems/useMiniappsData.ts`, `api.ts`,
  `gems/catalog.ts`, `types.ts`, `styles.css`
- Tests: button hidden when `allowRemix === false`; counts render without gating first paint;
  attribution links `/games/<orig>`

Rough size: O-PR1 is the big one (7-seam meta plumbing + new proxy + deep-link UX); E-PR1
medium; O-PR2/E-PR2 small.
