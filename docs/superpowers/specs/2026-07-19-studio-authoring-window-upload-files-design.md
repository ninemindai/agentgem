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
- Staged chips are cleared on a successful **upload** (the files are then durably in the
  workspace); the agent-announce `send` that follows is best-effort and never re-uploads
  (see §4 and Error handling).

## Architecture

### 1. Server — add files to an *existing* miniapp

New exported function in `packages/play/src/studio.ts` (review Issue 3 — returns the
actual stored records, not just counts):

```ts
export async function addUploadsToMiniapp(
  name: string,
  files: UploadFile[],
): Promise<{ files: { requested: string; stored: string; role: UploadRole }[]; ship: number; ref: number }>;
```

Steps:

1. **Explicit existence check** (review Codex #1). `readMiniapp` does NOT throw
   `miniapp not found` — `readMiniappRaw` (`miniapps.ts:225`) `readFileSync`s the html
   and would throw a raw `ENOENT` for a missing miniapp, which the controller mapping
   would turn into a 400. So mirror `deleteMiniapp` (`miniapps.ts:192`):
   `const dir = miniappDir(name); if (!existsSync(dir)) throw new Error(\`miniapp not found: '${name}'\`);`
   `miniappDir` validates + jails the name (bad name → 400).
2. `const written = writeUploads(dir, files);` — writes into the existing workspace
   (merge-aware, see §2) and **returns the stored records** `{ requested, stored, role }`
   (§2). `stored` is the sanitized/suffixed on-disk name.
3. **Recompute the durable counter from post-write disk state** (review Codex #9 —
   `meta.uploads += counts` is untrustworthy because a prior Save may have wiped it,
   and the merge state is derived from the filesystem anyway). Count the actual entries:
   `meta.uploads = { ship: <# files in uploads/ excluding assets.json>, ref: <# files in ref/> }`
   (`writeUploads` can return these cumulative totals directly since it already reads
   both dirs for the merge). Write `uploads` only when non-zero.
4. `writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));`
5. **Do NOT commit** (review Issue 2). The Studio agent reads files from its working
   directory, not from git, so uploads are visible the instant they're written; and
   `studioBrief` reads `meta.json` from **disk**, so the recomputed counter survives a
   resume without a commit. Committing here would run `commitAll`'s `git add -A` at
   the registry root (`git.ts:46`) and sweep the agent's uncommitted in-progress
   `index.html` into an "add uploads" commit. Durability is already handled two ways:
   the **per-turn checkpoint** (`chatRoutes.ts:232` → `checkpointMiniapp` after every
   successful studio turn) commits the workspace after the Send turn, and an explicit
   **Save** commits it too. The uncommitted per-dir `.gitignore` still takes effect
   (git honors a working-tree `.gitignore`), so `ref/` stays out of both.
6. `return { files: written, ship, ref };` — the client builds the agent preamble and
   clears its chips from `written` (the real stored names), never from raw staged names.

Error mapping in the controller mirrors `/play/delete`: a message starting with
`miniapp not found` → 404, everything else → 400.

### 1a. Server — `saveMiniapp` preserves the server-owned `uploads` counter (review Issue 1)

`saveMiniapp` writes `meta.json` from the **client** request body (`miniapps.ts:168`),
and Studio's `save()` (`Studio.tsx:335-341`) builds that body from
`title/genre/createdFrom/engineVersion/needs/mcpNeeds` — it does **not** carry
`uploads`. So the first Save after any upload wipes `meta.uploads`, and
`studioBrief`'s "this project has author-supplied files…" line stops firing on
resume. This is a **pre-existing bug in the shipped create-time feature**
(#484/#485) that mid-session upload would trigger on every batch.

Fix, server-side, in one place: before writing `meta.json`, if the incoming meta
omits `uploads`, carry it forward from the existing on-disk meta:

```ts
// uploads is server-owned (only writeUploads/addUploadsToMiniapp set it); the client
// never edits it, so preserving it from disk can't clobber a legitimate client change.
const prev = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) as MiniappMeta : undefined;
if (meta.uploads === undefined && prev?.uploads) meta.uploads = prev.uploads;
```

This fixes both the latent create-time wipe and the mid-session case with no client
change. Reads `meta.json` once before the existing write — negligible cost.

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
- Seed `shipTotal` from the summed `bytes` of the preloaded manifest entries. This
  makes the ship ≤1MB **total cumulative across batches** — and *that* (ship, inlined
  as data: URIs into the single HTML) is what protects the 1.5MB save gate. Seed
  `refTotal` from existing `<dir>/ref/` sizes so the ref ≤15MB total is cumulative
  too, but note (review Codex #10) the ref cap is a **storage/context limit only** —
  reference files are never inlined, so they don't touch the save gate.

Two more changes to `writeUploads` from the review:

- **Atomicity fix (review Codex #5).** Today `sanitizeUploadName` runs *inside* the
  write loop (`uploads.ts:88/97`), so a batch of `[good.png, "../bad"]` writes
  `good.png` and *then* throws — leaving a partial write. The create path masked this
  with an `rmSync` orphan-release; the mid-session path writes into an existing dir and
  must **not** `rmSync`. Fix: sanitize + plan every stored name (run `sanitizeUploadName`
  and the `uniq` suffixing) in the **pre-validation pass**, alongside the size/base64
  checks, so any bad name throws before the first byte is written. Then the write loop
  only does I/O. Now "a rejected batch writes nothing" is actually true for both paths.
- **Return stored records (review Issue 3).** `writeUploads` returns
  `{ files: { requested, stored, role }[]; ship: number; ref: number }` where `ship`/`ref`
  are the **cumulative on-disk totals** (it already enumerates both dirs for the merge),
  and each `stored` is the final sanitized/suffixed name. Callers (`addUploadsToMiniapp`,
  and the create paths) use `stored` for accurate briefs and the totals for `meta.uploads`.

`MAX_FILES` (20) stays a **per-batch** guard (the byte totals are the real cumulative
constraint). Write the merged manifest at the end as today.

**Backward compatibility:** a freshly-claimed create dir has an empty `uploads/`,
no `ref/`, and no `assets.json`, so every preload is empty and the returned records +
totals match this batch exactly — behavior is byte-identical to the shipped create
path (the create-path callers ignore the new `files` field). This is one code path —
create gets the atomicity fix for free. Existing `uploads.test.ts` assertions on the
manifest/counts still hold; the return-shape widening is additive.

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
  Takes a **`compact` prop** (review Codex #11): compact renders just an **attach
  button + inline chip row** (no big dropzone) for the dense Studio composer; the
  default full mode keeps the Composer's dropzone. Both share the chip/role list so
  the extraction stays DRY without forcing the heavy dropzone onto the busy Studio bar.

`Composer.tsx` is refactored to consume `useUploads()` + `<UploadsField>` (full mode);
its observable behavior is unchanged (regression-tested).

### 4. Client — wire it into the Studio composer bar

In `Studio.tsx`, inside `play-composer-in` (the textarea + Send row at ~line 722):

- Instantiate `useUploads()`.
- Render `<UploadsField compact>` (attach button + inline chip strip) in the composer
  foot next to Send. Reuse `.play-btn`; if a dedicated `.play-attach` class is added,
  add a matching rule in `theme.css` in the same change (per the repo UI rule — every
  className must be CSS-enforced).
- Rework `submit()` (review Issue 3 + Codex #6 for the clear-timing):
  1. Compute `staged = uploads.uploads`. Guard: if `!input.trim() && !staged.length`
     or `busy` or `!agentId`, return.
  2. Client-side limit check via `uploads.limitError()`; surface it and abort if set.
  3. If `staged.length`:
     `const res = await playUploadsRoute.call(client, { body: { name, files: uploads.payload().files } });`
     On success **clear the chips now** (`uploads.reset()`) — the files are durably in
     the workspace; the send that follows is best-effort and must not be able to cause
     a re-upload. On upload **failure**, keep the chips and surface the error, then
     return (no send). This is the atomicity boundary (Codex #6/#7): "uploaded" and
     "announced" are separate; a failed announce never re-uploads.
  4. Build the preamble from the **server response** `res.files` (real stored names),
     not staged names: `const pre = uploadsPreambleFromStored(res.files);`
     `const text = [pre, input.trim()].filter(Boolean).join("\n\n");` then `send(text)`
     (files-only → `text` is just the preamble). `setInput("")`.
  5. If there were no staged files, `send(input.trim())` as today.
- Send button `disabled = busy || !agentId || (!input.trim() && !staged.length)`.
- Because chips are cleared on upload success (step 3), a failed agent turn leaves the
  files uploaded + durably briefed on resume; retry is just re-sending a prompt, which
  never duplicates files.

### 5. Route + schema wiring

- `packages/play/src/index.ts`: **export `addUploadsToMiniapp`** (review Codex #8 —
  the controller and the root tests import it from the built `@agentgem/play`, so it
  must be re-exported next to the existing `writeUploads`/`seedStudio` exports, else the
  build/tests fail).
- `src/schemas.ts`: `PlayUploadsRequestSchema = { name: string, files: UploadFileSchema[] }`,
  `PlayUploadsResponseSchema = { files: { requested: string, stored: string, role: enum("ship","reference") }[], ship: number, ref: number }`.
  Reuse the existing `UploadFileSchema` (already drift-guarded against `@agentgem/play`'s
  `UploadFile`).
- `src/play.controller.ts`: `@post("/play/uploads")` → `addUploadsToMiniapp`, with the
  404/400 error mapping above.
- `packages/console/src/api/routes.ts`: `export const playUploadsRoute = defineRoute("POST", "/api/play/uploads", { body: ..., response: ... })`, reusing `playUploadFileSchema`; the response carries the stored records.

## Data flow

```
Studio composer (attach + textarea)
  │  stage files (base64 + role), type prompt
  ▼  Send
POST /api/play/uploads { name, files[] }
  │  addUploadsToMiniapp(name, files)
  │    readMiniapp(name)            → exists? (404) + meta
  │    writeUploads(dir, files)     → merge into uploads//ref/, merge assets.json
  │    meta.uploads += counts       → written to DISK (durable via disk read; NO commit)
  ▼  → { ship, ref }
send(uploadsPreamble + "\n\n" + prompt)   → running ACP agent turn
       (agent reads uploads/ + ref/ from its cwd immediately)

later … user hits Save
  │  saveMiniapp({ name, html, meta })   meta from client omits `uploads`
  │    meta.uploads ??= diskMeta.uploads  → preserve server-owned counter (Issue 1)
  │    commitWithLock(root)               → git add -A commits uploaded files + meta
  ▼                                          (.gitignore keeps ref/ out)
```

## Error handling

- Missing miniapp → 404 via the **explicit `existsSync` check** in `addUploadsToMiniapp`
  (review Codex #1 — `readMiniapp` alone throws a raw `ENOENT`, which would mis-map to
  400). Bad/traversing name → 400 (`miniappDir`).
- Oversize / bad base64 / unsafe filename that slips past the client mirror →
  `writeUploads` throws → 400. Because the miniapp already exists (not a freshly-claimed
  dir), we do **not** `rmSync` the dir on throw. Partial-write risk is closed by the
  §2 atomicity fix (review Codex #5): **all** validation — sizes, base64, *and*
  filename sanitization/collision-planning — happens before the first byte is written,
  so a rejected batch writes nothing even into an existing dir.
- Upload OK but the agent turn (`send`) fails → files are already durable in the
  workspace; chips were cleared on upload success, so retry re-sends a prompt and never
  re-uploads (review Codex #6/#7). Upload failure → chips kept, error surfaced, no send.

## Testing

Test-location convention (learned, costly): root vitest collects **root**
`dist/__tests__/**/*.test.js` only. `@agentgem/play` logic is tested from root
`src/__tests__/*.test.ts` importing the **built** package; console tests run
separately via `pnpm -C packages/console test` (jsdom, not CI-gated).

Server (`src/__tests__/`, import built `@agentgem/play`; `AGENTGEM_HOME=mktemp` per
test):

- **CRITICAL regression (Issue 1)** — `saveMiniapp` preserves `uploads`: create a
  miniapp carrying `meta.uploads`, call `saveMiniapp` with a client meta that omits
  `uploads`, assert the on-disk `meta.json` still has the counter. Locks the
  pre-existing create-time wipe shut. Mutation-verify by removing the preserve line →
  test must fail.
- **Regression** — `uploads.test.ts` merge cases: a second `writeUploads` on the same
  dir accumulates the manifest (old + new ship entries), suffixes a re-used ship/ref
  name against the on-disk file, and enforces the **cumulative** ship-total cap (batch
  that fits alone but blows the running total is rejected). Plus a backward-compat
  case: a first call on a fresh dir is byte-identical to today (empty preload).
- **Atomicity (Codex #5)** — `writeUploads` with `[good.png, "../bad"]` throws AND
  leaves the dir unchanged (no `good.png` written). Mutation-verify by moving the
  sanitize back into the write loop → test must fail (partial write appears).
- **Stored records (Issue 3)** — `writeUploads`/`addUploadsToMiniapp` return
  `{ requested:"My Logo.png", stored:"my-logo.png" }` for a sanitized name and
  `stored:"logo-2.png"` for a name colliding with an on-disk file; returned `ship`/`ref`
  are cumulative on-disk totals. `meta.uploads` matches those totals (recomputed, not
  `+=`) even when the prior `meta.uploads` was absent.
- New `addUploadsToMiniapp` test: adds to an existing miniapp, `assets.json` merged,
  `ref/` gitignored, **no new commit** (`git rev-list --count HEAD` unchanged);
  **unknown name → throws `miniapp not found`** (via the explicit `existsSync`, Codex #1);
  oversize batch → throws (→400).

Client (`pnpm -C packages/console test`):

- Studio: staging files enables Send with empty text; Send posts `/api/play/uploads`,
  then sends a message whose preamble uses the **server-returned stored names**
  (mock the route to rename `My Logo.png`→`my-logo.png` and assert the sent text says
  `my-logo.png`); chips clear on **upload** success; on upload failure chips are kept
  and no send fires.
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
- `packages/play/src/uploads.ts` — `writeUploads` merge-awareness + pre-write atomicity + return stored records
- `packages/play/src/studio.ts` — `addUploadsToMiniapp` (existsSync check, recompute counts, no commit)
- `packages/play/src/index.ts` — export `addUploadsToMiniapp` (Codex #8)
- `packages/play/src/miniapps.ts` — `saveMiniapp` preserves `uploads` from disk (Issue 1)
- `src/schemas.ts` — `PlayUploads{Request,Response}Schema`
- `src/play.controller.ts` — `POST /play/uploads`
- `packages/console/src/api/routes.ts` — `playUploadsRoute`
- `packages/console/src/panels/Play/Composer.tsx` — consume shared hook/component
- `packages/console/src/panels/Play/Studio.tsx` — attach control + submit wiring
- `packages/console/src/shell/theme.css` — only if a new `.play-attach` class is added

## NOT in scope (considered, deferred)

- **Scoped-path commit helper** (Issue 2 option C) — a `commitPaths(dir, [...])` that
  stages only the upload paths. We chose no-commit mid-session instead; revisit only if
  uncommitted mid-session state proves fragile.
- **Cumulative file-count cap** — `MAX_FILES` (20) stays per-batch; the cumulative
  ship/ref **byte** totals are the real bound. A cumulative count cap is unneeded.
- **Raising the 1.5MB save gate** — unchanged; still deferred from the create-time work.
- **Delete/rename staged uploads server-side** — the chip strip removes *staged* files
  pre-send; removing already-written workspace files is a separate concern (the agent
  can, or a future manage-files surface).
- **Re-inline on every build** — already handled by the durable `uploadsBrief`; no new
  mechanism here.

## What already exists (reused, not rebuilt)

- `writeUploads(dir, files)` — the entire ship/ref write + `assets.json` + `.gitignore`
  machinery. Extended (merge-aware), not duplicated.
- `miniappDir(name)` / `readMiniapp(name)` — name validation + jail + existence. Reused
  for the new endpoint's 404/400 mapping.
- `studioBrief` / `uploadsBrief` — durable per-session announcement. Reused unchanged;
  Issue 1 just stops Save from erasing its input.
- Composer upload UI (encode, role toggle, chips, limit checks) — extracted into the
  shared `useUploads`/`UploadsField`, consumed by both surfaces.
- `.play-uploads*` / `.play-drop` CSS — reused; no new class unless an attach button
  needs one (then paired in `theme.css`).

## Failure modes (per new codepath)

| Codepath | Realistic failure | Test? | Error handling? | User sees |
|---|---|---|---|---|
| `POST /play/uploads` unknown/deleted name | 404 | yes | yes (404) | error surfaced in composer; chips retained |
| `writeUploads` oversize / bad base64 slips client mirror | throw → 400 | yes | yes; validates all sizes before any write (atomic) | error surfaced; nothing written; chips retained |
| upload OK but `send()` (agent turn) fails | agent/network error | client test | files already on disk + meta bumped; retry send | agent turn error; files persist, safe to retry |
| Save after upload with client meta omitting `uploads` | counter wiped | **CRITICAL regression test** | Issue 1 fix (disk-preserve) | brief keeps announcing files on resume |
| concurrent Save + upload meta read-modify-write (two tabs) | last-writer-wins on `meta.uploads` | not covered | none | low-prob; single-UI busy-guard mitigates — see appendix |

No new failure mode is both silent **and** untested **and** unhandled → no critical
gap. The two-tab meta race is the one residual (low probability, non-silent-ish): noted
in the review appendix, not blocking.

## Worktree parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| S1 merge-aware `writeUploads` + `addUploadsToMiniapp` + save-preserve | `packages/play/src` | — |
| S2 route + schemas | `src/`, `packages/console/src/api` | S1 (types) |
| S3 extract `useUploads`/`UploadsField` + Composer refactor | `packages/console/src/panels/Play` | — |
| S4 Studio wiring | `packages/console/src/panels/Play` | S2, S3 |

- **Lane A:** S1 → S2 (sequential; S2 imports S1's types).
- **Lane B:** S3 (independent — pure client refactor, no server dep).
- **Merge, then S4** (needs both the route from A and the shared component from B).

Lane A (`packages/play` + `src`) and Lane B (`packages/console/src/panels/Play`) touch
disjoint modules → safe to run in parallel worktrees. **Conflict flag:** S3 and S4 both
touch `panels/Play` — keep them in one lane (S4 after S3), do not parallelize.

## Traps to carry forward (from create-time work, still apply)

- Ship assets inline as data: URIs into the single self-contained HTML; the agent
  regenerates `index.html` wholesale, so it must re-inline from committed
  `uploads/assets.json` each build — the durable `uploadsBrief` already instructs this.
- Reference files must land in the gitignored `ref/`; `writeUploads` already writes the
  per-dir `.gitignore` — the merge change must not drop that line on a second batch.
- Agents can't retype MB data URIs — inlining is a server step, not agent copy-paste;
  keep the cumulative ship total ≤1MB.

## GSTACK REVIEW REPORT

Engineering plan review of this spec (branch `test-open-core`, no implementation yet).
Four sections (Architecture, Code Quality, Tests, Performance) + Codex outside voice.

| Run | Status | Findings |
|---|---|---|
| Architecture | issues_found | Issue 1 (P1 durability), Issue 2 (P2 commit blast-radius), Issue 3 (P1 stored-name contract) |
| Code Quality | clean* | *one residual: two-tab concurrent-write lost-update (low prob, appendix) |
| Tests | issues_found | +2 mandatory regressions (save-preserve, merge) + atomicity/stored-record/no-commit/404 cases |
| Performance | clean | no DB/N+1; base64 body already tolerated by create routes; O(files) merge preload |
| Codex (outside voice) | issues_found | 11 items — all verified against code; 3 plan-changing, rest folded as corrections |

**Decisions locked (via AskUserQuestion):**
- **Issue 1 → A** — `saveMiniapp` preserves server-owned `uploads` from disk (also fixes the pre-existing create-time wipe #484/#485).
- **Issue 2 → B** — `addUploadsToMiniapp` does NOT commit; per-turn checkpoint + Save persist. Avoids `git add -A` sweeping in-progress drafts.
- **Issue 3 → A** — endpoint returns actual stored file records `{requested, stored, role}` + cumulative counts; client builds preamble + clears chips from that (closes Codex #3/#7/#9).

**Codex absorbed:** #2 = consensus with Issue 1. #4 refines Issue 2 (per-turn checkpoint is the real commit) + a residual concurrency note (appendix). Folded as non-negotiable corrections: #1 explicit `existsSync`→404, #5 pre-write atomicity (sanitize before any write), #6/#7 clear-chips-on-upload (uploaded vs announced), #8 `index.ts` export, #9 recompute counts from disk, #10 ref-cap wording (storage limit, not gate protection), #11 `UploadsField compact` mode.

**CROSS-MODEL TENSION:** none material. Both models independently flagged the Save-wipes-`uploads` bug (Issue 1 / Codex #2) — strong consensus. Codex #4 refined Issue 2's rationale rather than contradicting it.

**VERDICT:** Plan is sound and materially hardened. Spec updated in place; ready for the implementation plan (`writing-plans`). Suggested lanes: Lane A `packages/play`+`src` (S1→S2), Lane B console refactor (S3) in parallel, then S4 Studio wiring.

NO UNRESOLVED DECISIONS
