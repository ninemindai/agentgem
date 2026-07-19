# Mid-session file upload in the Studio authoring window

**Date:** 2026-07-19
**Status:** Design approved — ready for implementation plan
**Builds on:** `2026-07-18-miniapp-studio-upload-files-design.md` (create-time upload, shipped #484/#485)

## Problem

Today you can only seed a miniapp with files at **creation** time — the upload
dropzone lives in the `Composer` (Blank & HTML tabs) and its files are sent in the
create request body (`/api/play/blank`, `/api/play/import`). Once you're in the
Studio authoring window chatting with the ACP agent, there is **no way to hand the
agent more files**. You have to know every asset up front.

This adds an **attach control beside the Studio prompt textarea** so you can upload
one or more files mid-session, alongside (or instead of) a prompt, and have the
running agent told about them.

## Goals

- Attach files from the Studio authoring window and drop them into the current
  miniapp's git workspace (same `uploads/` ship + gitignored `ref/` reference model
  as create-time).
- Tell the running ACP agent about the new files by prepending the existing
  `uploadsPreamble` to the next prompt.
- Keep the durable brief accurate: uploading mid-session updates `meta.uploads` so
  Studio resume still announces the files.
- Reuse the create-time upload UI and helpers rather than duplicating them.

## Non-goals

- No change to the 1.5MB save gate (`gameGate`) or the sealed runtime.
- No new distribution surface — uploads still never leak into public gems
  (`writeGameGem` is html+meta only; `readMiniapp` serves only index.html+meta.json).
- Not raising any byte caps (ship ≤500KB/file, ≤1MB total; ref ≤5MB/file, ≤15MB
  total; ≤20 files/batch) — same limits as create-time.

## Interaction model (decided)

- **Stage, then send with the prompt.** The attach button stages files as chips with
  a per-file **Ship/Reference** toggle (identical to the Composer). Nothing is written
  until **Send**.
- On **Send**: if files are staged, `POST /api/play/uploads` first; then send the
  prompt to the agent with an auto-generated `uploadsPreamble` prepended.
- **Files-only** (files staged, empty prompt) sends **just the preamble as its own
  agent turn**, so the agent acknowledges/uses the files immediately.
- Send is enabled when `input.trim()` **OR** at least one file is staged.
- Staged files are cleared on a successful upload+send.

## Architecture

### 1. Server — add files to an *existing* miniapp

New exported function in `packages/play/src/studio.ts`:

```ts
export async function addUploadsToMiniapp(
  name: string,
  files: UploadFile[],
): Promise<{ ship: number; ref: number }>;
```

Steps:

1. `const { meta } = readMiniapp(name);` — confirms the miniapp exists (throws
   `miniapp not found ...` → 404) and gives the current durable meta. `readMiniapp`
   validates + jails the name.
2. `const counts = writeUploads(miniappDir(name), files);` — writes into the existing
   workspace (merge-aware, see §2). `miniappDir` re-validates the name (defense in
   depth) and throws on a bad name → 400.
3. Update the durable counter cumulatively:
   `meta.uploads = { ship: (meta.uploads?.ship ?? 0) + counts.ship, ref: (meta.uploads?.ref ?? 0) + counts.ref }`.
   Only write `uploads` when the total is non-zero (matches create-time's conditional
   spread).
4. `writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));`
5. `await commitWithLock(miniappsRoot(), "add uploads to <name>");` — one commit
   covers the new `uploads/`/`ref/` files, `assets.json`, `.gitignore`, and `meta.json`.
6. `return counts;` (this-batch counts — the client uses them only to confirm; the
   preamble it sends is built from the staged files it already has).

Error mapping in the controller mirrors `/play/delete`: a message starting with
`miniapp not found` → 404, everything else → 400.

### 2. Server — make `writeUploads` merge-aware (correctness fix)

`writeUploads(dir, files)` today **overwrites** `uploads/assets.json` and seeds its
collision Sets fresh each call, so a *second* call on the same dir would drop earlier
ship assets from the manifest and could clobber a same-named on-disk file. Create-time
never hit this (fresh dir), but mid-session repeat uploads do.

Change: **preload existing workspace state before appending.** Before the write loop:

- Seed `usedShip` from the basenames already in `<dir>/uploads/` (excluding
  `assets.json`); seed `usedRef` from `<dir>/ref/`. → a re-used name is suffixed
  (`logo-2.png`) instead of overwriting.
- Seed the `manifest` array from an existing `<dir>/uploads/assets.json` if present.
  → merged manifest keeps old ship entries (and their already-computed data URIs;
  old file bytes are **not** re-read).
- Seed `shipTotal` from the summed `bytes` of the preloaded manifest entries, and
  `refTotal` from the summed sizes of existing `<dir>/ref/` files. → the ship ≤1MB
  and ref ≤15MB **totals are cumulative across batches**, which is what actually
  protects the 1.5MB save gate.

`MAX_FILES` (20) stays a **per-batch** guard (the byte totals are the real cumulative
constraint). Write the merged manifest at the end as today.

**Backward compatibility:** a freshly-claimed create dir has an empty `uploads/`,
no `ref/`, and no `assets.json`, so every preload is empty and behavior is
byte-identical to the shipped create path. This is one code path — create gets the
fix for free.

### 3. Client — extract the shared uploads UI

Lift the upload logic currently inline in `Composer.tsx` into two reusable units so
both surfaces share one implementation:

- `packages/console/src/panels/Play/uploads.ts` — a `useUploads()` hook holding the
  `uploads` state and exposing `addUploads(list)`, `setRole(name, role)`,
  `remove(name)`, `error` (add-time message: duplicate filename / too-many, `""` when
  clear — same strings the Composer sets today), `limitError()` (the size-cap check,
  returns the `uploadsError` string or `""`), `payload()` (the `{ files: [...] }` body
  fragment), `preamble()` (the `uploadsPreamble` text), and `reset()`. Move
  `fileToBase64`, the dedup logic, the limit constants
  (`SHIP_MAX_FILE`, `SHIP_MAX_TOTAL`, `REF_MAX_FILE`, `REF_MAX_TOTAL`, `MAX_FILES`),
  `uploadsError`, `uploadsPreamble`, and the `Upload` type here.
- `packages/console/src/panels/Play/UploadsField.tsx` — the presentational dropzone +
  chip list (the current `uploadsBlock` JSX), driven by the hook. Reuses the existing
  `.play-uploads`, `.play-uploads__*`, and `.play-drop` CSS — no new class names.

`Composer.tsx` is refactored to consume `useUploads()` + `<UploadsField>`; its
observable behavior is unchanged (regression-tested).

### 4. Client — wire it into the Studio composer bar

In `Studio.tsx`, inside `play-composer-in` (the textarea + Send row at ~line 722):

- Instantiate `useUploads()`.
- Render `<UploadsField>` (chip strip) above the textarea, and an **attach button**
  (a file input trigger) in the composer foot next to Send. Reuse `.play-btn`; if a
  dedicated `.play-attach` class is added, add a matching rule in `theme.css` in the
  same change (per the repo UI rule — every className must be CSS-enforced).
- Rework `submit()`:
  1. Compute `staged = uploads.uploads`. Guard: if `!input.trim() && !staged.length`
     or `busy` or `!agentId`, return.
  2. Client-side limit check via `uploads.limitError()`; surface it and abort if set.
  3. If `staged.length`: `await playUploadsRoute.call(client, { body: { name, files: uploads.payload().files } })`.
  4. `const text = [uploads.preamble(), input.trim()].filter(Boolean).join("\n\n");`
     then `send(text)` (files-only → `text` is just the preamble).
  5. `uploads.reset(); setInput("");`
- Send button `disabled = busy || !agentId || (!input.trim() && !staged.length)`.
- On upload failure, surface the message in the existing chat/error path and keep the
  staged files (do not reset), so the user can retry.

### 5. Route + schema wiring

- `src/schemas.ts`: `PlayUploadsRequestSchema = { name: string, files: UploadFileSchema[] }`,
  `PlayUploadsResponseSchema = { ship: number, ref: number }`. Reuse the existing
  `UploadFileSchema` (already drift-guarded against `@agentgem/play`'s `UploadFile`).
- `src/play.controller.ts`: `@post("/play/uploads")` → `addUploadsToMiniapp`, with the
  404/400 error mapping above.
- `packages/console/src/api/routes.ts`: `export const playUploadsRoute = defineRoute("POST", "/api/play/uploads", { body: ..., response: ... })`, reusing `playUploadFileSchema`.

## Data flow

```
Studio composer (attach + textarea)
  │  stage files (base64 + role), type prompt
  ▼  Send
POST /api/play/uploads { name, files[] }
  │  addUploadsToMiniapp(name, files)
  │    readMiniapp(name)            → exists? (404) + meta
  │    writeUploads(dir, files)     → merge into uploads//ref/, merge assets.json
  │    meta.uploads += counts       → durable
  │    commitWithLock(root)
  ▼  → { ship, ref }
send(uploadsPreamble + "\n\n" + prompt)   → running ACP agent turn
```

## Error handling

- Missing miniapp → 404 (`readMiniapp` throw). Bad/traversing name → 400 (`miniappDir`).
- Oversize / bad base64 that slips past the client mirror → `writeUploads` throws →
  400. Because the miniapp already exists (not a freshly-claimed dir), we do **not**
  `rmSync` the dir on throw — that's only correct for the create path's orphan
  cleanup. Partial-write risk is bounded: `writeUploads` validates all sizes/base64
  **before** writing any file, so a rejected batch writes nothing.
- Client keeps staged files on failure so Send can be retried after fixing the issue.

## Testing

Test-location convention (learned, costly): root vitest collects **root**
`dist/__tests__/**/*.test.js` only. `@agentgem/play` logic is tested from root
`src/__tests__/*.test.ts` importing the **built** package; console tests run
separately via `pnpm -C packages/console test` (jsdom, not CI-gated).

Server (`src/__tests__/`, import built `@agentgem/play`; `AGENTGEM_HOME=mktemp` per
test):

- `uploads.test.ts` merge cases: a second `writeUploads` on the same dir accumulates
  the manifest (old + new ship entries), suffixes a re-used ship/ref name against the
  on-disk file, and enforces the **cumulative** ship-total cap (batch that fits alone
  but blows the running total is rejected).
- New `addUploadsToMiniapp` test: adds to an existing miniapp, `meta.uploads` reflects
  old + new counts, `assets.json` merged, `ref/` gitignored; unknown name → throws
  `miniapp not found`.

Client (`pnpm -C packages/console test`):

- Studio: staging files enables Send with empty text; Send posts `/api/play/uploads`
  then sends a message containing the preamble; success clears chips.
- Composer refactor regression: existing `Composer.uploads.test.tsx` still passes
  against the extracted hook/component (may be re-pointed at `UploadsField`).

Inner loop for play changes: `pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/<f>.test.js`
(play is consumed as a built package → rebuild first).

## Files

**New**
- `packages/console/src/panels/Play/uploads.ts` (`useUploads` hook + constants)
- `packages/console/src/panels/Play/UploadsField.tsx`
- `src/__tests__/` additions (merge + addUploadsToMiniapp)

**Modified**
- `packages/play/src/uploads.ts` — `writeUploads` merge-awareness
- `packages/play/src/studio.ts` — `addUploadsToMiniapp`
- `src/schemas.ts` — `PlayUploads{Request,Response}Schema`
- `src/play.controller.ts` — `POST /play/uploads`
- `packages/console/src/api/routes.ts` — `playUploadsRoute`
- `packages/console/src/panels/Play/Composer.tsx` — consume shared hook/component
- `packages/console/src/panels/Play/Studio.tsx` — attach control + submit wiring
- `packages/console/src/shell/theme.css` — only if a new `.play-attach` class is added

## Traps to carry forward (from create-time work, still apply)

- Ship assets inline as data: URIs into the single self-contained HTML; the agent
  regenerates `index.html` wholesale, so it must re-inline from committed
  `uploads/assets.json` each build — the durable `uploadsBrief` already instructs this.
- Reference files must land in the gitignored `ref/`; `writeUploads` already writes the
  per-dir `.gitignore` — the merge change must not drop that line on a second batch.
- Agents can't retype MB data URIs — inlining is a server step, not agent copy-paste;
  keep the cumulative ship total ≤1MB.
