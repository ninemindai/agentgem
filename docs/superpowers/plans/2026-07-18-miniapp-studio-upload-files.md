# Miniapp Studio Upload-Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an author drop files into the Studio composer's Blank & HTML tabs to seed a miniapp — reference files inform the build (gitignored), ship files get inlined into the single-file miniapp.

**Architecture:** Files ride the existing base64-in-JSON convention on `POST /api/play/blank` and `/api/play/import`. A new `writeUploads(dir, files)` in `@agentgem/play` writes reference files to a gitignored `ref/` and ship files to a git-tracked `uploads/` (+ a committed `uploads/assets.json` manifest with inline-ready `data:` URIs). The studio coding-agent — already cwd-jailed to the miniapp dir with `permission:"allow"` — reads them; a durable `meta.uploads` counter makes the agent aware across session resume.

**Tech Stack:** TypeScript (ESM), Zod (`@agentback/openapi`), React (console), Node `node:fs`/`node:path`, Vitest.

## Global Constraints

- **Node ≥ 24**, ESM only. Import sibling modules with the `.js` extension (`./foo.js`) even from `.ts`.
- **CI-gated tests live in ROOT `src/__tests__/*.test.ts`** and import play code via the built package `@agentgem/play` (NOT relative `packages/play/...`). The root `test` script is `tsc -b && vitest run` with include glob `dist/**/__tests__/**/*.test.js` — root src compiles to root `dist/__tests__/`, but `packages/play/src/__tests__/` compiles to `packages/play/dist/` which the glob does **NOT** collect. So a play-logic test placed under `packages/play/` runs nowhere. Mirror the existing `src/__tests__/playStudio.test.ts`: import `{ blankStudio, miniappsRoot, ... } from "@agentgem/play"`; `beforeEach` sets `process.env.AGENTGEM_HOME = mkdtempSync(...)`, `afterEach` does `rmSync(home, {recursive,force})` + `delete process.env.AGENTGEM_HOME`.
- **Inner test loop** (play code is consumed as the built package, so rebuild first): `pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/<file>.test.js`. Full sweep: `pnpm test`. See [[test-setup-runs-compiled-dist]] / [[deepsec-security-scan]] (CI gates root `dist/__tests__` only). Clean stale `dist/` after renames.
- **Any new symbol a root test imports must be exported from `packages/play/src/index.ts`** (Task 1 exports `writeUploads`/`sanitizeUploadName`; `blankStudio`/`importStudio`/`studioBrief`/`miniappsRoot`/`miniappDir` already are).
- **Console tests** run on TS directly (jsdom): `pnpm -C packages/console test`. jsdom asserts behavior, not appearance.
- **The worktree needs `pnpm install`** before any build/test (controller runs it once up front).
- **Every `ex-*`/`play-*` className must have a matching CSS rule** in `packages/console/src/shell/theme.css` (grep before finishing). Reuse `--ink`/`--surface`/`--accent`/`--line`/`--raised`/`--radius` tokens; mirror `.play-drop`/`.play-src-row`.
- **The shipped miniapp is a single self-contained `index.html`** (no asset server). Ship-assets inline as `data:` URIs; the save gate (`gameGate.ts:22`) rejects any bundle > 1,500,000 bytes — hence the ship caps below.
- **Limits (enforced client + server):** reference ≤ 20 files, ≤ 5 MB/file, ≤ 15 MB total; ship ≤ 500 KB/file, ≤ 1 MB total. Import path: `html` + `files` must fit the 25 MB JSON body cap.
- **Commit messages** end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Work happens on branch `miniapp-upload-files` (worktree `../agentgem-worktrees/miniapp-upload-files`).

---

## File Structure

- `packages/play/src/uploads.ts` — **new.** `UploadFile` type, limits, `sanitizeUploadName`, `classifyBinary`, `writeUploads`. One responsibility: turn wire uploads into on-disk `uploads/` + `ref/` + manifest + `.gitignore`.
- `packages/play/src/__tests__/uploads.test.ts` — **new.** Unit tests for the above.
- `packages/play/src/studio.ts` — **modify.** Thread `files` into `blankStudio`/`importStudio`; set `meta.uploads`; `studioInstructions`/`studioBrief` name the dirs.
- `packages/play/src/miniapps.ts` — **modify.** Add `uploads?` to `MiniappMeta`.
- `packages/play/src/__tests__/studioUploads.test.ts` — **new.** Seed-with-files integration (writes dirs, meta, single commit; brief names dirs).
- `packages/play/src/index.ts` — **modify.** Re-export `writeUploads`/`UploadFile` if needed by the controller.
- `src/schemas.ts` — **modify.** `UploadFileSchema`; add optional `files` to blank/import request schemas.
- `src/play.controller.ts` — **modify.** Pass `input.body.files` through; combined-body guard on import.
- `packages/console/src/panels/Play/Composer.tsx` — **modify.** Multi-file dropzone + per-file Ship/Reference toggle on Blank & HTML; post `files`; build the uploads seedPrompt.
- `packages/console/src/shell/theme.css` — **modify.** `.play-uploads*` rules.
- `packages/console/src/api/routes.ts` — **modify.** Add optional `files` to `playBlankRoute`/`playImportRoute` bodies (client mirror of the server schema).

---

## Task 1: `writeUploads` core (play)

**Files:**
- Create: `packages/play/src/uploads.ts`
- Modify: `packages/play/src/index.ts` (export `writeUploads`/`sanitizeUploadName`/types — required so the root test can import them from `@agentgem/play`)
- Test: `src/__tests__/uploads.test.ts` (root — CI-gated; imports the built `@agentgem/play`)

**Interfaces:**
- Consumes: nothing (leaf module). Uses `node:fs`, `node:path`.
- Produces:
  - `export type UploadRole = "ship" | "reference"`
  - `export interface UploadFile { name: string; bytesBase64: string; type?: string; role: UploadRole }`
  - `export interface UploadCounts { ship: number; ref: number }`
  - `export function writeUploads(dir: string, files: UploadFile[]): UploadCounts` — writes `uploads/<name>` (ship, tracked), `ref/<name>` (reference, gitignored via a `.gitignore` written in `dir`), and `uploads/assets.json` (ship manifest). Throws `Error` on limit breach / bad base64 / unsafe name. Returns per-role counts (0/0 when `files` is empty — caller may skip).
  - `export function sanitizeUploadName(raw: string): string` — single safe basename, preserved extension; throws on empty/`.`/`..`/traversal.
  - All of the above re-exported from `packages/play/src/index.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/__tests__/uploads.test.ts   (ROOT — imports the built package)
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeUploads, sanitizeUploadName, type UploadFile } from "@agentgem/play";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const png1x1 = // a tiny real PNG
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ma-uploads-")); });

describe("sanitizeUploadName", () => {
  it("keeps a safe name with extension", () => {
    expect(sanitizeUploadName("Logo Final.PNG")).toBe("logo-final.png");
  });
  it("rejects traversal and dotfiles", () => {
    expect(() => sanitizeUploadName("../../etc/passwd")).toThrow();
    expect(() => sanitizeUploadName(".git")).toThrow();
    expect(() => sanitizeUploadName("")).toThrow();
  });
});

describe("writeUploads", () => {
  it("writes ship files to uploads/ with a committed manifest incl. data URI for binaries", () => {
    const files: UploadFile[] = [
      { name: "logo.png", bytesBase64: png1x1, type: "image/png", role: "ship" },
      { name: "data.json", bytesBase64: b64('{"a":1}'), type: "application/json", role: "ship" },
    ];
    const counts = writeUploads(dir, files);
    expect(counts).toEqual({ ship: 2, ref: 0 });
    expect(existsSync(join(dir, "uploads", "logo.png"))).toBe(true);
    expect(existsSync(join(dir, "uploads", "data.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, "uploads", "assets.json"), "utf8"));
    const logo = manifest.find((e: any) => e.file === "uploads/logo.png");
    expect(logo.dataUri).toMatch(/^data:image\/png;base64,/);
    const data = manifest.find((e: any) => e.file === "uploads/data.json");
    expect(data.dataUri).toBeUndefined(); // text is read raw, not inlined in the manifest
  });

  it("writes reference files to a gitignored ref/ and adds .gitignore", () => {
    const counts = writeUploads(dir, [
      { name: "spec.md", bytesBase64: b64("# spec"), type: "text/markdown", role: "reference" },
    ]);
    expect(counts).toEqual({ ship: 0, ref: 1 });
    expect(readFileSync(join(dir, "ref", "spec.md"), "utf8")).toBe("# spec");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/(^|\n)ref\/(\n|$)/);
    // no manifest when there are no ship files
    expect(existsSync(join(dir, "uploads", "assets.json"))).toBe(false);
  });

  it("suffixes in-batch name collisions", () => {
    writeUploads(dir, [
      { name: "a.png", bytesBase64: png1x1, type: "image/png", role: "ship" },
      { name: "a.png", bytesBase64: png1x1, type: "image/png", role: "ship" },
    ]);
    const names = readdirSync(join(dir, "uploads")).filter((n) => n.endsWith(".png")).sort();
    expect(names).toEqual(["a-2.png", "a.png"]);
  });

  it("rejects ship file over 500 KB", () => {
    const big = "A".repeat(600_000);
    expect(() => writeUploads(dir, [
      { name: "big.bin", bytesBase64: b64(big), type: "application/octet-stream", role: "ship" },
    ])).toThrow(/ship file/i);
  });

  it("rejects more than 20 files total", () => {
    const files: UploadFile[] = Array.from({ length: 21 }, (_, i) => ({
      name: `f${i}.txt`, bytesBase64: b64("x"), type: "text/plain", role: "reference",
    }));
    expect(() => writeUploads(dir, files)).toThrow(/too many/i);
  });

  it("rejects invalid base64", () => {
    expect(() => writeUploads(dir, [
      { name: "x.bin", bytesBase64: "!!!not base64!!!", type: "application/octet-stream", role: "ship" },
    ])).toThrow(/base64/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/uploads.test.js`
Expected: FAIL — `@agentgem/play` has no `writeUploads` export (build error or import undefined).

- [ ] **Step 3: Write `packages/play/src/uploads.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Author-supplied uploads for a seeded miniapp. Reference files inform the build only (gitignored ref/);
// ship files are inlined into the single-file miniapp, so they are capped small (the save gate rejects
// bundles > 1.5MB) and manifested with ready-to-use data: URIs. The studio agent is cwd-jailed to `dir`.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export type UploadRole = "ship" | "reference";
export interface UploadFile { name: string; bytesBase64: string; type?: string; role: UploadRole }
export interface UploadCounts { ship: number; ref: number }

const MAX_FILES = 20;
const SHIP_MAX_FILE = 500_000, SHIP_MAX_TOTAL = 1_000_000;
const REF_MAX_FILE = 5_000_000, REF_MAX_TOTAL = 15_000_000;

// A shipped miniapp is one self-contained HTML: binaries must inline as data: URIs, text the agent reads
// raw. SVG is text. Unknown/empty type is treated as binary (the safe default — it still gets a URI).
const TEXT_TYPES = /^(text\/|application\/json$|image\/svg\+xml$)/i;
function isBinary(type: string | undefined): boolean {
  return !type || !TEXT_TYPES.test(type);
}

// Fold to a single safe path segment, preserving one extension. Reject anything that could escape `dir`
// or target a dotfile (`.git`). Mirrors studio.ts slugify but keeps the extension.
export function sanitizeUploadName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";           // basename only — kills traversal
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  const ext = (dot > 0 ? base.slice(dot + 1) : "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!stem) throw new Error(`unsafe upload filename: '${raw}'`);
  return ext ? `${stem}.${ext}` : stem;
}

function decode(f: UploadFile): Buffer {
  // Node's base64 decoder is lenient; round-trip to detect junk so we fail loudly, not silently truncate.
  const buf = Buffer.from(f.bytesBase64, "base64");
  if (buf.toString("base64").replace(/=+$/, "") !== f.bytesBase64.replace(/\s|=+$/g, "")) {
    throw new Error(`invalid base64 for upload '${f.name}'`);
  }
  return buf;
}

interface AssetEntry { file: string; type: string; bytes: number; dataUri?: string }

export function writeUploads(dir: string, files: UploadFile[]): UploadCounts {
  if (!files.length) return { ship: 0, ref: 0 };
  if (files.length > MAX_FILES) throw new Error(`too many files: ${files.length} > ${MAX_FILES}`);

  const decoded = files.map((f) => ({ f, buf: decode(f), name: sanitizeUploadName(f.name) }));

  let shipTotal = 0, refTotal = 0;
  for (const { f, buf } of decoded) {
    if (f.role === "ship") {
      if (buf.length > SHIP_MAX_FILE) throw new Error(`ship file '${f.name}' is ${buf.length} bytes > ${SHIP_MAX_FILE}`);
      shipTotal += buf.length;
    } else {
      if (buf.length > REF_MAX_FILE) throw new Error(`reference file '${f.name}' is ${buf.length} bytes > ${REF_MAX_FILE}`);
      refTotal += buf.length;
    }
  }
  if (shipTotal > SHIP_MAX_TOTAL) throw new Error(`ship total ${shipTotal} > ${SHIP_MAX_TOTAL}`);
  if (refTotal > REF_MAX_TOTAL) throw new Error(`reference total ${refTotal} > ${REF_MAX_TOTAL}`);

  const used = new Set<string>();
  const uniq = (name: string): string => {
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 2; ; i++) { const c = `${stem}-${i}${ext}`; if (!used.has(c)) { used.add(c); return c; } }
  };

  const manifest: AssetEntry[] = [];
  let ship = 0, ref = 0;
  for (const { f, buf } of decoded) {
    const name = uniq(sanitizeUploadName(f.name));
    if (f.role === "ship") {
      mkdirSync(join(dir, "uploads"), { recursive: true });
      writeFileSync(join(dir, "uploads", name), buf);
      const type = f.type || "application/octet-stream";
      const entry: AssetEntry = { file: `uploads/${name}`, type, bytes: buf.length };
      if (isBinary(f.type)) entry.dataUri = `data:${type};base64,${buf.toString("base64")}`;
      manifest.push(entry);
      ship++;
    } else {
      mkdirSync(join(dir, "ref"), { recursive: true });
      writeFileSync(join(dir, "ref", name), buf);
      ref++;
    }
  }

  if (manifest.length) {
    writeFileSync(join(dir, "uploads", "assets.json"), JSON.stringify(manifest, null, 2));
  }
  // Per-miniapp .gitignore keeps reference material out of the registry repo (never committed/pushed).
  // Written in `dir` (freshly claimed), so it's atomic and needs no root backfill; `/*/ref/`-style root
  // rules were avoided because a miniapp legitimately named "ref" would otherwise be swallowed.
  if (ref) {
    const gi = join(dir, ".gitignore");
    const line = "ref/\n";
    const cur = existsSync(gi) ? require("node:fs").readFileSync(gi, "utf8") : "";
    if (!/(^|\n)ref\/(\n|$)/.test(cur)) writeFileSync(gi, cur + line);
  }
  return { ship, ref };
}
```

  Note: replace the `require("node:fs")` read with a top-of-file `readFileSync` import (already imported? add it):
  change the import line to `import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";` and use `readFileSync(gi, "utf8")` directly. Do not leave a `require` in ESM.

- [ ] **Step 4: Export from the package index**

In `packages/play/src/index.ts`, add near the other studio exports:

```ts
export { writeUploads, sanitizeUploadName, type UploadFile, type UploadRole, type UploadCounts } from "./uploads.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/uploads.test.js`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/uploads.ts packages/play/src/index.ts src/__tests__/uploads.test.ts
git commit -m "feat(play): writeUploads — ship→uploads/, reference→gitignored ref/, manifest

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `MiniappMeta.uploads` + seed wiring + durable brief (play)

**Files:**
- Modify: `packages/play/src/miniapps.ts:20-23` (MiniappMeta), `packages/play/src/studio.ts` (blankStudio/importStudio/studioInstructions/studioBrief)
- Test: `src/__tests__/studioUploads.test.ts` (root — imports the built `@agentgem/play`)

Note: `writeUploads` is already exported from `packages/play/src/index.ts` (Task 1 Step 4). `MiniappMeta`, `blankStudio`, `importStudio`, `studioBrief`, `miniappsRoot`, `miniappDir` are already exported.

**Interfaces:**
- Consumes: `writeUploads`, `UploadFile`, `UploadCounts` from Task 1.
- Produces:
  - `MiniappMeta` gains `uploads?: { ship: number; ref: number }`.
  - `blankStudio(title: string, prompt?: string, name?: string, files?: UploadFile[]): Promise<{ name: string; brief: string }>`
  - `importStudio(title: string, html: string, name?: string, files?: UploadFile[]): Promise<{ name: string; brief: string }>`
  - `studioBrief(name)` unchanged signature; output includes an uploads line when `meta.uploads` present.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/studioUploads.test.ts   (ROOT — imports the built package)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankStudio, studioBrief, miniappDir, miniappsRoot } from "@agentgem/play";

const b64 = (s: string) => Buffer.from(s).toString("base64");

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ma-home-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

describe("blankStudio with uploads", () => {
  it("writes ref/ + uploads/, records meta.uploads, and studioBrief names the dirs", async () => {
    const { name } = await blankStudio("My Game", "make a platformer", undefined, [
      { name: "hero.png", bytesBase64: b64("PNGDATA"), type: "image/png", role: "ship" },
      { name: "notes.md", bytesBase64: b64("# design"), type: "text/markdown", role: "reference" },
    ]);
    const dir = miniappDir(name);
    expect(existsSync(join(dir, "uploads", "hero.png"))).toBe(true);
    expect(existsSync(join(dir, "ref", "notes.md"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.uploads).toEqual({ ship: 1, ref: 1 });
    const brief = studioBrief(name);
    expect(brief).toMatch(/uploads\//);
    expect(brief).toMatch(/ref\//);
  });

  it("omits meta.uploads when no files", async () => {
    const { name } = await blankStudio("Plain", undefined, undefined, []);
    const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(meta.uploads).toBeUndefined();
    expect(studioBrief(name)).not.toMatch(/uploads\//);
  });
});
```

  Note: `miniappsRoot()` = `join(AGENTGEM_HOME, "miniapps")` (confirmed), so the temp `AGENTGEM_HOME` fully isolates the registry. This mirrors `src/__tests__/playStudio.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/studioUploads.test.js`
Expected: FAIL (blankStudio ignores the 4th arg; no `meta.uploads`).

- [ ] **Step 3: Add `uploads` to `MiniappMeta`**

In `packages/play/src/miniapps.ts`, extend the interface (line ~20):

```ts
export interface MiniappMeta {
  title: string; genre: GameGenre; createdFrom: GameSource; engineVersion: string; needs?: GameCapability[];
  mcpNeeds?: McpNeed[];   // declared-authoritative (D10) — merged with derived literals at save, never pruned
  uploads?: { ship: number; ref: number };   // author-supplied seed files: ship→uploads/, reference→gitignored ref/
}
```

- [ ] **Step 4: Thread files + brief into `studio.ts`**

In `packages/play/src/studio.ts`: import at top —

```ts
import { writeUploads, type UploadFile } from "./uploads.js";
```

Replace `studioInstructions` so it can name the upload dirs, and add a helper:

```ts
// Names the author's seed dirs so the agent uses them on every build (durable — read from meta each
// session, not the one-shot seedPrompt). Ship assets inline from uploads/assets.json; ref/ is read-only.
function uploadsBrief(uploads: { ship: number; ref: number } | undefined): string {
  if (!uploads || (!uploads.ship && !uploads.ref)) return "";
  const parts: string[] = [];
  if (uploads.ship) parts.push(`${uploads.ship} ship file(s) in ./uploads/ — inline the ones this miniapp needs into index.html (ready-to-use data: URIs are in ./uploads/assets.json)`);
  if (uploads.ref) parts.push(`${uploads.ref} reference file(s) in ./ref/ — read them for context, but do NOT ship them`);
  return `\n\nThis project has author-supplied files: ${parts.join("; ")}.`;
}
```

Update `blankStudio` (currently `studio.ts:114-126`):

```ts
export async function blankStudio(title: string, prompt?: string, name?: string, files?: UploadFile[]): Promise<{ name: string; brief: string }> {
  const source: GameSource = { kind: "blank", title };
  await ensureRepo(miniappsRoot());
  const { name: id, dir } = claimFor(source, name);
  const uploads = writeUploads(dir, files ?? []);
  writeFileSync(join(dir, MINIAPP_HTML), minimalTemplate(title, "✦ new"));
  const meta: MiniappMeta = { title, genre: "project-fun", createdFrom: source, engineVersion: "1", ...((uploads.ship || uploads.ref) ? { uploads } : {}) };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  await commitWithLock(miniappsRoot(), `create miniapp ${id}`);
  const want = prompt?.trim()
    ? `The user wants to build: ${prompt.trim()}`
    : `Ask the user what kind of mini-game they want, then build it. If they don't say, make a small, delightful arcade game.`;
  return { name: id, brief: `You are building "${title}" from scratch — a self-contained HTML mini-game with no source data. ${want}${uploadsBrief(uploads.ship || uploads.ref ? uploads : undefined)}\n\n${studioInstructions(MINIAPP_HTML)}` };
}
```

Update `importStudio` (currently `studio.ts:93-109`): add `files?: UploadFile[]` param, call `const uploads = writeUploads(dir, files ?? []);` right after `claimFor`, add `...((uploads.ship || uploads.ref) ? { uploads } : {})` to `meta`, and append `${uploadsBrief(uploads.ship || uploads.ref ? uploads : undefined)}` to the returned brief string (before the `\n\n${studioInstructions(...)}`).

Update `studioBrief` (currently `studio.ts:128-132`) to include the durable line:

```ts
export function studioBrief(name: string): string {
  const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8")) as MiniappMeta;
  return `Continue building the "${meta.title}" miniapp (a ${meta.genre}).${uploadsBrief(meta.uploads)}\n\n${studioInstructions(basename(miniappHtmlPath(name)))}`;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/studioUploads.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/miniapps.ts packages/play/src/studio.ts src/__tests__/studioUploads.test.ts
git commit -m "feat(play): seed miniapps with uploads + durable meta.uploads brief

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Gitignore regression test (play)

**Files:**
- Test: `src/__tests__/studioUploads.test.ts` (add cases — same root file as Task 2)

**Interfaces:** consumes Task 2 (`blankStudio`) + `commitWithLock`/registry git.

This task exists on its own because the failure it guards — a private `ref/` file reaching the registry remote on publish — is silent and has no error path (critical gap from the review).

- [ ] **Step 1: Write the failing regression test**

```ts
// append to src/__tests__/studioUploads.test.ts (move this import to the top with the others)
import { execFileSync } from "node:child_process";

describe("ref/ never enters git", () => {
  it("git does not track reference files", async () => {
    const { name } = await blankStudio("Secret", undefined, undefined, [
      { name: "private.md", bytesBase64: b64("top secret"), type: "text/markdown", role: "reference" },
      { name: "icon.png", bytesBase64: b64("PNG"), type: "image/png", role: "ship" },
    ]);
    const root = miniappsRoot();
    const tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
    expect(tracked).toMatch(new RegExp(`${name}/uploads/icon\\.png`));       // ship IS tracked
    expect(tracked).toMatch(new RegExp(`${name}/uploads/assets\\.json`));    // manifest IS tracked
    expect(tracked).not.toMatch(new RegExp(`${name}/ref/`));                 // reference is NOT
    // and git status shows nothing ignored-but-untracked leaking in as a candidate
    const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--ignored"], { encoding: "utf8" });
    expect(status).toMatch(new RegExp(`!!\\s+${name}/ref/`));                // explicitly ignored
  });
});
```

- [ ] **Step 2: Run to verify it passes** (Task 1 already writes the `.gitignore`, so this locks the behavior in)

Run: `pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/studioUploads.test.js -t "ref/ never enters git"`
Expected: PASS. If it FAILS, the `.gitignore` write in `writeUploads` (Task 1) is wrong — fix there, not here.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/studioUploads.test.ts
git commit -m "test(play): regression — reference uploads never git-tracked

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Request schemas + controller wiring (src)

**Files:**
- Modify: `src/schemas.ts` (~1134-1137), `src/play.controller.ts:64-78`
- Test: `src/__tests__/playUploads.test.ts` (new) — schema accept/reject + controller passthrough

**Interfaces:**
- Consumes: Task 1 `UploadFile` shape (mirrored in Zod).
- Produces: `PlayImportRequestSchema`/`PlayBlankRequestSchema` gain optional `files: UploadFileSchema[]`; controller passes `input.body.files` to `importStudio`/`blankStudio`.

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/playUploads.test.ts
import { describe, it, expect } from "vitest";
import { PlayBlankRequestSchema, PlayImportRequestSchema } from "../schemas.js";

describe("play request schemas accept optional files", () => {
  it("blank accepts files with role", () => {
    const r = PlayBlankRequestSchema.parse({
      title: "x",
      files: [{ name: "a.png", bytesBase64: "AA==", type: "image/png", role: "ship" }],
    });
    expect(r.files?.[0].role).toBe("ship");
  });
  it("blank still parses without files (backward compatible)", () => {
    expect(PlayBlankRequestSchema.parse({ title: "x" }).files).toBeUndefined();
  });
  it("rejects a bad role", () => {
    expect(() => PlayImportRequestSchema.parse({
      title: "x", html: "<html></html>",
      files: [{ name: "a", bytesBase64: "AA==", role: "nope" }],
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/playUploads.test.js`
Expected: FAIL — `.files` is stripped/undefined; bad-role case does not throw.

- [ ] **Step 3: Add the schema**

In `src/schemas.ts`, above `PlayImportRequestSchema` (~line 1132):

```ts
// Author-supplied seed files (base64-in-JSON, the existing upload convention). `role` decides where they
// land: ship→git-tracked uploads/ (inlined into the miniapp), reference→gitignored ref/ (build context).
export const UploadFileSchema = z.object({
  name: z.string().min(1),
  bytesBase64: z.string(),
  type: z.string().optional(),
  role: z.enum(["ship", "reference"]),
});
```

Then add `files` to both request schemas:

```ts
export const PlayImportRequestSchema = z.object({ title: z.string().min(1), html: z.string().min(1), name: z.string().optional(), files: z.array(UploadFileSchema).optional() });
// ...
export const PlayBlankRequestSchema = z.object({ title: z.string().min(1), prompt: z.string().optional(), name: z.string().optional(), files: z.array(UploadFileSchema).optional() });
```

- [ ] **Step 4: Pass files through the controller**

In `src/play.controller.ts`, update the two handlers (lines 64-78):

```ts
  @post("/play/import", { body: PlayImportRequestSchema, response: PlayStudioResponseSchema })
  async import(input: { body: z.infer<typeof PlayImportRequestSchema> }): Promise<z.infer<typeof PlayStudioResponseSchema>> {
    try {
      const { name } = await importStudio(input.body.title, input.body.html, input.body.name, input.body.files);
      return { name };
    } catch (e) { throw this.createError(e); }
  }

  @post("/play/blank", { body: PlayBlankRequestSchema, response: PlayStudioResponseSchema })
  async blank(input: { body: z.infer<typeof PlayBlankRequestSchema> }): Promise<z.infer<typeof PlayStudioResponseSchema>> {
    try {
      const { name } = await blankStudio(input.body.title, input.body.prompt, input.body.name, input.body.files);
      return { name };
    } catch (e) { throw this.createError(e); }
  }
```

  `createError` already maps `writeUploads` throw strings to 400 (only `miniapp already exists` → 409), so a limit/base64/name error surfaces as a clean 400. No extra handling needed.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/playUploads.test.js`
Expected: PASS.

- [ ] **Step 6: Typecheck the workspace**

Run: `pnpm -w exec tsc -b`
Expected: no errors (the new `files` param is optional, so existing callers still compile).

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/play.controller.ts src/__tests__/playUploads.test.ts
git commit -m "feat(play-api): accept optional files[] on /play/blank + /play/import

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Console route mirror + Composer UI (console)

**Files:**
- Modify: `packages/console/src/api/routes.ts` (playBlankRoute/playImportRoute bodies), `packages/console/src/panels/Play/Composer.tsx`
- Test: `packages/console/src/panels/Play/__tests__/Composer.uploads.test.tsx` (new)

**Interfaces:**
- Consumes: `playBlankRoute`/`playImportRoute` (extended bodies), the server `role` enum.
- Produces: dropzone + per-file Ship/Reference toggle on Blank & HTML; posts `files`; passes an uploads-aware seedPrompt to `onCreated`.

- [ ] **Step 1: Extend the client route bodies**

In `packages/console/src/api/routes.ts`, find `playImportRoute` (~1165) and `playBlankRoute` (~1168) and add the optional `files` array to each body. Example for import:

```ts
export const playImportRoute = defineRoute("POST", "/api/play/import", {
  body: z.object({
    title: z.string(), html: z.string(), name: z.string().optional(),
    files: z.array(z.object({ name: z.string(), bytesBase64: z.string(), type: z.string().optional(), role: z.enum(["ship", "reference"]) })).optional(),
  }),
  response: z.object({ name: z.string() }),
});
```

Apply the same `files` field to `playBlankRoute`'s body.

- [ ] **Step 2: Write the failing test**

```tsx
// packages/console/src/panels/Play/__tests__/Composer.uploads.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../Composer.js";
import * as routes from "../../../api/routes.js";

function file(name: string, type: string, body = "x") {
  return new File([body], name, { type });
}

beforeEach(() => vi.restoreAllMocks());

describe("Composer uploads", () => {
  it("Blank posts uploaded files with roles and passes an uploads seedPrompt", async () => {
    const blankSpy = vi.spyOn(routes.playBlankRoute, "call").mockResolvedValue({ name: "my-game" } as any);
    const onCreated = vi.fn();
    render(<Composer apiBase="" agents={[]} agentId="a" onAgentIdChange={() => {}} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "Blank" }));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "My Game" } });

    const input = screen.getByTestId("uploads-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file("logo.png", "image/png"), file("spec.md", "text/markdown")] } });
    await screen.findByText(/logo\.png/);

    // default role is Ship; flip spec.md to Reference
    fireEvent.change(screen.getByTestId("role-spec.md"), { target: { value: "reference" } });
    fireEvent.click(screen.getByRole("button", { name: /Create miniapp/ }));

    await waitFor(() => expect(blankSpy).toHaveBeenCalled());
    const body = blankSpy.mock.calls[0][1].body;
    expect(body.files).toHaveLength(2);
    expect(body.files.find((f: any) => f.name === "logo.png").role).toBe("ship");
    expect(body.files.find((f: any) => f.name === "spec.md").role).toBe("reference");
    expect(onCreated).toHaveBeenCalledWith("my-game", expect.stringMatching(/uploads/i));
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Composer.uploads.test.tsx`
Expected: FAIL — no `uploads-input` testid; body has no `files`.

- [ ] **Step 4: Implement the dropzone + toggle in `Composer.tsx`**

Add state near the other `useState`s (after line ~73):

```tsx
type Upload = { name: string; bytesBase64: string; type: string; size: number; role: "ship" | "reference" };
const [uploads, setUploads] = useState<Upload[]>([]);
const SHIP_MAX_FILE = 500_000, SHIP_MAX_TOTAL = 1_000_000, REF_MAX_FILE = 5_000_000, REF_MAX_TOTAL = 15_000_000, MAX_FILES = 20;
```

Add file-reading + role helpers (near `loadFile`, ~line 108):

```tsx
function fileToBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error(`could not read ${f.name}`));
    r.onload = () => res(String(r.result).replace(/^data:[^;]*;base64,/, ""));
    r.readAsDataURL(f);
  });
}
async function addUploads(list: FileList | null | undefined) {
  if (!list?.length) return;
  const next: Upload[] = [...uploads];
  for (const f of Array.from(list)) {
    if (next.length >= MAX_FILES) { setError(`at most ${MAX_FILES} files`); break; }
    next.push({ name: f.name, bytesBase64: await fileToBase64(f), type: f.type, size: f.size, role: "ship" });
  }
  setUploads(next);
}
function setRole(name: string, role: "ship" | "reference") {
  setUploads((u) => u.map((x) => (x.name === name ? { ...x, role } : x)));
}
function removeUpload(name: string) { setUploads((u) => u.filter((x) => x.name !== name)); }
// Client-side mirror of the server caps → friendly error before a doomed round-trip.
function uploadsError(u: Upload[]): string {
  const ship = u.filter((x) => x.role === "ship"), ref = u.filter((x) => x.role === "reference");
  if (ship.some((x) => x.size > SHIP_MAX_FILE)) return "a ship file exceeds 500 KB (it must inline into the miniapp)";
  if (ship.reduce((n, x) => n + x.size, 0) > SHIP_MAX_TOTAL) return "ship files exceed 1 MB total";
  if (ref.some((x) => x.size > REF_MAX_FILE)) return "a reference file exceeds 5 MB";
  if (ref.reduce((n, x) => n + x.size, 0) > REF_MAX_TOTAL) return "reference files exceed 15 MB total";
  return "";
}
function uploadsPreamble(u: Upload[]): string {
  if (!u.length) return "";
  const ship = u.filter((x) => x.role === "ship").map((x) => x.name);
  const ref = u.filter((x) => x.role === "reference").map((x) => x.name);
  const lines: string[] = [];
  if (ship.length) lines.push(`Ship files (inline into index.html): ${ship.join(", ")} — data: URIs are in ./uploads/assets.json.`);
  if (ref.length) lines.push(`Reference files (context only, do not ship): ${ref.join(", ")} in ./ref/.`);
  return `I've added files to this project's workspace.\n${lines.join("\n")}`;
}
const uploadsPayload = () => (uploads.length ? { files: uploads.map(({ name, bytesBase64, type, role }) => ({ name, bytesBase64, type, role })) } : {});
```

Extend `doBlank` and `doImport` to include uploads. For `doBlank` (line ~125):

```tsx
async function doBlank() {
  if (busy || !blankTitle.trim()) return;
  const ue = uploadsError(uploads); if (ue) { setError(ue); return; }
  setBusy(true); setError("");
  try {
    const res = await playBlankRoute.call(makeClient(apiBase), { body: { title: blankTitle.trim(), ...named(), ...uploadsPayload() } });
    onCreated(res.name, [capPreamble(caps), uploadsPreamble(uploads), blankPrompt.trim()].filter(Boolean).join("\n\n") || undefined);
  } catch (e) { setError((e as Error).message); setBusy(false); }
}
```

For `doImport` (line ~116) add the same `const ue = uploadsError(uploads); if (ue) { setError(ue); return; }` guard, `...uploadsPayload()` in the body, and change `onCreated(res.name)` to:

```tsx
    onCreated(res.name, uploadsPreamble(uploads) || undefined);
```

Add a reusable dropzone block (place it inside both the `kind === "html"` and `kind === "blank"` bodies, above the Create button). Extract a small render helper inside the component:

```tsx
const uploadsBlock = (
  <div className="play-uploads">
    <label className="play-drop" onDragOver={(e) => { e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); addUploads(e.dataTransfer.files); }}>
      <b>Drop files</b> to seed this miniapp (optional) — or click to choose
      <input data-testid="uploads-input" type="file" multiple onChange={(e) => addUploads(e.target.files)} style={{ display: "none" }} />
    </label>
    {uploads.length > 0 && (
      <ul className="play-uploads__list">
        {uploads.map((u) => (
          <li key={u.name} className="play-uploads__row">
            <span className="play-uploads__name">{u.name}</span>
            <span className="play-uploads__size">{(u.size / 1024).toFixed(0)} KB</span>
            <select data-testid={`role-${u.name}`} className="play-uploads__role" value={u.role} onChange={(e) => setRole(u.name, e.target.value as "ship" | "reference")}>
              <option value="ship">Ship</option>
              <option value="reference">Reference</option>
            </select>
            <button type="button" className="play-uploads__x" aria-label={`remove ${u.name}`} onClick={() => removeUpload(u.name)}>×</button>
          </li>
        ))}
      </ul>
    )}
  </div>
);
```

Render `{uploadsBlock}` in the Blank tab body (before its Create button, ~line 227) and in the HTML tab body (before its Create button, ~line 216).

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Composer.uploads.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Play/Composer.tsx packages/console/src/panels/Play/__tests__/Composer.uploads.test.tsx
git commit -m "feat(console): Composer file-upload dropzone + Ship/Reference toggle (Blank + HTML)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Styles for the uploads list (console)

**Files:**
- Modify: `packages/console/src/shell/theme.css`

**Interfaces:** none (pure CSS). Every class used in Task 5's `uploadsBlock` must have a rule here.

- [ ] **Step 1: Add the rules** (place near `.play-drop`, ~line 788)

```css
.play-uploads { display: flex; flex-direction: column; gap: 8px; }
.play-uploads__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.play-uploads__row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--line);
  border-radius: var(--radius); background: var(--raised); }
.play-uploads__name { flex: 1; min-width: 0; font: 500 12.5px var(--font-mono); color: var(--ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.play-uploads__size { font: 500 11px var(--font-mono); color: var(--muted); flex-shrink: 0; }
.play-uploads__role { flex-shrink: 0; font: 500 11.5px var(--font-ui); color: var(--ink);
  background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
.play-uploads__x { flex-shrink: 0; border: none; background: none; cursor: pointer; color: var(--muted);
  font-size: 16px; line-height: 1; padding: 0 2px; }
.play-uploads__x:hover { color: var(--ink); }
```

- [ ] **Step 2: Verify every class is CSS-enforced**

Run:
```bash
for c in play-uploads play-uploads__list play-uploads__row play-uploads__name play-uploads__size play-uploads__role play-uploads__x; do
  echo -n "$c: "; grep -c "\.$c" packages/console/src/shell/theme.css;
done
```
Expected: every count ≥ 1.

- [ ] **Step 3: Verify appearance in a real browser** (jsdom can't check appearance — project UI rule). Launch the console (see [[root-build-tsc-not-pnpm-r]] for the full build), open Studio → New miniapp → Blank, drop two files, confirm the chip rows, the Ship/Reference dropdown, and the × button render against the design tokens (not raw browser defaults).

- [ ] **Step 4: Commit**

```bash
git add packages/console/src/shell/theme.css
git commit -m "style(console): .play-uploads chip list + role toggle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full build + test sweep, then follow-up TODOs

**Files:** none (verification) + `docs/superpowers/plans/2026-07-18-miniapp-studio-upload-files.md` (record TODOs)

- [ ] **Step 1: Full typecheck + build**

Run: `pnpm build` (i.e. `tsc -b && node scripts/build-console.mjs`) — [[root-build-tsc-not-pnpm-r]].
Expected: no TS errors; console bundle rebuilt.

- [ ] **Step 2: Root test suite (compiled dist)**

Run: `pnpm test`
Expected: PASS, including `uploads.test.ts`, `studioUploads.test.ts`, `playUploads.test.ts`.

- [ ] **Step 3: Console tests**

Run: `pnpm -C packages/console test`
Expected: PASS, including `Composer.uploads.test.tsx`.

- [ ] **Step 4: Record deferred TODOs** (do NOT implement — captured for the backlog):
  - **T7 — GC consumed ship originals:** after the agent inlines a ship asset into `index.html`, the raw `uploads/<file>` remains (versioned original). A GC pass could drop it once inlined. Deferred: it's the durable original; lifecycle is separate.
  - **T8 — raise `gameGate` maxBytes for large ship assets:** would let images/audio/video ship at scale, but marketplace/PWA/offline then serve multi-MB HTML. Needs its own review (`gameGate.ts:22`, `saveMiniapp` at `miniapps.ts:115`).

- [ ] **Step 5: Open the PR** (per CLAUDE.md PR lifecycle — one settled scope, CI gate `test (24)`):

```bash
git push -u origin miniapp-upload-files
gh pr create --title "feat: seed miniapps with uploaded files (Blank & HTML)" --body "$(cat <<'BODY'
Adds a file-upload dropzone to the Studio composer's Blank & HTML tabs. Reference files (gitignored ref/) inform the build; ship files (uploads/ + assets.json) inline into the single-file miniapp. Durable meta.uploads brief; per-file Ship/Reference toggle. See docs/superpowers/specs/2026-07-18-miniapp-studio-upload-files-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

Then watch CI and merge once green: `gh run watch <run-id> --exit-status` → `gh pr merge --rebase --delete-branch`. Verify each commit's content on `origin/main` after merge (dropped-commit trap).

---

## Self-Review

**Spec coverage:**
- Per-file Ship/Reference toggle → Task 5. ✓
- ref/ gitignored, uploads/ tracked → Task 1 (+ regression Task 3). ✓
- Committed ship manifest, data URIs ship-only → Task 1. ✓
- Durable meta.uploads + studioBrief → Task 2. ✓
- Role-specific limits + gate-safe ship caps → Task 1 (server) + Task 5 (client). ✓
- Schemas + controller + combined-body cap → Task 4 (import body cap is the existing 25 MB express limit; per-file/total enforced in `writeUploads`). ✓
- CSS-enforced classes → Task 6. ✓
- Follow-up TODOs (GC, gate) → Task 7. ✓

**Placeholder scan:** no TBD/TODO in implementation steps; every code step shows full code. The `require("node:fs")` in Task 1 Step 3 is explicitly called out to replace with an ESM import.

**Type consistency:** `UploadFile { name, bytesBase64, type?, role }` is identical across `uploads.ts` (Task 1), the Zod `UploadFileSchema` (Task 4), the client route body (Task 5), and the `Upload` UI type (Task 5 adds `size`, drops it before posting via `uploadsPayload`). `MiniappMeta.uploads` shape `{ ship, ref }` matches `UploadCounts` and the `meta.uploads` written in Task 2 / read in `studioBrief`.
