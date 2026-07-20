# Mid-session file upload in the Studio authoring window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user attach files to a miniapp from the Studio authoring window (beside the ACP prompt), writing them into the live workspace and telling the running agent about them.

**Architecture:** A new `POST /api/play/uploads` targets an existing miniapp: `addUploadsToMiniapp(name, files)` writes into the workspace via a now merge-aware, atomic `writeUploads` that returns the actual stored filenames, recomputes the durable `meta.uploads` from disk, and does **not** commit (the per-turn checkpoint / next Save persists it). `saveMiniapp` is fixed to preserve the server-owned `uploads` counter. The client extracts a shared `useUploads` hook + `UploadsField` component (compact mode for Studio), and Studio's Send posts uploads then sends the agent a preamble built from the **server-returned** names.

**Tech Stack:** TypeScript (ESM), Zod + @agentback route decorators, React (console SPA), vitest. `@agentgem/play` is consumed by the root app and console as a **built** package.

## Global Constraints

- **Node >= 24.** ESM only (`.js` import specifiers in TS source).
- **`@agentgem/play` is consumed built.** After changing anything under `packages/play/src`, rebuild before running root tests: `pnpm -w exec tsc -b`.
- **Root test location:** tests that exercise `@agentgem/play` live in root `src/__tests__/*.test.ts` and import the **built** `@agentgem/play`; root vitest only collects `dist/__tests__/**/*.test.js`. Inner loop: `pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/<file>.test.js`.
- **Console tests** run separately (jsdom, not CI-gated): `pnpm -C packages/console test`.
- **Upload byte caps (unchanged):** ship ≤500KB/file, ≤1MB total (cumulative); ref ≤5MB/file, ≤15MB total (cumulative); ≤20 files/batch.
- **UI rule:** every `ex-*`/`play-*` className added in a `.tsx` needs a matching rule in `packages/console/src/shell/theme.css` in the same change.
- **`uploads` is server-owned:** only `writeUploads`/`addUploadsToMiniapp` set it; the client never sends it. It must never appear in the public gem (`writeGameGem`).

---

## File Structure

**Server (`@agentgem/play` + root app) — Lane A**
- `packages/play/src/uploads.ts` — `writeUploads` becomes merge-aware + atomic + returns stored records + cumulative totals. New exported types `StoredUpload`, `UploadResult`.
- `packages/play/src/studio.ts` — new `addUploadsToMiniapp`; `writeUploadsOrRelease` strips to `{ship,ref}`.
- `packages/play/src/index.ts` — export `addUploadsToMiniapp`, `StoredUpload`, `UploadResult`.
- `packages/play/src/miniapps.ts` — `saveMiniapp` preserves `uploads` from disk; strips it from the gem.
- `src/schemas.ts` — `PlayUploadsRequestSchema`, `PlayUploadsResponseSchema`.
- `src/play.controller.ts` — `@post("/play/uploads")`.
- `packages/console/src/api/routes.ts` — `playUploadsRoute` + `uploadsPreambleFromStored`.

**Client (console) — Lane B**
- `packages/console/src/panels/Play/uploads.ts` — `useUploads` hook, constants, `Upload` type, `uploadsPreamble`/`uploadsPreambleFromStored`.
- `packages/console/src/panels/Play/UploadsField.tsx` — dropzone + chip list, `compact` mode.
- `packages/console/src/panels/Play/Composer.tsx` — consume the shared hook/component.
- `packages/console/src/panels/Play/Studio.tsx` — attach control + Send wiring.
- `packages/console/src/shell/theme.css` — `.play-uploads--compact`, `.play-attach`.

**Lanes:** Task 1→2→3→4 (Lane A, sequential). Task 5 (Lane B) is independent of Lane A and can run in parallel. Task 6 depends on Tasks 4 (client route) and 5 (shared component).

---

## Task 1: `writeUploads` — merge-aware, atomic, returns stored records

**Files:**
- Modify: `packages/play/src/uploads.ts`
- Modify: `packages/play/src/studio.ts:87-90` (`writeUploadsOrRelease` strip)
- Modify: `packages/play/src/index.ts:14` (export new types)
- Test: `src/__tests__/uploads.test.ts`

**Interfaces:**
- Produces:
  - `interface StoredUpload { requested: string; stored: string; role: UploadRole }`
  - `interface UploadResult { files: StoredUpload[]; ship: number; ref: number }` — `ship`/`ref` are **cumulative on-disk** file counts.
  - `writeUploads(dir: string, files: UploadFile[]): UploadResult`

- [ ] **Step 1: Update the 4 existing exact-match count assertions**

In `src/__tests__/uploads.test.ts`, the return is no longer exactly `{ship,ref}` (it now also carries `files`). Change the four `toEqual` assertions to `toMatchObject` (lines ~32, 46, 97, 110):

```ts
// was: expect(counts).toEqual({ ship: 2, ref: 0 });
expect(counts).toMatchObject({ ship: 2, ref: 0 });
// ...and the ref:1, {ship:1,ref:0}, {ship:1,ref:1} cases likewise → toMatchObject
```

- [ ] **Step 2: Write the failing tests (merge, atomicity, stored records)**

Append to `src/__tests__/uploads.test.ts`:

```ts
describe("writeUploads merge + atomicity + records", () => {
  it("a second call accumulates the manifest and suffixes an on-disk name clash", () => {
    writeUploads(dir, [{ name: "logo.png", bytesBase64: png1x1, type: "image/png", role: "ship" }]);
    const r = writeUploads(dir, [{ name: "logo.png", bytesBase64: png1x1, type: "image/png", role: "ship" }]);
    // both files survive on disk
    expect(existsSync(join(dir, "uploads", "logo.png"))).toBe(true);
    expect(existsSync(join(dir, "uploads", "logo-2.png"))).toBe(true);
    // manifest keeps both (not clobbered)
    const manifest = JSON.parse(readFileSync(join(dir, "uploads", "assets.json"), "utf8"));
    expect(manifest.map((e: any) => e.file).sort()).toEqual(["uploads/logo-2.png", "uploads/logo.png"]);
    // cumulative ship count = 2; this call's record has the suffixed stored name
    expect(r.ship).toBe(2);
    expect(r.files).toEqual([{ requested: "logo.png", stored: "logo-2.png", role: "ship" }]);
  });

  it("returns stored records with the sanitized name for the requested name", () => {
    const r = writeUploads(dir, [{ name: "My Logo.PNG", bytesBase64: png1x1, type: "image/png", role: "ship" }]);
    expect(r.files).toEqual([{ requested: "My Logo.PNG", stored: "my-logo.png", role: "ship" }]);
  });

  it("rejects a bad filename atomically — earlier files are NOT written", () => {
    expect(() => writeUploads(dir, [
      { name: "good.png", bytesBase64: png1x1, type: "image/png", role: "ship" },
      { name: "../evil", bytesBase64: b64("x"), type: "text/plain", role: "ship" },
    ])).toThrow(/unsafe upload filename/i);
    expect(existsSync(join(dir, "uploads", "good.png"))).toBe(false); // nothing written
    expect(existsSync(join(dir, "uploads"))).toBe(false);
  });

  it("cumulative ship-total cap rejects a second batch that alone would fit", () => {
    const big = Buffer.alloc(600_000, 1).toString("base64"); // 600KB ship
    writeUploads(dir, [{ name: "a.bin", bytesBase64: big, type: "application/octet-stream", role: "ship" }]);
    expect(() => writeUploads(dir, [{ name: "b.bin", bytesBase64: big, type: "application/octet-stream", role: "ship" }]))
      .toThrow(/ship total/i); // 600K + 600K > 1_000_000
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/uploads.test.js
```
Expected: FAIL (`r.files` undefined; partial-write test fails because `good.png` IS written today; cumulative-cap test fails because today's cap is per-call).

- [ ] **Step 4: Rewrite `writeUploads` in `packages/play/src/uploads.ts`**

Add the types near the top (after the existing `UploadCounts` interface):

```ts
export interface StoredUpload { requested: string; stored: string; role: UploadRole }
export interface UploadResult { files: StoredUpload[]; ship: number; ref: number }
```

Replace the whole `export function writeUploads(...)` body with the merge-aware, atomic version (returns `UploadResult`):

```ts
export function writeUploads(dir: string, files: UploadFile[]): UploadResult {
  // Preload existing workspace state so repeat batches accumulate instead of clobbering.
  const usedShip = new Set<string>(), usedRef = new Set<string>();
  const manifest: AssetEntry[] = [];
  let shipTotal = 0, refTotal = 0;
  const uploadsDir = join(dir, "uploads"), refDir = join(dir, "ref");
  if (existsSync(uploadsDir)) for (const f of readdirSync(uploadsDir)) if (f !== "assets.json") usedShip.add(f);
  if (existsSync(refDir)) for (const f of readdirSync(refDir)) { usedRef.add(f); refTotal += statSync(join(refDir, f)).size; }
  const assetsPath = join(uploadsDir, "assets.json");
  if (existsSync(assetsPath)) {
    const prev = JSON.parse(readFileSync(assetsPath, "utf8")) as AssetEntry[];
    for (const e of prev) { manifest.push(e); shipTotal += e.bytes; }
  }

  const cumulativeCounts = (): { ship: number; ref: number } => ({ ship: usedShip.size, ref: usedRef.size });
  if (!files.length) return { files: [], ...cumulativeCounts() };
  if (files.length > MAX_FILES) throw new Error(`too many files: ${files.length} > ${MAX_FILES}`);

  const uniq = (name: string, used: Set<string>): string => {
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 2; ; i++) { const c = `${stem}-${i}${ext}`; if (!used.has(c)) { used.add(c); return c; } }
  };

  // Pass A — decode + validate + PLAN stored names. No writes: any throw here leaves the dir untouched.
  const planned = files.map((f) => {
    const buf = decode(f);
    if (f.role === "ship") {
      if (buf.length > SHIP_MAX_FILE) throw new Error(`ship file '${f.name}' is ${buf.length} bytes > ${SHIP_MAX_FILE}`);
      shipTotal += buf.length;
    } else {
      if (buf.length > REF_MAX_FILE) throw new Error(`reference file '${f.name}' is ${buf.length} bytes > ${REF_MAX_FILE}`);
      refTotal += buf.length;
    }
    const stored = uniq(sanitizeUploadName(f.name), f.role === "ship" ? usedShip : usedRef); // sanitize can throw → still no writes
    return { f, buf, stored };
  });
  if (shipTotal > SHIP_MAX_TOTAL) throw new Error(`ship total ${shipTotal} > ${SHIP_MAX_TOTAL}`);
  if (refTotal > REF_MAX_TOTAL) throw new Error(`reference total ${refTotal} > ${REF_MAX_TOTAL}`);

  // Pass B — write. All names are pre-planned, so this only does I/O.
  const records: StoredUpload[] = [];
  for (const { f, buf, stored } of planned) {
    if (f.role === "ship") {
      mkdirSync(uploadsDir, { recursive: true });
      writeFileSync(join(uploadsDir, stored), buf);
      const type = safeMime(f.type);
      const entry: AssetEntry = { file: `uploads/${stored}`, type, bytes: buf.length };
      if (isBinary(f.type)) entry.dataUri = `data:${type};base64,${buf.toString("base64")}`;
      manifest.push(entry);
    } else {
      mkdirSync(refDir, { recursive: true });
      writeFileSync(join(refDir, stored), buf);
    }
    records.push({ requested: f.name, stored, role: f.role });
  }

  if (manifest.length) writeFileSync(assetsPath, JSON.stringify(manifest, null, 2));
  if (records.some((r) => r.role === "reference")) {
    const gi = join(dir, ".gitignore");
    const line = "ref/\n";
    const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
    if (!/(^|\n)ref\/(\n|$)/.test(cur)) writeFileSync(gi, cur && !cur.endsWith("\n") ? cur + "\n" + line : cur + line);
  }
  return { files: records, ...cumulativeCounts() };
}
```

Add `readdirSync, statSync` to the `node:fs` import at the top of the file:

```ts
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
```

- [ ] **Step 5: Strip the widened return in `writeUploadsOrRelease` (`studio.ts:87`)**

`blankStudio`/`importStudio` assign the result straight into `meta.uploads`, so it must stay `{ship,ref}` only — otherwise `files` leaks into `meta.json`. Change:

```ts
function writeUploadsOrRelease(dir: string, files: UploadFile[] | undefined): { ship: number; ref: number } {
  try { const r = writeUploads(dir, files ?? []); return { ship: r.ship, ref: r.ref }; }
  catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}
```

- [ ] **Step 6: Export the new types (`index.ts:14`)**

```ts
export { writeUploads, sanitizeUploadName, type UploadFile, type UploadRole, type UploadCounts, type StoredUpload, type UploadResult } from "./uploads.js";
```

- [ ] **Step 7: Run all play upload tests to verify green**

```bash
pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/uploads.test.js dist/__tests__/studioUploads.test.js
```
Expected: PASS (merge/atomicity/records green; `studioUploads` `meta.uploads` still `{ship:1,ref:1}` on a fresh dir).

- [ ] **Step 8: Commit**

```bash
git add packages/play/src/uploads.ts packages/play/src/studio.ts packages/play/src/index.ts src/__tests__/uploads.test.ts
git commit -m "feat(play): writeUploads merge-aware + atomic + returns stored records"
```

---

## Task 2: `saveMiniapp` preserves the server-owned `uploads` counter

**Files:**
- Modify: `packages/play/src/miniapps.ts` (around the meta write at line ~168 and the gem write at ~171)
- Test: `src/__tests__/saveUploads.test.ts` (create)

**Interfaces:**
- Consumes: `writeUploads`/`blankStudio` from Task 1 (to seed a miniapp with uploads in the test).
- Produces: no signature change; `saveMiniapp` now carries `meta.uploads` from disk when the client omits it, and never writes `uploads` into the gem.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/saveUploads.test.ts`:

```ts
// src/__tests__/saveUploads.test.ts   (ROOT — imports the built package)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankStudio, saveMiniapp, miniappDir } from "@agentgem/play";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const HTML = "<!doctype html><html><head></head><body>hi</body></html>";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ma-home-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

describe("saveMiniapp preserves the server-owned uploads counter", () => {
  it("keeps meta.uploads across a Save whose client meta omits it", async () => {
    const { name } = await blankStudio("My Game", undefined, undefined, [
      { name: "hero.png", bytesBase64: b64("PNGDATA"), type: "image/png", role: "ship" },
    ]);
    const before = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(before.uploads).toEqual({ ship: 1, ref: 0 });

    // Client Save payload never carries `uploads` (mirrors Studio.tsx:335-341).
    await saveMiniapp({ name, html: HTML, meta: { title: "My Game", genre: "project-fun", engineVersion: "1" } as any });

    const after = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(after.uploads).toEqual({ ship: 1, ref: 0 }); // NOT wiped
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/saveUploads.test.js
```
Expected: FAIL — `after.uploads` is `undefined` (Save wiped it).

- [ ] **Step 3: Implement the preserve + gem-strip in `saveMiniapp`**

In `packages/play/src/miniapps.ts`, immediately **before** the `writeFileSync(join(dir, "meta.json"), ...)` line (~168), add:

```ts
    // `uploads` is a server-owned authoring counter; the client never sends it, so carry it forward
    // from disk instead of letting a Save wipe it (which silences studioBrief's upload announcement).
    const metaPath = join(dir, "meta.json");
    if (meta.uploads === undefined && existsSync(metaPath)) {
      try { const prev = JSON.parse(readFileSync(metaPath, "utf8")) as MiniappMeta; if (prev.uploads) meta.uploads = prev.uploads; }
      catch { /* no readable prior meta — nothing to preserve */ }
    }
```

Then change the gem write (~171) to drop `uploads` so the private counter never reaches public distribution (clone + `delete` avoids a `noUnusedLocals` error from destructure-discard):

```ts
    const gemMeta = { ...meta }; delete gemMeta.uploads; // uploads is private authoring state — keep it out of the gem
    writeGameGem(safe, html, gemMeta);
```

(`existsSync` and `readFileSync` are already imported in this file.)

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/saveUploads.test.js
```
Expected: PASS.

- [ ] **Step 5: Mutation-verify + full play suite**

Temporarily delete the `if (meta.uploads === undefined ...)` block, rebuild, run the test → it must FAIL. Restore it. Then:

```bash
pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/miniapps.ts src/__tests__/saveUploads.test.ts
git commit -m "fix(play): saveMiniapp preserves server-owned meta.uploads (keep out of gem)"
```

---

## Task 3: `addUploadsToMiniapp` — add files to an existing miniapp (no commit)

**Files:**
- Modify: `packages/play/src/studio.ts` (add the function; add `existsSync` import)
- Modify: `packages/play/src/index.ts:13` (export `addUploadsToMiniapp`)
- Test: `src/__tests__/addUploads.test.ts` (create)

**Interfaces:**
- Consumes: `writeUploads` / `UploadResult` (Task 1), `miniappDir`, `MiniappMeta`.
- Produces: `addUploadsToMiniapp(name: string, files: UploadFile[]): Promise<UploadResult>`.

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/addUploads.test.ts`:

```ts
// src/__tests__/addUploads.test.ts   (ROOT — imports the built package)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankStudio, addUploadsToMiniapp, miniappDir, miniappsRoot, studioBrief } from "@agentgem/play";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const headCount = () => execFileSync("git", ["-C", miniappsRoot(), "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ma-home-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

describe("addUploadsToMiniapp", () => {
  it("writes files, recomputes meta.uploads, returns stored names, and does NOT commit", async () => {
    const { name } = await blankStudio("My Game", undefined, undefined, [
      { name: "a.png", bytesBase64: b64("A"), type: "image/png", role: "ship" },
    ]);
    const commitsBefore = headCount();

    const res = await addUploadsToMiniapp(name, [
      { name: "My Logo.png", bytesBase64: b64("B"), type: "image/png", role: "ship" },
      { name: "notes.md", bytesBase64: b64("# n"), type: "text/markdown", role: "reference" },
    ]);

    const dir = miniappDir(name);
    expect(existsSync(join(dir, "uploads", "my-logo.png"))).toBe(true);
    expect(existsSync(join(dir, "ref", "notes.md"))).toBe(true);
    expect(res.files).toContainEqual({ requested: "My Logo.png", stored: "my-logo.png", role: "ship" });
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.uploads).toEqual({ ship: 2, ref: 1 }); // cumulative (a.png + my-logo.png ship; notes.md ref)
    expect(studioBrief(name)).toMatch(/uploads\//);
    expect(headCount()).toBe(commitsBefore); // no new commit
  });

  it("throws 'miniapp not found' for an unknown name", async () => {
    await expect(addUploadsToMiniapp("does-not-exist", [
      { name: "a.png", bytesBase64: b64("A"), type: "image/png", role: "ship" },
    ])).rejects.toThrow(/miniapp not found/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/addUploads.test.js
```
Expected: FAIL (`addUploadsToMiniapp` not exported).

- [ ] **Step 3: Implement `addUploadsToMiniapp` in `studio.ts`**

Add `existsSync` to the `node:fs` import at the top of `packages/play/src/studio.ts`:

```ts
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
```

Append the function (after `blankStudio`, before `studioBrief`):

```ts
// Add author files to an ALREADY-created miniapp, mid-session. Writes into the workspace the studio agent
// is cwd-jailed to and recomputes the durable meta.uploads from disk. Does NOT commit: the agent reads
// from the working tree, studioBrief reads meta.json from disk, and the next per-turn checkpoint / Save
// commits the files — committing here would `git add -A` the agent's in-progress edits into an upload commit.
export async function addUploadsToMiniapp(name: string, files: UploadFile[]): Promise<UploadResult> {
  const dir = miniappDir(name);                    // validates + jails the name (bad name → throws)
  if (!existsSync(dir)) throw new Error(`miniapp not found: '${name}'`); // readMiniapp would throw a bare ENOENT
  const result = writeUploads(dir, files);         // merge-aware, atomic; result.ship/ref are cumulative
  if (result.files.length) {
    const metaPath = join(dir, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as MiniappMeta;
    meta.uploads = (result.ship || result.ref) ? { ship: result.ship, ref: result.ref } : undefined;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  return result;
}
```

Update the `uploads.js` import in `studio.ts` (line ~17) to bring in the type:

```ts
import { writeUploads, type UploadFile, type UploadResult } from "./uploads.js";
```

- [ ] **Step 4: Export it (`index.ts:13`)**

```ts
export { studioCwd, studioBrief, seedStudio, importStudio, blankStudio, slugify, addUploadsToMiniapp } from "./studio.js";
```

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/addUploads.test.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/studio.ts packages/play/src/index.ts src/__tests__/addUploads.test.ts
git commit -m "feat(play): addUploadsToMiniapp — add files to an existing miniapp, no commit"
```

---

## Task 4: Route + schema wiring (`/api/play/uploads`)

**Files:**
- Modify: `src/schemas.ts` (near `UploadFileSchema`)
- Modify: `src/play.controller.ts` (import + `@post`)
- Modify: `packages/console/src/api/routes.ts` (`playUploadsRoute` + `uploadsPreambleFromStored`)
- Test: `src/__tests__/playUploads.test.ts` (extend)

**Interfaces:**
- Consumes: `addUploadsToMiniapp` (Task 3), `UploadFileSchema` (existing).
- Produces:
  - `PlayUploadsRequestSchema` = `{ name: string, files: UploadFileSchema[] }`
  - `PlayUploadsResponseSchema` = `{ files: { requested, stored, role }[], ship: number, ref: number }`
  - client `playUploadsRoute` (POST `/api/play/uploads`)
  - `uploadsPreambleFromStored(files): string`

- [ ] **Step 1: Write the failing schema tests**

Append to `src/__tests__/playUploads.test.ts`:

```ts
import { PlayUploadsRequestSchema, PlayUploadsResponseSchema } from "../schemas.js";

describe("play uploads route schemas", () => {
  it("request accepts name + files with roles", () => {
    const r = PlayUploadsRequestSchema.parse({
      name: "my-game",
      files: [{ name: "a.png", bytesBase64: "AA==", type: "image/png", role: "ship" }],
    });
    expect(r.files[0].role).toBe("ship");
  });
  it("request rejects a missing name", () => {
    expect(() => PlayUploadsRequestSchema.parse({ files: [] })).toThrow();
  });
  it("response carries stored records", () => {
    const r = PlayUploadsResponseSchema.parse({
      files: [{ requested: "My Logo.png", stored: "my-logo.png", role: "ship" }], ship: 1, ref: 0,
    });
    expect(r.files[0].stored).toBe("my-logo.png");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/playUploads.test.js
```
Expected: FAIL (schemas not exported).

- [ ] **Step 3: Add the schemas (`src/schemas.ts`)**

Immediately after the existing `UploadFileSchema` definition, add:

```ts
export const PlayUploadsRequestSchema = z.object({
  name: z.string(),
  files: z.array(UploadFileSchema),
});
const StoredUploadSchema = z.object({
  requested: z.string(),
  stored: z.string(),
  role: z.enum(["ship", "reference"]),
});
export const PlayUploadsResponseSchema = z.object({
  files: z.array(StoredUploadSchema),
  ship: z.number(),
  ref: z.number(),
});
// Compile-time drift guard: the response file shape must match @agentgem/play's StoredUpload.
type _AssertEq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _storedGuard: _AssertEq<z.infer<typeof StoredUploadSchema>, import("@agentgem/play").StoredUpload> = true;
void _storedGuard;
```

- [ ] **Step 4: Add the controller route (`src/play.controller.ts`)**

Add `addUploadsToMiniapp` to the `@agentgem/play` import (line ~7) and the schemas to the `./schemas.js` import (line ~15-22). Then add the method after `blank` (~line 78):

```ts
  @post("/play/uploads", { body: PlayUploadsRequestSchema, response: PlayUploadsResponseSchema })
  async uploads(input: { body: z.infer<typeof PlayUploadsRequestSchema> }): Promise<z.infer<typeof PlayUploadsResponseSchema>> {
    try {
      return await addUploadsToMiniapp(input.body.name, input.body.files);
    } catch (e) {
      const msg = (e as Error).message;
      throw new AgentError(msg, { status: msg.startsWith("miniapp not found") ? 404 : 400 });
    }
  }
```

- [ ] **Step 5: Add the client route + preamble helper (`packages/console/src/api/routes.ts`)**

After `playBlankRoute`, add:

```ts
export const playUploadsRoute = defineRoute("POST", "/api/play/uploads", {
  body: z.object({ name: z.string(), files: z.array(playUploadFileSchema) }),
  response: z.object({
    files: z.array(z.object({ requested: z.string(), stored: z.string(), role: z.enum(["ship", "reference"]) })),
    ship: z.number(), ref: z.number(),
  }),
});

// Build the agent preamble from the SERVER's actual stored filenames (the server sanitizes/suffixes,
// so raw staged names would name files that don't exist on disk). Mirrors uploadsPreamble in uploads.ts.
export function uploadsPreambleFromStored(
  files: { requested: string; stored: string; role: "ship" | "reference" }[],
): string {
  if (!files.length) return "";
  const ship = files.filter((f) => f.role === "ship").map((f) => f.stored);
  const ref = files.filter((f) => f.role === "reference").map((f) => f.stored);
  const lines: string[] = [];
  if (ship.length) lines.push(`Ship files (inline into index.html): ${ship.join(", ")} — data: URIs are in ./uploads/assets.json.`);
  if (ref.length) lines.push(`Reference files (context only, do not ship): ${ref.join(", ")} in ./ref/.`);
  return `I've added files to this project's workspace.\n${lines.join("\n")}`;
}
```

- [ ] **Step 6: Run to verify schema tests pass + typecheck**

```bash
pnpm -w exec tsc -b && pnpm -w exec vitest run dist/__tests__/playUploads.test.js
pnpm -C packages/console exec tsc -p tsconfig.json --noEmit
```
Expected: PASS; console typecheck clean (route compiles).

- [ ] **Step 7: Commit**

```bash
git add src/schemas.ts src/play.controller.ts packages/console/src/api/routes.ts src/__tests__/playUploads.test.ts
git commit -m "feat(play): POST /api/play/uploads route + schemas + client route"
```

---

## Task 5: Extract shared `useUploads` hook + `UploadsField` (compact mode); refactor Composer

**Files:**
- Create: `packages/console/src/panels/Play/uploads.ts`
- Create: `packages/console/src/panels/Play/UploadsField.tsx`
- Modify: `packages/console/src/panels/Play/Composer.tsx` (consume the shared units)
- Modify: `packages/console/src/shell/theme.css` (compact classes)
- Test: `packages/console/src/panels/Play/__tests__/Composer.uploads.test.tsx` (must still pass unchanged)

**Interfaces:**
- Produces:
  - `type Upload = { name: string; bytesBase64: string; type: string; size: number; role: "ship" | "reference" }`
  - `useUploads(): { uploads: Upload[]; addUploads(list): Promise<void>; setRole(name, role): void; remove(name): void; error: string; limitError(): string; payload(): { files: Upload[] } | Record<string, never>; preamble(): string; reset(): void }`
  - `UploadsField({ u, compact }: { u: ReturnType<typeof useUploads>; compact?: boolean })`

- [ ] **Step 1: Create the hook `packages/console/src/panels/Play/uploads.ts`**

Lift the upload logic verbatim from `Composer.tsx` into a hook:

```ts
import { useState } from "react";

export type Upload = { name: string; bytesBase64: string; type: string; size: number; role: "ship" | "reference" };

export const SHIP_MAX_FILE = 500_000, SHIP_MAX_TOTAL = 1_000_000, REF_MAX_FILE = 5_000_000, REF_MAX_TOTAL = 15_000_000, MAX_FILES = 20;

function fileToBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error(`could not read ${f.name}`));
    r.onload = () => res(String(r.result).replace(/^data:[^;]*;base64,/, ""));
    r.readAsDataURL(f);
  });
}

export function uploadsError(u: Upload[]): string {
  const ship = u.filter((x) => x.role === "ship"), ref = u.filter((x) => x.role === "reference");
  if (ship.some((x) => x.size > SHIP_MAX_FILE)) return "a ship file exceeds 500 KB (it must inline into the miniapp)";
  if (ship.reduce((n, x) => n + x.size, 0) > SHIP_MAX_TOTAL) return "ship files exceed 1 MB total";
  if (ref.some((x) => x.size > REF_MAX_FILE)) return "a reference file exceeds 5 MB";
  if (ref.reduce((n, x) => n + x.size, 0) > REF_MAX_TOTAL) return "reference files exceed 15 MB total";
  return "";
}

// Preamble for the CREATE path (raw staged names). The mid-session path uses uploadsPreambleFromStored
// (routes.ts) with the server's actual stored names instead.
export function uploadsPreamble(u: Upload[]): string {
  if (!u.length) return "";
  const ship = u.filter((x) => x.role === "ship").map((x) => x.name);
  const ref = u.filter((x) => x.role === "reference").map((x) => x.name);
  const lines: string[] = [];
  if (ship.length) lines.push(`Ship files (inline into index.html): ${ship.join(", ")} — data: URIs are in ./uploads/assets.json.`);
  if (ref.length) lines.push(`Reference files (context only, do not ship): ${ref.join(", ")} in ./ref/.`);
  return `I've added files to this project's workspace.\n${lines.join("\n")}`;
}

export function useUploads() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState("");

  async function addUploads(list: FileList | null | undefined) {
    if (!list?.length) return;
    const seen = new Set(uploads.map((u) => u.name));
    const additions: Upload[] = [];
    for (const f of Array.from(list)) {
      if (seen.has(f.name)) { setError(`duplicate filename skipped: ${f.name}`); continue; }
      if (uploads.length + additions.length >= MAX_FILES) { setError(`at most ${MAX_FILES} files`); break; }
      seen.add(f.name);
      additions.push({ name: f.name, bytesBase64: await fileToBase64(f), type: f.type, size: f.size, role: "ship" });
    }
    if (!additions.length) return;
    setUploads((prev) => {
      const prevNames = new Set(prev.map((u) => u.name));
      const merged = [...prev];
      for (const a of additions) if (!prevNames.has(a.name)) { prevNames.add(a.name); merged.push(a); }
      return merged;
    });
  }
  const setRole = (name: string, role: "ship" | "reference") => setUploads((u) => u.map((x) => (x.name === name ? { ...x, role } : x)));
  const remove = (name: string) => setUploads((u) => u.filter((x) => x.name !== name));
  const payload = () => (uploads.length ? { files: uploads.map(({ name, bytesBase64, type, role }) => ({ name, bytesBase64, type, role })) } : {});
  const reset = () => { setUploads([]); setError(""); };

  return { uploads, addUploads, setRole, remove, error, setError, limitError: () => uploadsError(uploads), payload, preamble: () => uploadsPreamble(uploads), reset };
}
```

- [ ] **Step 2: Create `UploadsField.tsx` (preserves the existing testids)**

```tsx
import type { useUploads } from "./uploads.js";

export function UploadsField({ u, compact }: { u: ReturnType<typeof useUploads>; compact?: boolean }) {
  return (
    <div className={compact ? "play-uploads play-uploads--compact" : "play-uploads"}>
      <label
        className={compact ? "play-btn play-attach" : "play-drop"}
        onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); u.addUploads(e.dataTransfer.files); }}
      >
        {compact ? "📎 Attach files" : <><b>Drop files</b> to seed this miniapp (optional) — or click to choose</>}
        <input data-testid="uploads-input" type="file" multiple onChange={(e) => u.addUploads(e.target.files)} style={{ display: "none" }} />
      </label>
      {u.uploads.length > 0 && (
        <ul className="play-uploads__list">
          {u.uploads.map((f) => (
            <li key={f.name} className="play-uploads__row">
              <span className="play-uploads__name">{f.name}</span>
              <span className="play-uploads__size">{(f.size / 1024).toFixed(0)} KB</span>
              <select data-testid={`role-${f.name}`} className="play-uploads__role" value={f.role} onChange={(e) => u.setRole(f.name, e.target.value as "ship" | "reference")}>
                <option value="ship">Ship</option>
                <option value="reference">Reference</option>
              </select>
              <button type="button" className="play-uploads__x" aria-label={`remove ${f.name}`} onClick={() => u.remove(f.name)}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Refactor `Composer.tsx` to consume the shared units**

Remove from `Composer.tsx`: the `Upload` type + limit consts (lines ~86-88), `fileToBase64` (122-129), `addUploads` (130-150), `setUploadRole`/`removeUpload` (151-154), `uploadsError` (156-163), `uploadsPreamble` (164-172), `uploadsPayload` (173), the `uploads`/`setUploads` state (87), and the `uploadsBlock` JSX (199-221). Then:

Add the import:
```ts
import { useUploads } from "./uploads.js";
import { UploadsField } from "./UploadsField.js";
```

Replace the removed state with the hook (near the other `useState`s):
```ts
  const up = useUploads();
```

Rewrite the call sites:
- `doImport`: `const ue = up.limitError(); if (ue) { setError(ue); return; }` … body `...up.payload()` … `const preamble = up.preamble();`
- `doBlank`: `const ue = up.limitError(); if (ue) { setError(ue); return; }` … body `...up.payload()` … seedPrompt uses `up.preamble()`: `[capPreamble(caps), up.preamble(), blankPrompt.trim()].filter(Boolean).join("\n\n") || undefined`
- Surface the hook's add-time message: after the existing error banner, also show `up.error` (or fold: `{(error || up.error) && <div className="play-banner">…{error || up.error}…</div>}`).
- Replace `{uploadsBlock}` in the HTML and Blank tabs with `<UploadsField u={up} />`.

- [ ] **Step 4: Add the compact CSS (`packages/console/src/shell/theme.css`)**

```css
.play-uploads--compact { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.play-attach { cursor: pointer; white-space: nowrap; }
```

- [ ] **Step 5: Run the Composer test (must pass unchanged) + typecheck**

```bash
pnpm -C packages/console test -- Composer.uploads
pnpm -C packages/console exec tsc -p tsconfig.json --noEmit
```
Expected: PASS (the extracted `UploadsField` keeps `data-testid="uploads-input"` and `role-<name>`, so the existing assertions still hold).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Play/uploads.ts packages/console/src/panels/Play/UploadsField.tsx packages/console/src/panels/Play/Composer.tsx packages/console/src/shell/theme.css
git commit -m "refactor(console): extract useUploads + UploadsField (compact mode) from Composer"
```

---

## Task 6: Wire attach + Send into the Studio composer bar

**Files:**
- Modify: `packages/console/src/panels/Play/Studio.tsx` (`play-composer-in` block ~722; imports; `submit`)
- Test: `packages/console/src/panels/Play/__tests__/Studio.uploads.test.tsx` (create)

**Interfaces:**
- Consumes: `useUploads` + `UploadsField` (Task 5), `playUploadsRoute` + `uploadsPreambleFromStored` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `packages/console/src/panels/Play/__tests__/Studio.uploads.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Studio } from "../Studio.js";
import * as routes from "../../../api/routes.js";

function file(name: string, type: string, body = "x") { return new File([body], name, { type }); }

beforeEach(() => vi.restoreAllMocks());
afterEach(() => cleanup());

describe("Studio mid-session uploads", () => {
  it("attaching a file + Send posts /play/uploads then sends a preamble with the SERVER stored name", async () => {
    // Minimal miniapp load so the composer renders with an agent ready.
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue({ html: "<html></html>", meta: { title: "g", genre: "project-fun" } } as any);
    const uploadSpy = vi.spyOn(routes.playUploadsRoute, "call").mockResolvedValue({
      files: [{ requested: "My Logo.png", stored: "my-logo.png", role: "ship" }], ship: 1, ref: 0,
    } as any);
    const sent: string[] = [];

    render(<Studio name="g" apiBase="" agentId="a" onExit={() => {}} sendOverrideForTest={(t: string) => sent.push(t)} />);
    // (Studio exposes a test seam for the ACP send; if none exists, assert via the mocked chat store instead.)

    const input = await screen.findByTestId("uploads-input");
    fireEvent.change(input, { target: { files: [file("My Logo.png", "image/png")] } });
    await screen.findByTestId("role-My Logo.png");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(uploadSpy).toHaveBeenCalled());
    expect(uploadSpy.mock.calls[0][1].body).toMatchObject({ name: "g", files: [{ name: "My Logo.png", role: "ship" }] });
    await waitFor(() => expect(sent.join("\n")).toMatch(/my-logo\.png/)); // server stored name, not "My Logo.png"
    expect(screen.queryByTestId("role-My Logo.png")).toBeNull(); // chips cleared on upload success
  });
});
```

> Note: match the real `Studio` prop names when you open the file. If `Studio` has no test seam for the ACP send, assert the sent text through the chat-store mock the other Studio tests use (`studioChatStore`) instead of a `sendOverrideForTest` prop, and drop that prop from the render.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm -C packages/console test -- Studio.uploads
```
Expected: FAIL (no attach control / upload wiring).

- [ ] **Step 3: Wire the imports + hook in `Studio.tsx`**

Add to the routes import (line ~4):
```ts
import { makeClient, playMiniappRoute, playSaveRoute, playUploadsRoute, uploadsPreambleFromStored, publishSetupRoute, publishStatusRoute, reviewGroupsRoute, reviewRequestRoute } from "../../api/routes.js";
```
Add:
```ts
import { useUploads } from "./uploads.js";
import { UploadsField } from "./UploadsField.js";
```
Near the other hooks in the component body:
```ts
  const up = useUploads();
```

- [ ] **Step 4: Rework `submit()` (the guarded Enter/Send handler ~line 325)**

Replace the body of `submit()` with (keep the existing busy/agent guards, add the staged-files branch):

```ts
  async function submit() {
    const staged = up.uploads;
    if (busy || !agentId || (!input.trim() && !staged.length)) return;
    if (staged.length) {
      const ue = up.limitError();
      if (ue) { setLoadErr(ue); return; } // surface via the existing error path
      let res;
      try {
        res = await playUploadsRoute.call(makeClient(apiBase), { body: { name, files: up.payload().files ?? [] } });
      } catch (e) { setLoadErr((e as Error).message); return; } // keep chips; no send
      up.reset(); // uploaded — files are durably in the workspace; a later send failure must not re-upload
      const pre = uploadsPreambleFromStored(res.files);
      const text = [pre, input.trim()].filter(Boolean).join("\n\n");
      setInput("");
      send(text);
      return;
    }
    setInput("");
    send(input.trim());
  }
```

(If `send` currently receives `input` directly and clears it itself, adjust so it takes the composed `text`. Match the existing `send` signature you see in the file.)

- [ ] **Step 5: Render the compact attach control in `play-composer-in`**

In the `play-composer-in` block (~722), add `<UploadsField u={up} compact />` above the textarea, and update the Send button's disabled guard:

```tsx
      <div className="play-composer-in" ref={composerRef}>
        <UploadsField u={up} compact />
        <textarea ref={inputRef} className="play-input play-input--chat" rows={3}
          placeholder="ask the agent to build/edit the miniapp…" value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        <div className="play-composer-foot">
          <span className="play-composer-hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</span>
          <button className="play-btn play-btn--primary" disabled={busy || !agentId || (!input.trim() && up.uploads.length === 0)} onClick={submit}>{busy ? "…" : "Send"}</button>
        </div>
      </div>
```

- [ ] **Step 6: Run to verify it passes + typecheck + full console suite**

```bash
pnpm -C packages/console test -- Studio.uploads
pnpm -C packages/console exec tsc -p tsconfig.json --noEmit
pnpm -C packages/console test
```
Expected: PASS; no typecheck errors; whole console suite green.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/__tests__/Studio.uploads.test.tsx
git commit -m "feat(console): attach files beside the Studio prompt; post uploads then announce with stored names"
```

---

## Task 7: Full build + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Full root build + test**

```bash
pnpm build
pnpm test
```
Expected: build clean; all root tests (including the new `uploads`/`saveUploads`/`addUploads`/`playUploads` cases) green.

- [ ] **Step 2: Manual browser verification (per the `verify` skill)**

```bash
AGENTGEM_HOME=$(mktemp -d) PORT=<unused> node dist/index.js
```
- Open `#/play`, create a Blank miniapp, enter Studio.
- Attach a small image via the composer's 📎, leave it Ship, type "use this as the logo", Send.
- Confirm: the network shows `POST /api/play/uploads`; the chat message names the **stored** filename; chips clear; the agent can read `uploads/assets.json`.
- Attach a `.md` as Reference with no prompt, Send → the agent gets a preamble-only turn; `ref/<file>` exists and is gitignored.
- Save, reload Studio → the agent's brief still announces the uploaded files (durability).

- [ ] **Step 3: Commit any verification-driven fixes, then open the PR** (per repo integration rules: branch is off `origin/main`; push and open a PR gated by `test (24)`).

---

## Self-Review notes

- **Spec coverage:** §1 addUploads→T3; §1a saveMiniapp→T2; §2 writeUploads merge/atomicity/records→T1; §3 shared UI→T5; §4 Studio wiring→T6; §5 route/schemas/export→T3(index)+T4; failure modes + no-commit + stored names → tested in T1/T3/T6.
- **Type consistency:** `UploadResult`/`StoredUpload` defined in T1 (uploads.ts), exported in T1/T3 (index.ts), mirrored in T4 (schemas + client route) with a compile-time drift guard. `useUploads`/`UploadsField` signatures shared across T5/T6.
- **Residual (non-blocking, appendix):** concurrent writes from two tabs can race the manifest read-modify-write (`writeUploads` is not lock-protected). Single-UI `busy` guard mitigates; out of scope per review. If it ever bites, wrap `addUploadsToMiniapp` writes in the per-dir commit chain.
