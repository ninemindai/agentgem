# Upload files to seed a miniapp (Blank & HTML) — Design

**Date:** 2026-07-18
**Status:** Approved (design), pending implementation plan

## Summary

Let the author drop one or more files into the **Blank** and **HTML** tabs of the
Studio composer to seed miniapp creation. Uploaded files are written into the new
miniapp's git workspace — which the studio coding-agent is already cwd-jailed to
with `permission:"allow"` — plus a machine-readable `uploads/assets.json` manifest
so the agent can inline ship-assets and read reference material.

This is **slice 1** of the larger "equip a miniapp project with skills & other
artifacts" vision. The same "write author-supplied material into the jailed
workspace before the build starts" seam generalizes to installing skills,
subagents, and rubrics later (see [Forward path](#forward-path)).

## Motivation

Today the composer offers five seed sources: Project, Session, Skill, HTML, Blank.
Only Project *conceptually* brings outside material into the build — and even that
only bakes the first 40 **file names** of the project as inert JSON
(`src/play.readers.ts` `readProject`); it does not give the agent file access, and
the agent is still jailed to the miniapp dir. Blank and HTML have no way to bring
in any author-supplied files at all.

Authors want to seed a miniapp with:
- **Ship-with files** — images, audio, fonts, data the finished miniapp uses.
  These must end up **inlined as `data:` URIs / baked data inside the single
  self-contained `index.html`**, because a shipped miniapp is one HTML file with no
  static asset server (it must run offline and on app.agentgem.ai).
- **Build-helper files** — a spec, reference code, a dataset the agent reads to
  inform what it builds, but that is **not shipped**.

## Key facts that shape the design

- The studio coding-agent (ACP) session is **cwd-jailed to the miniapp's own dir**
  (`miniappDir(name)`) with `permission:"allow"`
  (`src/goldmine/chatRoutes.ts` `resolveChatSession`, wired in
  `src/appCommon.ts` `resolveStudio`). Anything written into that dir is directly
  readable/editable by the agent. This is the mechanism for "giving the build
  access to files."
- The `brief` returned by `blankStudio`/`importStudio` is **discarded**: the
  controller returns only `{ name }`, and the chat session rebuilds its brief from
  `meta.json` via `studioBrief(name)`. The established one-shot channel to the
  agent is the **seedPrompt** the console auto-sends as the first chat message
  (`Studio.tsx` `seededRef`, threaded via `index.tsx`). Upload guidance rides
  there; exact filenames/types are discovered by the agent reading
  `uploads/assets.json`. **No response-schema change is needed.**
- The miniapp dir is a real git repo; `commitWithLock` commits the whole dir, so
  uploads are captured in the same seed commit.
- The JSON body limit is already raised to `25mb` (`src/appCommon.ts`) for base64
  payloads.

## Decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| File role | Both/mixed — files land in the workspace, agent decides per-file |
| UI placement | Optional multi-file dropzone added to the **Blank** and **HTML** tabs (no new tab, no new `GameSource` kind) |
| Server prep | **Raw files + `assets.json` manifest** (data: URIs for binaries; text read directly) |
| Scope | **File upload now, design for artifacts** — ship the slice, structure the seam for future skills/artifacts, don't build them |
| Ship-vs-reference tagging | **Agent infers, user hints in the prompt** — no per-file UI toggle |
| Uploads location | `uploads/` subdir (not workspace root; not an `assets/`-named dir that implies "ship") |
| Limits | ≤ 20 files, ≤ 5 MB/file, ≤ 15 MB total decoded |

## Data flow

```
Composer (Blank/HTML tab)
  files → base64 (FileReader.readAsDataURL, strip "data:...;base64," prefix)
        + keep File.type (MIME) and File.name
  POST /api/play/blank | /api/play/import
       { ...existing fields, files: [{ name, bytesBase64, type }] }
    → PlayController.blank() / import()
        → blankStudio(title, prompt, name, files)
          importStudio(title, html, name, files)
            claim dir → write index.html + meta.json
            → writeUploads(dir, files):
                uploads/<safe-name>        (raw bytes, every file)
                uploads/assets.json        (manifest)
            → single commitWithLock
    ← { name }
  onCreated(name, uploadsPreamble [+ blank description])
    → Studio auto-sends seedPrompt as first chat message
        → agent (cwd = miniappDir, permission allow)
            reads uploads/assets.json,
            inlines ship-assets into index.html,
            uses the rest as reference
```

## Manifest: `uploads/assets.json`

An array of entries, one per uploaded file:

```ts
type AssetEntry = {
  file: string;      // workspace-relative path, e.g. "uploads/logo.png"
  type: string;      // MIME from the browser (empty string if unknown)
  bytes: number;     // decoded byte length
  dataUri?: string;  // present ONLY for binaries — inline-ready
};
```

Classification (by MIME, extension fallback, unknown → binary as the safe default):

- **Binary** → gets `dataUri` so the agent never has to encode:
  `image/*` (except svg), `audio/*`, `video/*`, `font/*`, `application/pdf`,
  `application/octet-stream`, unknown/empty type.
- **Text** → **no** `dataUri` (keeps the manifest lean); the agent `Read`s the raw
  file at `uploads/<name>`: `text/*`, `application/json`, `image/svg+xml`.

## Agent instruction (seedPrompt)

When files are present, the console builds an uploads preamble, e.g.:

> I've added files to this project's workspace under `./uploads/` (see
> `uploads/assets.json`). Inline the ones that belong in the finished miniapp by
> embedding them into `index.html` — binaries are provided as ready-to-use `data:`
> URIs in `assets.json`; text files you can read directly from `./uploads/`. Treat
> the rest as reference only — do not ship them.

- **Blank tab:** joined with the existing capability preamble and the Blank
  description (`[capPreamble, uploadsPreamble, blankPrompt].filter(Boolean).join("\n\n")`).
- **HTML tab:** `doImport` currently passes no seedPrompt; when files are present it
  passes the uploads preamble so the agent knows to use them while refining the
  imported HTML.

## Components to touch

- **`packages/console/src/panels/Play/Composer.tsx`**
  - Optional multi-file dropzone on the Blank and HTML tabs (reuse `.play-drop`).
  - `uploads` state: `{ name: string; bytesBase64: string; type: string; size: number }[]`.
  - A file-chip list with per-file remove (×); shows name + size.
  - Client-side limit enforcement with a friendly error (mirrors server caps).
  - `doBlank`/`doImport` include `files` in the POST body when non-empty and build
    the uploads preamble for `onCreated`.
- **`packages/console/src/shell/theme.css`**
  - One new `.play-uploads` rule for the chip list, reusing existing design tokens
    (per the project rule: every className must have a matching CSS rule).
- **`src/schemas.ts`**
  - `UploadFileSchema = z.object({ name: z.string().min(1), bytesBase64: z.string(), type: z.string().optional() })`.
  - Add optional `files: z.array(UploadFileSchema).optional()` to
    `PlayBlankRequestSchema` and `PlayImportRequestSchema`.
- **`packages/play/src/studio.ts`**
  - New `writeUploads(dir, files)` helper.
  - Thread `files?` through `blankStudio` and `importStudio` (call `writeUploads`
    after writing `index.html`/`meta.json`, before the commit).
- **`src/play.controller.ts`**
  - Pass `input.body.files` into `blankStudio`/`importStudio`.

## Security & limits

- **Filename sanitization** (`writeUploads`): basename only; preserve the
  extension; reject empty, `.`, `..`, path separators, and leading dots (no
  dotfiles / `.git`). Collapse to a single safe path segment. In-batch name
  collisions get suffixed. All writes are namespaced under `dir/uploads/`, so no
  reserved-name clash with `index.html`/`meta.json` and no path escape.
- **Limits**, enforced **server-side (400)** and **client-side (friendly error)**:
  ≤ 20 files, ≤ 5 MB per file, ≤ 15 MB total decoded. 15 MB decoded ≈ 20 MB base64
  (~1.33×), under the existing 25 MB JSON body cap.
- **Bad base64** → 400.

## Error handling

- Over-limit / bad-name / bad-base64 → server 400; surfaced in the composer's
  existing `.play-banner` error area.
- Client pre-validates size/count and blocks the request with the same message so
  the round-trip is avoided.

## Testing

- **`packages/play` unit** — `writeUploads`: filename sanitization,
  traversal/reserved rejection, binary-vs-text classification, manifest shape,
  limit enforcement; `blankStudio`/`importStudio` with files write `uploads/` and
  commit atomically.
- **schema unit** — optional `files` accepted; over-limit rejected.
- **console (jsdom)** — dropzone renders on Blank + HTML, loads multiple files,
  chip list + remove works, posts `files`, builds the uploads seedPrompt. (jsdom
  asserts behavior only; appearance is verified in a real browser per the project
  UI rule.)

## Forward path

The same "write author-supplied material into the jailed workspace before the
build starts" seam generalizes to the "equip a miniapp project with skills & other
artifacts" vision:

- A later slice installs gem artifacts into the workspace's `.claude/skills/`,
  `.claude/agents/`, rubric locations, etc. — discovered by the ACP agent relative
  to its cwd.
- Keeping user uploads under `uploads/` (distinct from a future `.claude/`)
  preserves the separation between author-supplied assets and installed gems.
- The composer could later grow an "Add skills / artifacts" picker beside the
  dropzone, reusing the inventory/gem routes.

No code for this is written in slice 1.

## Non-goals (slice 1)

- No new `GameSource` variant / `createdFrom` change — uploads are an optional
  add-on to the existing `html`/`blank` seeds.
- No per-file ship/reference UI toggle.
- No installing skills/subagents/rubrics into the workspace.
- No `multipart`/`FormData` upload path — uploads use the existing
  base64-in-JSON convention.
