# Installable PWAs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local console and the `app.agentgem.ai` marketplace installable as standalone PWAs in Chromium browsers (manifest + icons only; no service worker/offline).

**Architecture:** Two independent PRs sharing one gem-mark icon artwork. The console (esbuild single-file) inlines icons as `data:` URIs in a served `manifest.webmanifest`; the marketplace (Vite SPA on Cloudflare Static Assets) drops icon PNGs + manifest into `public/`.

**Tech Stack:** esbuild, Node/Express (agentback RestApplication), Vite, Cloudflare Workers, vitest + supertest, browser-harness (one-time icon rasterization).

## Global Constraints

- **Scope: installable only.** No service worker, no offline, no push/share-target. (from spec)
- **Manifest fields (both apps):** `id:"/"`, `start_url:"/"`, `scope:"/"`, `display:"standalone"`, `background_color:"#f1eadb"`, `theme_color:"#f1eadb"`. Console `name:"AgentGem Console"`; marketplace `name:"AgentGem"`. Both `short_name:"AgentGem"`.
- **Icons:** 192 (any), 512 (any), 512 maskable. Terracotta gem `#9a3324` on warm-paper `#f1eadb`.
- **Console manifest route is local-only** — mounted inside the existing `if (process.env.SERVE_CONSOLE !== "false")` block so the API-only hosted deploy never serves it.
- **No new build or runtime dependency.** Icons are generated once and committed (base64 for console, PNG files for marketplace).
- **Root tests run from compiled `dist/`** (`pnpm test` = `tsc -b && vitest run`, glob `dist/**/__tests__/**/*.test.js`). Console-package and marketplace-package tests are NOT in root CI; run them with `pnpm --filter <pkg> test`.
- **Two worktrees:** console work is on `feat/pwa-console` (worktree `../agentgem-worktrees/pwa-console`, already created). Marketplace work gets its own worktree off fresh `origin/main` (Task 6).

---

## File Structure

**PR #1 — Console (`feat/pwa-console`):**
- Create `packages/console/pwa-icons.mjs` — exports `ICON_192`, `ICON_512`, `ICON_512_MASKABLE` (PNG `data:` URI strings).
- Create `packages/console/pwa-manifest.mjs` — exports `buildManifest()` returning the console manifest object (consumes `pwa-icons.mjs`).
- Modify `packages/console/build-client.mjs` — emit `dist/manifest.webmanifest`; add `<link rel="manifest">`, `<meta name="theme-color">`, `<link rel="apple-touch-icon">` to the HTML shell.
- Modify `scripts/build-console.mjs` — copy `manifest.webmanifest` into `dist/public/console/`.
- Modify `scripts/__tests__/build-console.test.mjs` — assert the manifest is copied.
- Modify `packages/console/src/__tests__/build.test.ts` — assert the manifest `<link>` is in the HTML.
- Modify `src/index.ts` — extract `consoleFile(name)` reader; add local-only `GET /manifest.webmanifest`.
- Create `src/__tests__/consoleManifest.test.ts` — route behavior test.

**PR #2 — Marketplace (own worktree):**
- Create `packages/marketplace/public/manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`.
- Modify `packages/marketplace/index.html` — manifest/apple-touch-icon/theme-color tags.
- Modify `packages/marketplace/src/worker.test.ts` — assert `/manifest.webmanifest` passes through to ASSETS unmodified.

---

## Task 1: Generate the gem-mark icon PNGs (shared, one-time)

Produces the three PNGs both PRs consume. Runs on the `feat/pwa-console` worktree; output PNGs are stashed in the scratchpad and reused by Tasks 3 and 7.

**Files:**
- Output (scratchpad, not committed): `<scratchpad>/icon-192.png`, `icon-512.png`, `icon-512-maskable.png`

**Interfaces:**
- Produces: three PNG files at the scratchpad paths above (raster of the SVG below).

- [ ] **Step 1: Define the icon SVG template**

The gem art lives in a 24×24 space; we place it on a 100×100 paper field, scaled/centered. `INSET_SCALE` controls how much of the frame the gem fills (large for "any", smaller for maskable safe-zone).

```js
// s = scale of the 24-unit gem art; centered on a 100x100 paper field.
function iconSvg(s) {
  const off = (100 - 24 * s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#f1eadb"/>
  <g transform="translate(${off} ${off}) scale(${s})" fill="none">
    <path d="M6 3h12l4 6-10 12L2 9l4-6Z" fill="#9a3324"/>
    <path d="M2 9h20M9 3 7 9l5 12M15 3l2 6-5 12" stroke="#f1eadb" stroke-width="0.7" stroke-linejoin="round" opacity="0.85"/>
    <path d="M6 3h12l4 6-10 12L2 9l4-6Z" stroke="#6f2117" stroke-width="0.5"/>
  </g>
</svg>`;
}
// "any" icons fill ~68% of the frame; maskable insets to ~52% (inside the 80% safe circle).
const SVG_ANY = iconSvg(2.83);
const SVG_MASKABLE = iconSvg(2.17);
```

- [ ] **Step 2: Rasterize each SVG to PNG via the browser harness**

Rasterize with canvas (`drawImage` of an SVG data-URL `Image`) at the exact pixel size, then write the PNG bytes to the scratchpad. Run this once:

```bash
browser-harness <<'PY'
import base64, os
new_tab("about:blank")
wait_for_load()
scratch = os.environ.get("SCRATCH", "/tmp")

def render(svg, size):
    b64 = base64.b64encode(svg.encode()).decode()
    dataurl = "data:image/svg+xml;base64," + b64
    out = js(f"""
      (async () => {{
        const img = new Image();
        img.width = {size}; img.height = {size};
        await new Promise((ok, err) => {{ img.onload = ok; img.onerror = err; img.src = "{dataurl}"; }});
        const c = document.createElement('canvas'); c.width = {size}; c.height = {size};
        c.getContext('2d').drawImage(img, 0, 0, {size}, {size});
        return c.toDataURL('image/png').split(',')[1];
      }})()
    """)
    return base64.b64decode(out)

SVG_ANY = '''<PASTE SVG_ANY from Step 1>'''
SVG_MASKABLE = '''<PASTE SVG_MASKABLE from Step 1>'''
open(f"{scratch}/icon-192.png","wb").write(render(SVG_ANY, 192))
open(f"{scratch}/icon-512.png","wb").write(render(SVG_ANY, 512))
open(f"{scratch}/icon-512-maskable.png","wb").write(render(SVG_MASKABLE, 512))
print("wrote 3 icons to", scratch)
PY
```

(Set `SCRATCH` to the session scratchpad dir before running.)

- [ ] **Step 3: Eyeball the icons**

Open the three PNGs (Read tool renders images). Expected: a crisp terracotta gem with hairline facets on warm paper; the maskable one has visibly more padding. If the gem looks clipped or off-center, adjust the scale in Step 1 and re-run. No commit — these are scratchpad artifacts consumed by Tasks 3 and 7.

---

## Task 2: Console manifest builder module

**Files:**
- Create: `packages/console/pwa-icons.mjs`
- Create: `packages/console/pwa-manifest.mjs`
- Test: `packages/console/pwa-manifest.test.mjs` (plain `node --test`)

**Interfaces:**
- Consumes: nothing yet (icon strings are placeholders until Task 3 fills real base64).
- Produces: `buildManifest()` → the console manifest object; `ICON_192`/`ICON_512`/`ICON_512_MASKABLE` data-URI strings.

- [ ] **Step 1: Write the failing test**

```js
// packages/console/pwa-manifest.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "./pwa-manifest.mjs";

test("manifest has standalone display, both name fields, and 3 icons incl. maskable", () => {
  const m = buildManifest();
  assert.equal(m.display, "standalone");
  assert.equal(m.name, "AgentGem Console");
  assert.equal(m.short_name, "AgentGem");
  assert.equal(m.start_url, "/");
  assert.equal(m.theme_color, "#f1eadb");
  const sizes = m.icons.map(i => `${i.sizes}/${i.purpose ?? "any"}`);
  assert.ok(sizes.includes("192x192/any"));
  assert.ok(sizes.includes("512x512/any"));
  assert.ok(sizes.includes("512x512/maskable"));
  assert.ok(m.icons.every(i => i.src.startsWith("data:image/png;base64,")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test packages/console/pwa-manifest.test.mjs`
Expected: FAIL — `Cannot find module './pwa-manifest.mjs'`.

- [ ] **Step 3: Create the icon module with placeholder data URIs**

Real base64 is pasted in Task 3; a 1×1 transparent PNG keeps the module valid until then.

```js
// packages/console/pwa-icons.mjs
// Gem-mark app icons, base64 PNG data URIs. Generated once from the boot-splash
// gem silhouette (see docs/superpowers/plans/2026-07-11-installable-pwa.md, Task 1);
// inlined here so the console's single served manifest.webmanifest stays self-contained
// (no separate icon routes). Placeholder 1x1 PNGs until Task 3 pastes the real renders.
const PLACEHOLDER = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
export const ICON_192 = PLACEHOLDER;
export const ICON_512 = PLACEHOLDER;
export const ICON_512_MASKABLE = PLACEHOLDER;
```

- [ ] **Step 4: Create the manifest builder**

```js
// packages/console/pwa-manifest.mjs
// Web app manifest for the local console PWA. Icons are inlined data URIs so the
// server hands out the whole manifest as one file (mirrors the single-index.html
// design). theme/background = warm paper (#f1eadb) for a seamless standalone window.
import { ICON_192, ICON_512, ICON_512_MASKABLE } from "./pwa-icons.mjs";

export function buildManifest() {
  return {
    id: "/",
    name: "AgentGem Console",
    short_name: "AgentGem",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f1eadb",
    theme_color: "#f1eadb",
    icons: [
      { src: ICON_192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: ICON_512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: ICON_512_MASKABLE, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test packages/console/pwa-manifest.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/console/pwa-icons.mjs packages/console/pwa-manifest.mjs packages/console/pwa-manifest.test.mjs
git commit -m "feat(console): PWA manifest builder + placeholder gem icons"
```

---

## Task 3: Paste the real gem-mark icon base64

**Files:**
- Modify: `packages/console/pwa-icons.mjs`

**Interfaces:**
- Consumes: the three PNGs from Task 1.
- Produces: real icon data URIs (same export names as Task 2).

- [ ] **Step 1: Encode the PNGs to data URIs**

```bash
for f in icon-192 icon-512 icon-512-maskable; do
  printf 'data:image/png;base64,'; base64 -i "$SCRATCH/$f.png" | tr -d '\n'; echo
done
```

- [ ] **Step 2: Replace the placeholders in `pwa-icons.mjs`**

Set `ICON_192`, `ICON_512`, `ICON_512_MASKABLE` to the three strings from Step 1 (drop the `PLACEHOLDER` const).

- [ ] **Step 3: Re-run the manifest test**

Run: `node --test packages/console/pwa-manifest.test.mjs`
Expected: PASS (icons still start with `data:image/png;base64,`, now non-trivial length).

- [ ] **Step 4: Commit**

```bash
git add packages/console/pwa-icons.mjs
git commit -m "feat(console): real gem-mark PWA icons (192/512/512-maskable)"
```

---

## Task 4: Emit the manifest from the console build + link it in the HTML

**Files:**
- Modify: `packages/console/build-client.mjs`
- Modify: `packages/console/src/__tests__/build.test.ts`

**Interfaces:**
- Consumes: `buildManifest()` (Task 2), `ICON_192` (Task 2/3).
- Produces: `dist/manifest.webmanifest` and a `<link rel="manifest">` in `dist/index.html`.

- [ ] **Step 1: Extend the build.test.ts assertion (failing)**

Add to the existing `it(...)` body in `packages/console/src/__tests__/build.test.ts`:

```ts
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<meta name="theme-color" content="#f1eadb">');
    // and the manifest file itself is emitted
    const mani = JSON.parse(readFileSync(join(pkg, "dist", "manifest.webmanifest"), "utf8"));
    expect(mani.display).toBe("standalone");
    expect(mani.icons.length).toBe(3);
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @agentgem/console test:build`
Expected: FAIL — HTML lacks the manifest link / `dist/manifest.webmanifest` missing.

- [ ] **Step 3: Emit the manifest + inject the head tags in `build-client.mjs`**

Add the import at the top (after existing imports):

```js
import { buildManifest } from "./pwa-manifest.mjs";
import { ICON_192 } from "./pwa-icons.mjs";
```

Add these three `<link>`/`<meta>` lines inside the `<head>`, right after the existing `<link rel="icon" href="data:," />` line:

```js
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#f1eadb" />
<link rel="apple-touch-icon" href="${ICON_192}" />
```

After the existing `writeFileSync(join(out, "index.html"), html);`, add:

```js
writeFileSync(join(out, "manifest.webmanifest"), JSON.stringify(buildManifest()));
console.log(`[console] wrote ${join(out, "manifest.webmanifest")}`);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @agentgem/console test:build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/build-client.mjs packages/console/src/__tests__/build.test.ts
git commit -m "feat(console): emit manifest.webmanifest and link it from the SPA shell"
```

---

## Task 5: Copy the manifest into the packaged dist + serve it (local-only)

**Files:**
- Modify: `scripts/build-console.mjs`
- Modify: `scripts/__tests__/build-console.test.mjs`
- Modify: `src/index.ts` (`consoleHtml` region ~90-100; console-serve block ~325-334)
- Create: `src/__tests__/consoleManifest.test.ts`

**Interfaces:**
- Consumes: `dist/manifest.webmanifest` (Task 4).
- Produces: `dist/public/console/manifest.webmanifest`; `GET /manifest.webmanifest` route.

- [ ] **Step 1: Add the packaging assertion (failing)**

In `scripts/__tests__/build-console.test.mjs`, after the existing `assert.ok(... "index.html" ...)`:

```js
assert.ok(existsSync(join(root, "dist", "public", "console", "manifest.webmanifest")),
  "dist/public/console/manifest.webmanifest must exist after pnpm build");
```

- [ ] **Step 2: Copy the manifest in `build-console.mjs`**

After the existing `copyFileSync(... "index.html" ...)`:

```js
copyFileSync(join(pkg, "dist", "manifest.webmanifest"), join(dest, "manifest.webmanifest"));
```

- [ ] **Step 3: Write the failing route test**

```ts
// src/__tests__/consoleManifest.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../index.js";

describe("PWA manifest route", () => {
  it("serves /manifest.webmanifest as an installable manifest", async () => {
    const app = await createApp(0);
    const server = await app.restServer;
    const res = await request(server.expressApp).get("/manifest.webmanifest").set("Host", "127.0.0.1");
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/manifest\+json/);
    expect(res.body.display).toBe("standalone");
    expect(res.body.icons.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm build && pnpm --filter @agentgem/... ` — simplest: `pnpm test -- consoleManifest`
Expected: FAIL — 404 (route not mounted).
(Note: `pnpm test` runs `tsc -b` first so the new `.ts` compiles into `dist/__tests__/`.)

- [ ] **Step 5: Extract a shared reader + mount the route in `src/index.ts`**

Replace the `consoleHtml()` function (currently ~92-100) with a generic reader plus a thin html wrapper:

```ts
// Read a built console asset (index.html, manifest.webmanifest). dist path first,
// then the dev fallback to the console package's own dist. Returns null if absent.
function consoleFile(name: string): string | null {
  for (const p of [
    join(here, "public", "console", name),
    join(here, "..", "packages", "console", "dist", name),
  ]) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  return null;
}
function consoleHtml(): string {
  return consoleFile("index.html")
    ?? '<!doctype html><div id="root"></div><p>console not built — run pnpm build</p>';
}
```

In the `if (process.env.SERVE_CONSOLE !== "false")` block (~328), after the `/console` route, add:

```ts
    // The PWA manifest, so Chromium offers "Install app". Local-only (same guard as
    // the console itself); skipped if the build hasn't produced it yet.
    const manifest = consoleFile("manifest.webmanifest");
    if (manifest) {
      server.expressApp.get("/manifest.webmanifest", (_req, res) =>
        res.type("application/manifest+json").send(manifest));
    }
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm test -- consoleManifest`
Expected: PASS.

- [ ] **Step 7: Run the packaging test + full suite**

Run: `node scripts/__tests__/build-console.test.mjs` then `pnpm test`
Expected: both PASS (no regressions in `consoleMount`/`build`).

- [ ] **Step 8: Commit**

```bash
git add scripts/build-console.mjs scripts/__tests__/build-console.test.mjs src/index.ts src/__tests__/consoleManifest.test.ts
git commit -m "feat(console): serve /manifest.webmanifest (local-only) + copy into packaged dist"
```

- [ ] **Step 9: Manual install verification**

Run `pnpm build && node dist/index.js`, open `http://127.0.0.1:<port>/` in Chrome. DevTools ▸ Application ▸ Manifest: no errors, 3 icons render. The omnibox shows an install control; install → the console opens in a standalone window with the gem icon. Screenshot for the PR.

- [ ] **Step 10: Open PR #1**

Push `feat/pwa-console`; open a PR titled "feat(console): installable PWA". Body: what + the install screenshot. Watch CI (`test (24)`) green, then merge per the repo's PR lifecycle rules. Verify each commit landed on `origin/main`.

---

## Task 6: Marketplace worktree

**Files:** none (worktree setup).

- [ ] **Step 1: Create the worktree off fresh origin/main**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem
git fetch origin
git worktree add ../agentgem-worktrees/pwa-marketplace -b feat/pwa-marketplace origin/main
```

All remaining tasks run in `../agentgem-worktrees/pwa-marketplace`.

---

## Task 7: Marketplace manifest + icons + head tags

**Files:**
- Create: `packages/marketplace/public/manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`
- Modify: `packages/marketplace/index.html`

**Interfaces:**
- Consumes: the three PNGs from Task 1 (scratchpad).
- Produces: static manifest + icons served by Vite/Cloudflare; head links.

- [ ] **Step 1: Drop the icons into `public/`**

```bash
mkdir -p packages/marketplace/public
cp "$SCRATCH/icon-192.png" "$SCRATCH/icon-512.png" "$SCRATCH/icon-512-maskable.png" packages/marketplace/public/
```

- [ ] **Step 2: Write the manifest file**

```json
// packages/marketplace/public/manifest.webmanifest
{
  "id": "/",
  "name": "AgentGem",
  "short_name": "AgentGem",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#f1eadb",
  "theme_color": "#f1eadb",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

(Strip the `// path` comment — `.webmanifest` must be valid JSON.)

- [ ] **Step 3: Add the head tags in `index.html`**

Insert into `<head>`, after the existing `<meta name="viewport" ...>` line:

```html
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f1eadb" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#20190f" />
```

- [ ] **Step 4: Verify the build copies them**

Run: `pnpm --filter @agentgem/marketplace build`
Expected: `packages/marketplace/dist/manifest.webmanifest` and the three `dist/icon-*.png` exist (Vite copies `public/*` verbatim).

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/public packages/marketplace/index.html
git commit -m "feat(marketplace): installable PWA manifest + gem icons"
```

---

## Task 8: Lock in Worker passthrough of the manifest

**Files:**
- Modify: `packages/marketplace/src/worker.test.ts`

**Interfaces:**
- Consumes: existing `worker.fetch` + `env()` helper in the test file.

- [ ] **Step 1: Add the failing/guard test**

Append inside the `describe("marketplace OG worker", ...)` block:

```ts
  it("passes /manifest.webmanifest straight to ASSETS (no OG injection, no meta fetch)", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const e = env();
    const res = await worker.fetch(req("/manifest.webmanifest"), e);
    expect(e.ASSETS.fetch).toHaveBeenCalledOnce();     // delegated to static assets
    expect(f).not.toHaveBeenCalled();                  // no aggregator meta call
    expect(await res.text()).toBe(SHELL);              // returns exactly what ASSETS gave, unmodified
  });
```

(The stubbed `ASSETS` returns `SHELL` for any path; the point is the Worker returns it verbatim and never enters the `/games` injection branch.)

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @agentgem/marketplace test`
Expected: PASS immediately — the Worker already delegates non-`/games` paths to `env.ASSETS.fetch`. This test is a regression guard, not a driver of new code. If it FAILS, the Worker's routing changed and must be fixed before proceeding.

- [ ] **Step 3: Commit**

```bash
git add packages/marketplace/src/worker.test.ts
git commit -m "test(marketplace): guard that the OG worker never intercepts the PWA manifest"
```

- [ ] **Step 4: Manual verification (preview)**

Run `pnpm --filter @agentgem/marketplace build`, serve `dist/` (or `wrangler dev`), open in Chrome. Confirm `GET /manifest.webmanifest` and `/icon-*.png` return 200 with correct content-types (not the SPA HTML), Chrome offers install, and `/games/<key>` still gets OG tags. Screenshot for the PR.

- [ ] **Step 5: Open PR #2**

Push `feat/pwa-marketplace`; open a PR titled "feat(marketplace): installable PWA". Merge per the repo's PR lifecycle rules once CI is green. After merge, the deploy workflow (`deploy-worker.yml`) ships it to `app.agentgem.ai`.

---

## Self-Review

**Spec coverage:**
- Installable-only, no SW → Global Constraints + no SW task. ✓
- Console `data:`-URI icons in one served manifest → Tasks 2–5. ✓
- Console local-only route inside `SERVE_CONSOLE` guard → Task 5 Step 5. ✓
- Console packaging copy (npx + desktop) → Task 5 Steps 1–2. ✓
- Marketplace `public/` files + index.html tags + no worker change → Tasks 7–8. ✓
- Worker passthrough verified → Task 8. ✓
- Shared gem-mark artwork, 192/512/512-maskable, duplicated per target → Task 1 + Tasks 3/7. ✓
- Theme color `#f1eadb` (+ dark meta for marketplace) → Tasks 4, 7. ✓
- Two PRs → Tasks 5/8 Step "Open PR". ✓

**Spec deviation (intentional):** spec named `packages/console/src/pwa/icons.ts`; plan uses `packages/console/pwa-icons.mjs` because `build-client.mjs` (plain ESM) can't import a `.ts` and the React app never consumes the icons. Intent (committed, no new dependency, inlined data URIs) preserved.

**Placeholder scan:** none — every code step has concrete content; Task 3 replaces the deliberate 1×1 placeholder with real base64.

**Type/name consistency:** `buildManifest()`, `ICON_192/512/512_MASKABLE`, `consoleFile(name)` used identically across Tasks 2, 4, 5. Manifest field values match the spec verbatim in every task. ✓
