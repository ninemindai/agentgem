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

## Decisions

Rows marked **(rev. by eng review)** were changed during `/plan-eng-review`
(2026-07-18); see [Review outcome](#review-outcome-plan-eng-review-2026-07-18)
for the reasoning. They supersede the original brainstorming choice.

| Decision | Choice |
| --- | --- |
| File role | Both/mixed — ship-assets and reference material |
| UI placement | Optional multi-file dropzone added to the **Blank** and **HTML** tabs (no new tab, no new `GameSource` kind) |
| Server prep | **Raw files + `assets.json` manifest** (data: URIs for binaries; text read directly) |
| Scope | **File upload now, design for artifacts** — ship the slice, structure the seam for future skills/artifacts, don't build them |
| Ship-vs-reference tagging | **(rev. by eng review)** Per-file **Ship / Reference** toggle in the dropzone (default Ship). The server can't classify at write time, so the role comes from the UI. |
| Uploads location | **(rev. by eng review)** Ship files → `uploads/` (**git-tracked**); Reference files → `ref/` (**gitignored** in the registry, never committed or pushed) |
| Upload signal durability | **(rev. by eng review)** Durable `meta.uploads: { ship, ref }` counter → `studioBrief` names the dirs every session start; seedPrompt kept for the rich first-turn hint |
| Framing | **(rev. by eng review)** **Reference-first.** Reference is the primary, low-risk half (no gate, no inlining, no size ceiling). Ship-asset inlining is a small gate-safe extra. |
| Limits | **(rev. by eng review)** **Reference:** ≤ 20 files, ≤ 5 MB/file, ≤ 15 MB total. **Ship:** ≤ 500 KB/file, ≤ 1 MB total — because the save gate rejects any bundle > 1.5 MB (`gameGate.ts:22`) and ship-assets inline into `index.html`. Import must also fit `html` + `files` under the 25 MB body cap. |
| Ship inlining | **(rev. by eng review)** Server/tool step, **not agent copy-paste** — an LLM can't reliably retype MB-scale data URIs. Ship data URIs live in a **committed** `uploads/assets.json` (small, ≤ 1 MB) the agent inlines from; durable brief points at it. |

## Data flow

> **Superseded in part by [Review outcome](#review-outcome-plan-eng-review-2026-07-18):**
> files carry a per-file `role`; reference → gitignored `ref/`, ship → tracked
> `uploads/`; the manifest is committed and ship-only; ship is inlined via a
> server/tool step, not agent copy-paste. The flow shape below still holds.

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

> **Superseded in part by [Review outcome](#review-outcome-plan-eng-review-2026-07-18):**
> the manifest is **committed** (not gitignored) and covers **ship** files only
> (≤ 1 MB total, so `data:` URIs stay small and durable across resume); reference
> files live in gitignored `ref/` and are read raw, not manifested.

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
- No installing skills/subagents/rubrics into the workspace.
- No save-time inference of ship-vs-reference (rejected in review — clever/fragile;
  the per-file toggle is the explicit signal instead).
- No `multipart`/`FormData` upload path — uploads use the existing
  base64-in-JSON convention.

## Review outcome (plan-eng-review, 2026-07-18)

Two architecture findings changed the design; the [Decisions](#decisions) table
is updated to match. Reasoning captured here so the change history is legible.

### Issue 1 — "reference" uploads leaked to the registry; ship-vs-reference needs a signal

`commitWithLock(root)` commits the whole miniapp dir and `push(root)` runs
`git push -u origin HEAD` on the **entire registry repo** (`packages/play/src/git.ts`).
So the original "write every upload into a committed `uploads/`" plan meant a file
the user dropped as *reference* would be committed and pushed to the registry
remote on publish — contradicting "not shipped" — and would bloat git history
(raw bytes + data-URI copies, on top of the copy inlined into `index.html`).

The marketplace path is unaffected: `writeGameGem` builds the gem from `html` +
`meta` only (`miniapps.ts:83-96`) and `readMiniapp` serves only `index.html` +
`meta.json`. Because a shipped miniapp is a single self-contained HTML with no
asset server (`assertPortable`; app.agentgem.ai serves only the HTML), a
ship-asset **must be inlined as a `data:` URI into `index.html`** — it can never
ship as a separate file.

Resolution: a **per-file Ship / Reference toggle** (default Ship) supplies the
role the server can't infer at write time.

- **Ship** → raw file written to **git-tracked** `uploads/` (versioned; survives
  cross-machine durable resume) + listed in the manifest with an inline-ready
  `data:` URI for binaries. Ship bytes also persist inside the committed
  `index.html` once the agent inlines them.
- **Reference** → raw file written to **gitignored** `ref/`; the jailed agent
  reads it during the build, but it is never committed or pushed.
- Registry `.gitignore` gains `ref/`. A **regression test** must assert `ref/` is
  ignored and `uploads/` is tracked — a broken ignore rule is a silent private-file
  leak on publish (no error path exists).

**Manifest placement (implementation detail, settle in code):** to avoid
triple-storing ship binary bytes (raw `uploads/` + `data:` in a committed manifest
+ inlined in `index.html`), keep the data-URI manifest as a **gitignored build
aid** regenerable from `uploads/` + `ref/`, OR commit a pointer-only manifest
(`file`/`type`/`bytes`/`role`, no `dataUri`) and have the agent encode from the
committed raw file. Default to the gitignored-manifest option; the raw ship file
is the durable committed copy.

### Issue 2 — upload signal was a one-shot in-memory seedPrompt

The only cue telling the agent uploads exist was the one-shot `seedPrompt`
(`Studio.tsx:207`, `seededRef`), which is in-memory component state — lost on a
reload before the first turn or a cross-machine durable resume, leaving the agent
blind to files sitting in its cwd.

Resolution: persist a lightweight `meta.uploads: { ship: n, ref: m }` counter;
`studioBrief` (which reads `meta.json` every session start) appends one line naming
`./uploads/` and `./ref/` when present. Durable across reload and resume. The
seedPrompt stays for the richer first-turn hint. `meta.uploads` is added to
`MiniappMeta` with a paired `alter`-style default (absent ⇒ no uploads), and the
`/play/miniapp` read model passes it through only when present.

## NOT in scope (deferred, with rationale)

- **Save-time cleanup of consumed uploads** — after the agent inlines ship-assets,
  the raw `uploads/` copies remain. Deferred: they're the versioned originals
  (issue 1); a GC pass is a separate lifecycle concern. → TODO candidate.
- **Cross-machine resume of `ref/` files** — reference files are gitignored, so a
  durable resume on another machine won't have them. Accepted: reference material
  is build-time context, consumed in the authoring session.
- **Installing skills / subagents / rubrics** — the "equip with artifacts" vision;
  same write-into-workspace seam, separate slice (see Forward path).
- **`multipart`/`FormData`** — base64-in-JSON is the existing convention.

### Cross-model tension resolution (outside voice)

An independent review pass surfaced findings the section review missed; all
code-verified. Resolved by the user toward **reference-first, gate-safe ship**:

- **Finding A (CONFIRMED) — the 1.5 MB save gate.** `saveMiniapp` calls
  `gameGate(html)` with no override (`miniapps.ts:115`); the gate rejects any
  bundle > 1,500,000 bytes measured on the *full* HTML incl. inlined `data:` URIs
  (`gameGate.ts:22,62`). The original 5 MB/15 MB limits are unshippable for ship
  assets. → Ship capped to ≤ 500 KB/file, ≤ 1 MB total; reference keeps the larger
  limits (it never inlines).
- **Finding B (CONFIRMED) — no `.gitignore` exists.** `ensureRepo` writes none
  (`git.ts`); existing registries have none. → T2 must **create + backfill** the
  ignore rule on every registry (existing installs too), not just "add a line."
- **Finding C (PLAUSIBLE) — agents can't retype MB data URIs.** Reading a 1 MB
  URI is ~350k tokens and unreliable. → Ship inlining is a **server/tool step**,
  and ship total is small (≤ 1 MB) so the committed manifest stays readable.
- **Wholesale-regen caveat (implementation).** The studio agent "regenerates the
  document wholesale and drops whatever `<head>` held" (`saveMiniapp` comment). So
  server-pre-inlining ship assets into `index.html` at *seed* time does not
  survive the agent's first rebuild. Durable path: keep ship data URIs in the
  **committed** `uploads/assets.json`, and have the durable brief instruct the
  agent to re-inline from it on every build. Settle the exact re-inline mechanism
  (brief instruction vs a host-provided inline tool) in code.
- **Strategic reframe accepted:** reference files carry most of the author value
  at near-zero risk; ship is a small gate-safe extra. The manifest is now small
  enough to commit, which also resolves the earlier durability/manifest conflict.

## Implementation Tasks

Synthesized from this review. Each derives from a specific finding. P1 blocks
ship; P2 same-branch; P3 follow-up. Reference-first ordering.

- [ ] **T1 (P1, human: ~3h / CC: ~25min)** — `packages/play/src/studio.ts` — add
  `writeUploads(dir, files)`: sanitize names (reject `..`/`/`/leading-dot/empty,
  single safe segment, in-batch collision suffix), split by role → reference to
  gitignored `ref/`, ship to git-tracked `uploads/`, classify binary/text, emit a
  committed `uploads/assets.json` (data URIs for ship binaries only), enforce
  **role-specific** limits (ship ≤ 500 KB/≤ 1 MB gate-safe; reference ≤ 5 MB/≤ 15 MB)
  → throw on breach, reject bad base64.
  - Verify: `packages/play` unit tests, ★★★ (sanitize + classify + role-limits).
- [ ] **T2 (P1, human: ~1.5h / CC: ~12min)** — registry `.gitignore` — **create it in
  `ensureRepo` and backfill existing registries** (ignore `ref/`, track `uploads/`).
  **Regression test** asserting `ref/` never enters a commit/push on a fresh AND a
  pre-existing repo (critical: silent private-file leak otherwise).
- [ ] **T3 (P2, human: ~1.5h / CC: ~12min)** — `studio.ts` + `miniapps.ts` — thread
  `files` + roles into `blankStudio`/`importStudio`; write `meta.uploads` counter;
  `studioBrief` names `./uploads/` + `./ref/` and points at `uploads/assets.json`
  when present, with the re-inline instruction; add `uploads` to `MiniappMeta`
  (absent ⇒ none, paired default).
- [ ] **T4 (P2, human: ~1h / CC: ~10min)** — `src/schemas.ts` + `play.controller.ts` —
  `UploadFileSchema` (`name`, `bytesBase64`, `type?`, `role`), optional `files` on
  blank/import request schemas, server-side role-specific limit + combined-body
  validation (import `html` + `files` under 25 MB), pass through. Over-limit → 400.
- [ ] **T5 (P2, human: ~2h / CC: ~20min)** — `Composer.tsx` — multi-file dropzone on
  Blank + HTML, per-file Ship/Reference toggle (default Ship), chip list + remove,
  client-side role-specific limit pre-check with friendly error, async file read
  with progress/disabled-submit (avoid UI-thread stall on ~15 MB), post `files`
  with roles, build the durable-aware seedPrompt.
- [ ] **T6 (P2, human: ~20min / CC: ~5min)** — `shell/theme.css` — `.play-uploads`
  chip-list + toggle rule using existing tokens (every class CSS-enforced).
- [ ] **T7 (P3, human: ~30min / CC: ~5min)** — follow-up TODO — GC pass to drop
  consumed `uploads/` ship originals once inlined (deferred; see NOT in scope).
- [ ] **T8 (P3)** — follow-up TODO — decide whether to raise `gameGate` `maxBytes`
  for large ship-assets (own review; PWA/offline/serve blast radius).

## Worktree parallelization

| Step | Modules | Depends on |
|------|---------|------------|
| T1/T2/T3 | `packages/play` | — |
| T4 | `src/` (schemas, controller) | files/role shape from T1 |
| T5/T6 | `packages/console` | T4 wire shape |

`Lane A: T1 → T2 → T3 (sequential, shared packages/play)` ·
`Lane B: T4 (src/, independent once the files+role shape is fixed)` ·
`Lane C: T5 → T6 (sequential, shared packages/console, waits on T4's wire shape)`.
Launch A + B in parallel; C after B. No two lanes share a module dir — clean split.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_resolved | 5 issues (3 arch + 2 code-verified from outside voice), 1 critical gap flagged |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**Outside voice (Claude subagent):** ran. Surfaced 3 code-verified misses — the
1.5 MB `gameGate` cap (Finding A, 9/10), missing `.gitignore` + backfill (Finding
B, 9/10), and MB-scale agent-inline infeasibility (Finding C, 7/10). All folded.

**CROSS-MODEL:** section review validated the plumbing (sanitization, schema,
limits, jailed-dir mechanism); the outside voice caught that the shippable bundle
can't hold what the plumbing carries. Resolved toward reference-first, gate-safe
ship. No remaining disagreement.

**VERDICT:** ENG CLEARED — ready to implement. Critical gap (private `ref/` leak on
publish) is covered by a mandatory regression test in T2.

NO UNRESOLVED DECISIONS
