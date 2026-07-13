# Miniapp screenshot capture for OG cards (V2 / phase 2)

**Date:** 2026-07-13
**Status:** Design approved, ready for implementation plan
**Depends on:** [[og-cards-branded]] V1 (PR #378, merged) — the `src/og/` core, `/og/card.png`, and the `imageUrl` resolver hook.

## Problem

V1 shipped branded OG cards for every shareable link, but a **miniapp** (`/games/:key`) card is a *synthetic* card — the AgentGem frame + the game's title text, no picture of the actual game. The phase-2 goal (called out in the V1 spec) is to make a miniapp's card show a **real screenshot of the game**, captured once at publish time.

## Approved decisions (do not re-litigate)

1. **Capture = client-side, in the console Studio preview**, human-confirmed, with a manual-upload fallback. Not server-side headless (no such infra exists; no new heavy dep) and not author-upload-only.
2. **Framing = composite the screenshot into the existing branded 1200×630 card** (`/og/card.png` becomes cover-aware via a resvg `<image>` embed). NOT a separate raw-screenshot `og:image` route.
3. **Storage = a new `gem_covers` Postgres `bytea` table** keyed by `(gemKey, version)`, mirroring `gem_archives`. No blob store / external host.
4. **Cover is cosmetic and NOT part of the signed manifest digest** — it rides the already-authenticated `publish-gem` request. (Decision A.)
5. **No automatic quality gate — the author's eyes are the gate** (Re-capture / Upload / Skip in the publish dialog). A blank WebGL capture never ships a bad card because the human confirms it. (Decision B.)
6. **Games only.** `gemMeta`/`profileMeta`/`skillMeta` are untouched.

## Non-goals (V2)

- No server-side headless rendering / Puppeteer / Cloudflare Browser Rendering.
- No screenshots for gem/profile/skill cards.
- No animated/GIF/video previews — one still PNG.
- No re-capture of already-published games (a cover is set at publish; changing it means re-publishing). No standalone "edit cover" surface.
- No new public image route and no change to `og-meta`'s returned `imageUrl` (stays `null` for game → resolves to the cover-aware `/og/card.png`).

## Architecture

```
CONSOLE (publish time)                          AGGREGATOR                         EDGE/CRAWLER
─────────────────────                           ──────────                         ────────────
Studio.tsx publish flow
  │ request capture ──► sealed Runner iframe
  │                       (capture shim in sandboxDoc)
  │ ◄── {dataUrl}         canvas.toDataURL / "none"
  │
  confirm dialog: Accept / Re-capture / Upload / Skip
  │
  publishSetup(body + coverBase64?) ──► /api/aggregator/publish-gem
                                          recordCatalogShare + upsertGemArchive
                                          + upsertGemCover(gemKey, version, bytes)   [new gem_covers table]

                                        GET /og/card.png?type=game&key=…  ◄──────────  crawler
                                          getCoverDataUri(db, {game,key})  → latest version's cover
                                          renderCardSvg({..., screenshotDataUri})  → resvg <image> embed
                                          → 1200×630 PNG (screenshot hero + title + wordmark)
                                          (no cover → today's synthetic card, unchanged)
```

## Components

### 1. Capture shim (`packages/console/src/panels/Watch/sandboxDoc.ts`)

- A new injected `<script>` shim (sibling of the existing storage + anchor shims). On `message` `{type:"agentgem:capture"}` from the host it:
  - selects the **primary canvas** — the largest visible `<canvas>` by rendered area (`getBoundingClientRect`); ties broken by DOM order;
  - calls `canvas.toDataURL("image/png")`;
  - runs a **blank-frame heuristic** (sample the data URL / a downscaled pixel check for "effectively uniform"); if no canvas, `toDataURL` throws/returns `"data:,"`, or the frame is blank, posts `{type:"agentgem:capture-result", ok:false, reason}`; else `{type:"agentgem:capture-result", ok:true, dataUrl}`.
- Runs on the frame's null origin; posts to `window.parent`. This is a HOST↔shim channel, deliberately separate from the MCP-Apps `ui/*` protocol so a game's capability surface is unchanged. CSP already allows `img-src data:`; the shim produces a data URL, no network.
- **WebGL caveat documented in code:** a WebGL canvas without `preserveDrawingBuffer` yields a blank `toDataURL` — the shim will report `ok:false` (blank) or return a blank frame the author rejects in the dialog. We do not (cannot) mutate the author's WebGL context.

### 2. Capture request + confirm UX (`packages/console/src/panels/Play/Runner.tsx`, `Studio.tsx`)

- `Runner.tsx` gains a host-side `requestCapture(): Promise<{ok:boolean; dataUrl?:string; reason?:string}>` that posts `agentgem:capture` to its iframe and awaits the one-shot `capture-result` (timeout → `ok:false`). Wired through the same `window.message` listener that already hosts the MCP bridge, dispatching on the `agentgem:capture-result` type.
- `Studio.tsx` publish flow: when the user initiates publish (`checkAndPublish` → the existing confirm dialog from `resolvePublishAction`), it calls `requestCapture()` and shows the thumbnail in that dialog with **Accept / Re-capture / Upload image / Skip**:
  - Accept → the captured data URL becomes the cover.
  - Re-capture → call `requestCapture()` again (author can rearrange the game first).
  - Upload image → `<input type="file" accept="image/*">` → read as data URL (reuses the `FileReader`→dataURL pattern already in `upload.ts`).
  - Skip → no cover (synthetic card).
- The chosen cover (base64, sans the `data:image/png;base64,` prefix) is threaded into the publish payload.

### 3. Publish payload + storage (`packages/console/src/api/routes.ts`, `src/gem.controller.ts`, `src/gem/gemPublishClient.ts`, aggregator)

- `publishSetupRoute` body gains optional `coverBase64?: string` (+ its content type, fixed to `image/png` for capture; for uploads, validate to a small allowlist `image/png`/`image/jpeg`/`image/webp`). Size cap (e.g. ≤ 512 KB) enforced client- and server-side.
- `PublishController.publishSetup` forwards `coverBase64` to `postGemPublish`; `/api/aggregator/publish-gem` (`PublishGemBody`) gains optional `coverBase64` + `coverContentType`. After `upsertGemArchive`, if a cover is present, `upsertGemCover(db, {gemKey, version, bytes, contentType, createdAtMs})`.
- **`gem_covers` table** (`packages/aggregator/src/schema.ts`): `gemKey text, version text, bytes bytea, contentType text, createdAtMs bigint`, PK `(gemKey, version)`. Idempotent `ensureSchema` `create table if not exists` (+ paired `alter … add column if not exists` if ever extended — see [[ensureschema-column-drift]]).
- Store/read helpers in `packages/aggregator/src/catalog.ts`: `upsertGemCover`, `getGemCover(db, gemKey, version) → {bytes, contentType} | null`.
- **Decision A:** `coverBase64` is NOT included in the signed `CatalogManifest`/`gemDigest`. The publish is authenticated by the manifest signature + archive digest already; the cover is cosmetic and carried in the same authenticated request. It cannot be used to bypass any access/ownership check.

### 4. Cover-aware `/og/card.png` (`src/og/meta.ts` or a sibling, `src/og/card.ts`, `src/og/install.ts`)

- New `getCoverDataUri(db, card): Promise<string | null>` — for `card.type === "game"` only: resolve the same latest/archive version `gameMeta` resolves, `getGemCover`, and return a `data:<contentType>;base64,<…>` URI (or `null`). Non-game types → `null`.
- `renderCardSvg` gains an optional `screenshotDataUri?: string`. When present, the SVG lays the screenshot as the hero via `<image href="…" width height preserveAspectRatio="xMidYMid slice"/>` filling the 1200×630 (or a framed region), with the title + AgentGem wordmark drawn in a legible overlay bar (a semi-opaque band so text stays readable over any screenshot). `@resvg/resvg-wasm` renders embedded data-URI `<image>` elements.
- `renderCardResponse` (the `/og/card.png` handler in `install.ts`) fetches `getCoverDataUri` for the card and passes it into `renderCardSvg`. No cover → `screenshotDataUri` undefined → today's synthetic card renders unchanged.
- `og-meta` and the resolver in `install.ts` are **unchanged** — `gameMeta` still returns `imageUrl:null`, `og:image` still points at `/og/card.png`, which now composites the screenshot when present. This is why V2 needs no new route and no `imageUrl` change.
- The `/og/card.png` response keeps its cache headers; a re-published game with a new cover produces a new card only after the edge TTL (acceptable, same as V1).

## Public serving / access

- The cover bytes are served ONLY as pixels composited inside `/og/card.png` (already in `PUBLIC_READ_PATHS`, `Access-Control-Allow-Origin: *`). There is **no** endpoint that returns the raw cover bytes directly — one fewer public surface to reason about, and the branding is always applied.
- Visibility: `gameMeta`/`getCoverDataUri` resolve via the same `gemAccessInfo` private-check path — a private gem's card (and thus its cover) is not served (returns null → placeholder), so a cover can't leak a private game's pixels.

## Error handling

- Capture: no canvas / blank / `toDataURL` throw / postMessage timeout → `ok:false`; the dialog shows "couldn't capture — upload an image or skip." Publish proceeds without a cover (synthetic card). A capture failure NEVER blocks publishing.
- Oversized/invalid cover → rejected client-side (before send) and server-side (400 on the aggregator, but the publish of the gem itself is separate — a rejected cover must not fail the gem publish; store gem, skip cover, log).
- `getCoverDataUri` / `getGemCover` DB error → treated as "no cover" → synthetic card (fail-open, same as V1).
- `renderCardSvg` with a malformed data URI → resvg may error → the `/og/card.png` handler already has the placeholder fallback (V1); additionally, guard so a bad cover degrades to the synthetic card rather than the generic placeholder.

## Testing

- **Capture shim (unit):** with a mocked DOM/canvas returning a known data URL → posts `ok:true`; no canvas → `ok:false`; blank data URL → `ok:false` (jsdom has no real paint, so test the protocol + selection + blank heuristic against injected fakes, not real pixels).
- **`requestCapture` (console):** posts the request, resolves on the matching `capture-result` message, times out to `ok:false`.
- **Storage (aggregator):** `publish-gem` with `coverBase64` writes `gem_covers`; `getGemCover` round-trips; an oversized/invalid cover is rejected without failing the gem publish; private-gem cover not served.
- **Render:** `renderCardSvg({…, screenshotDataUri})` emits an `<image>` with the data URI; `renderCardPng` of that SVG yields a valid PNG (real resvg embed, not a mock); `getCoverDataUri` returns null for non-game types and for a game with no cover.
- **Integration:** `/og/card.png` for a game WITH a stored cover composites the screenshot; WITHOUT → the V1 synthetic card, byte-for-byte unchanged.
- **Deploy-gated (manual):** confirm a real captured card renders in the X/FB/LinkedIn debuggers after a publish.

## Rollout / compatibility

- Purely additive: existing published games (no `gem_covers` row) keep rendering the V1 synthetic card. No migration/backfill.
- The console capture UI only appears for game workspaces in the Studio publish flow; other publish paths (`marketplace/Publish.tsx` file-upload) are unchanged and simply never set a cover.

## Open risks

- **WebGL blank captures** — mitigated by human confirm + manual upload; documented, not solvable client-side without the author's `preserveDrawingBuffer`.
- **DOM-only games (no `<canvas>`)** — the shim finds no canvas → `ok:false` → author uploads or skips. (A future `html2canvas`-in-frame path could rasterize DOM, but it's out of V2 scope — most miniapps are canvas games.)
- **Cover size vs Postgres bytea** — capped ≤ 512 KB; consistent with `gem_archives` already storing larger blobs as `bytea`.
- **Screenshot legibility of overlaid title** — mitigated by a semi-opaque band behind the text; final layout is a design detail for the plan.
