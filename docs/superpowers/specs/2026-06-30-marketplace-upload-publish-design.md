# Marketplace Gem-Upload Publish (Gem Contributions #5-publish, marketplace half) — Design

**Date:** 2026-06-30
**Status:** Approved-pending-review — subsystem B of the "remaining items" set (A console panel ✅ → **B marketplace upload-publish** → C rating telemetry)

## Goal

Let a **signed-in** user publish a gem **from `app.agentgem.ai`**: upload a `.gem` (exported from the console), and a session-authed endpoint publishes it to the registry stamped with **#4a attribution** (`publishedBy` = their verified GitHub login). This is the first **live consumer** of #4a's attribution and the hosted complement to the local console publish panel (A). Carries a **minimal safety rail** (`scope === your login`) so the public endpoint isn't an abuse vector; the richer ownership model (org/claimed scopes) stays #4b.

## Context (ground-truth)

- **`.gem` round-trip:** `exportGem(gem, {version}) → { filename, bytes: Buffer, skipped }` and `importGem(bytes: Buffer) → { gem, meta }` (`packages/distribute/src/share.ts`). `importGem` runs `readGemArchive` which **verifies `gem.lock` and throws on tampering** — so a corrupted/forged archive never publishes.
- **`publishGem(args)`** (`registry.ts:238`) is **gem-origin-agnostic**: `{ gem, scope, name?, version, dependencies?, index, publisher, description?, tags?, type?, publishedBy? }` → `{ ref, version, gemDigest, commit, path }`. #4a added `publishedBy?`; #3 added `type?`.
- **The session/CORS/originGuard pattern** (`src/auth/install.ts`, `src/stars/install.ts`): a **raw-express** route mounted on `server.expressApp`, with credentialed CORS (echo an allowlisted `Origin` + `Allow-Credentials:true`, **never `*`**, `Vary:Origin`), explicit `OPTIONS` preflight, session via `parseCookies(req.headers.cookie)[SESSION_COOKIE]` + `resolveSession(db, token)`. `originGuard.ts:55` **exempts** `/api/auth/` + `/api/stars` from the cross-site block (`startsWith(...)`); a new cross-site publish path must be exempted the same way. Wired in `src/index.ts` gated on `aggDb && webOrigins.length > 0`.
- **`resolveSession(db, token) → { login, avatarUrl, accountId } | null`** (`@agentgem/aggregator`) — reused directly (the raw req has `headers.cookie`).
- **Body limit:** `RestServer` json bodyParser is `"25mb"` (`src/index.ts`) — so the `.gem` rides as **base64 in JSON** (`{ scope, version, name?, tags?, bytesBase64 }`), no multipart/multer.
- **Marketplace:** `App.tsx` holds `me: Me | null` (`makeAuth().getMe()` → `{login, avatarUrl}`), renders the header + `<Router api stars />` (pathname routing, `path === "/gems"` etc.). `makeStars` (`stars.ts`) is the credentialed-POST client to mirror. The marketplace is standalone (no server imports).

## The three bugs in the obvious sketch (must avoid)

1. **`publishedBy` must be passed.** Resolving the session is pointless unless `publishGem({ ..., publishedBy: who.login })` actually stamps it — that IS the feature. The naive sketch resolved `who` then dropped it.
2. **`Buffer` is Node-only.** The marketplace runs in the **browser** — `Buffer.from(arrayBuffer).toString("base64")` throws. Use `FileReader.readAsDataURL(file)` → strip the `data:...;base64,` prefix (browser-safe, handles large files without call-stack overflow).
3. **The registry index must be fresh per request.** Capturing `source.getIndex()` at install time would publish against a stale index (and clobber concurrent publishes). The handler fetches `await source.getIndex()` **per request** (mirrors the controller publish).

## Decisions (settled)

- **Session-required, `scope === who.login` safety rail.** No session → 401; `scope !== who.login` → 403. This is **input validation** (you publish under your own handle), not the deferred #4b model (org/claimed scopes). Org-scoped gems (`@ninemind`) publish via the console/trusted path, not the marketplace.
- **`publishedBy = who.login`** stamped on every upload-publish (the #4a consumer).
- **Base64 JSON upload**, not multipart (reuses the 25mb json limit; no multer dependency).
- **CSRF**: the session cookie is `SameSite=Lax` (a cross-site POST from an evil origin won't send it) + credentialed CORS allowlist — same posture as the shipped `POST /api/stars/toggle`. originGuard-exempt like auth/stars.
- **Rail order:** session-check → scope-check **before** `importGem` (don't process untrusted bytes until authorized).

## Components (files)

### Backend
- **`src/registry/uploadPublish.ts`** (new, raw-express) — `installRegistryUploadPublish(expressApp, deps: { db: AppDb; webOrigins: string[]; cfg: GithubCfg; gemTypes: GemTypeRegistry })`. Registers `POST` + `OPTIONS` `/api/registry/upload-publish`. Handler:
  - CORS (allowlist echo) + OPTIONS 204.
  - `who = token ? await resolveSession(db, token) : null` → **401** `{error:"sign in required"}` if none.
  - body `{ scope, version, name?, tags?, description?, type?, bytesBase64 }`; validate `scope`/`version` non-empty + `scope === who.login` → **403** `{error:"you can only publish under your own login (@<login>)"}`.
  - `gem = importGem(Buffer.from(bytesBase64, "base64")).gem` (wrapped → **400** on tamper/parse).
  - `source = githubRegistrySource(cfg); index = await source.getIndex();` (fresh).
  - `type = resolvePublishType(gemTypes, suppliedType, gem)` (reuse #3; unknown → 400).
  - `publishGem({ gem, scope, name, version, index, publisher: githubRegistryPublisher(cfg), description, tags, type, publishedBy: who.login })` → return the result. Errors → 400 with the message (e.g. immutability).
- **`src/originGuard.ts`** — add `|| req.path.startsWith("/api/registry/upload-publish")` to the exemption branch.
- **`src/index.ts`** — after `installStars`, gated on `aggDb && webOrigins.length > 0 && registryConfigFromEnv()`: `installRegistryUploadPublish(server.expressApp as never, { db: aggDb, webOrigins, cfg: registryConfigFromEnv()!, gemTypes: defaultGemTypeRegistry })`. (Use `defaultGemTypeRegistry` — the upload path doesn't need plugin cuts.)

### Frontend (marketplace)
- **`packages/marketplace/src/upload.ts`** (new) — `makeUpload(base)` → `publish({ file, scope, version, name?, tags? }): Promise<{ ref; version; path }>`: `FileReader.readAsDataURL(file)` → base64; credentialed POST to `/api/registry/upload-publish`; 401 → throw `NotSignedIn`; non-ok → throw the body text.
- **`packages/marketplace/src/pages/Publish.tsx`** (new) — `Publish({ api, me, base })`: signed-out → "Sign in to publish" + the sign-in link; signed-in → form (`.gem` file input, `scope` defaulting to `me.login` + read-only-ish hint "must be your login", `version`, `tags` csv); submit → `makeUpload(base).publish(...)`; success → "Published `{ref}@{version}`" + a link to `/gems/<ref>`; error shown.
- **`packages/marketplace/src/Router.tsx`** — add `me: Me | null` to the Router props; route `path === "/publish"` → `<Publish api me base={defaultApiBase()} />`.
- **`packages/marketplace/src/App.tsx`** — thread `me` into `<Router>`; add a **"Publish"** header link (shown when `me` is signed in) → `/publish`.

## Testing

- **Backend** (`src/registry/__tests__/uploadPublish.test.ts`, raw req/res mock + `makeTestDb` + a real `exportGem`'d gem, mirror `authInstall.test.ts`): 401 without a session; **403 when `scope !== login`**; 200 + the published `ref` when `scope === login` AND **`publishedBy` stamped = the login** (assert via the publisher mock capturing the discovery, or via the returned ref + a stubbed publisher); 400 on tampered bytes; credentialed CORS only for an allowlisted origin; OPTIONS 204. Stub the `publisher` (a `putCommit` capture, like `registryPublish.test.ts`'s `capturingPublisher`) so no real GitHub.
- **originGuard** (`originGuard.test.ts`): a cross-site `POST /api/registry/upload-publish` passes the guard (exempt), while a cross-site non-exempt POST still blocks.
- **Frontend** (`upload.test.ts`, `Publish.test.tsx`): `makeUpload` base64s a File + credentialed POST + 401→NotSignedIn; the Publish page renders the sign-in prompt when `me` is null, and on submit calls upload + shows the ref (stub `makeUpload`/`fetch`).
- Gates: server `pnpm test` (compiled dist) incl. the new install + originGuard tests; `pnpm --filter @agentgem/marketplace test | typecheck | build`.

## Out of scope (#4b / later)

- Org-scope publishing + the full ownership model (claimed scopes / org-membership) — #4b; the `scope === login` rail is the v1 floor.
- Building/exporting the `.gem` in the browser (the user exports from the console; the marketplace only uploads).
- Rate limiting the upload-publish (the aggregator has `mountGating`; a per-account publish limit is a fast-follow — noted as a risk).
- Stamping the stable GitHub numeric id (login-only, per #4a).

## Risks

- **Public endpoint abuse:** the `scope === login` rail confines publishing to your own handle, and `importGem` rejects tampering, but a signed-in user can publish unlimited gems under their own scope. Mitigation now: attribution (traceable) + the rail; a per-account rate limit is a fast-follow.
- **Browser base64 of large files:** `FileReader.readAsDataURL` handles size safely (no `String.fromCharCode(...spread)` overflow); the 25mb json limit caps it server-side (a too-large body → the server's parser rejects → surfaced as an error).
- **Login mutability:** `scope === who.login` uses the current session login; a GitHub rename changes what you can publish under (acceptable v1).
- **Hot files:** `originGuard.ts`, `index.ts`, the marketplace `Router/App` are concurrently active — additive diffs, branch off latest `origin/main`, integrate promptly.
