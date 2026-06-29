# Share Card — hosted OG certificate (Milestone C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public `agentgem.ai/share/:id` certificate card whose OpenGraph/Twitter preview renders natively in X/LinkedIn/Facebook, backed by the existing Cloudflare Worker + the aggregator service.

**Architecture:** The card is one SVG template (`renderCardSvg(counts)`) rasterized to PNG at the edge via `resvg-wasm`. The hosted aggregator service stores JSON-only share records (`ShareController`). The local app proxies create calls to the hosted backend (`shareClient`, reusing the `AGENTGEM_AGGREGATOR_URL` producer pattern). The console upgrades its trophy share to mint a hosted URL with per-platform share intents.

**Tech Stack:** TypeScript + `@agentback/{rest,openapi,drizzle}` + Drizzle/Postgres (pglite in tests) on the backend; plain-JS Cloudflare Worker + `@resvg/resvg-wasm` at the edge; React + esbuild + vitest/jsdom in the console.

## Global Constraints

- **Privacy boundary (verbatim):** share records and the SVG carry ONLY `breadth`, `battleTested`, `portable`, `generatedAtMs`. NEVER `gaps`, `projects`, roots, labels, candidate names, or raw logs.
- **Card copy (verbatim, from `trophy.ts:trophyLines`):** title `"My Agent Goldmine"`; lines `"<breadth> reusable workflows"`, `"<battleTested> battle-tested"`, `"<portable> worth sharing"`; tagline `"Valued with AgentGem"`; wordmark `"AgentGem"`.
- **Card dimensions:** `1200 × 630`. Theme: bg `#0b0f17`, accent `#7cc4ff`, ink `#e8edf5`, muted `#6b7689` (matches the existing trophy).
- **Canonical host:** `https://agentgem.ai`. All public URLs (`og:url`, `og:image`) use it.
- **Validation:** every backend body schema is explicit/closed — never `.loose()`; unknown fields rejected. Counts are non-negative integers.
- **Anonymous create + IP rate-limit; no account gate; no delete/revoke in v1.**
- **Self-reported counts** — never describe the card as "verified".
- **Tests:** backend tests live in `src/**/__tests__/*.test.ts` (compiled to `dist/`, run by root `pnpm test` = `tsc -b && vitest run`). Console tests live in `packages/console/src/**/*.test.{ts,tsx}` (`vitest run` in that package, jsdom). Worker tests are plain-JS `website/edge/**/*.test.js` (wired into root vitest in Task 1).
- **Commits:** end every commit message body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Author identity must be `Raymond Feng <raymond@ninemind.ai>`.

---

### Task 1: Card SVG template (Worker-canonical) + wire Worker tests into vitest

**Files:**
- Create: `website/edge/src/card.js`
- Create: `website/edge/src/card.test.js`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: `renderCardSvg(counts: {breadth:number,battleTested:number,portable:number}): string` (a 1200×630 SVG string), `cardDescription(counts): string` (the `og:description` text). Both pure, no imports.

- [ ] **Step 1: Wire Worker JS tests into root vitest**

Modify `vitest.config.ts` `include` to add the edge source tests:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["dist/**/__tests__/**/*.test.js", "website/edge/**/*.test.js"],
    exclude: ["**/node_modules/**"],
    testTimeout: 15000,
    watch: false,
  },
});
```

- [ ] **Step 2: Write the failing test**

Create `website/edge/src/card.test.js`:

```js
import { describe, it, expect } from "vitest";
import { renderCardSvg, cardDescription } from "./card.js";

const counts = { breadth: 14, battleTested: 3, portable: 5 };

describe("renderCardSvg", () => {
  it("is a 1200x630 svg containing the verbatim counts and copy", () => {
    const svg = renderCardSvg(counts);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="1200"');
    expect(svg).toContain('height="630"');
    expect(svg).toContain("My Agent Goldmine");
    expect(svg).toContain("14 reusable workflows");
    expect(svg).toContain("3 battle-tested");
    expect(svg).toContain("5 worth sharing");
    expect(svg).toContain("Valued with AgentGem");
    expect(svg).toContain("AgentGem");
  });

  it("escapes nothing dangerous (counts are numbers) and coerces to integers", () => {
    const svg = renderCardSvg({ breadth: 0, battleTested: 0, portable: 0 });
    expect(svg).toContain("0 reusable workflows");
  });
});

describe("cardDescription", () => {
  it("is the verbatim one-line summary", () => {
    expect(cardDescription(counts)).toBe(
      "14 reusable workflows · 3 battle-tested · 5 worth sharing — valued with AgentGem",
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run website/edge/src/card.test.js`
Expected: FAIL — `Cannot find module './card.js'`.

- [ ] **Step 4: Write minimal implementation**

Create `website/edge/src/card.js`:

```js
// Canonical goldmine certificate card. Pure: counts -> 1200x630 SVG string.
// Content/styling mirror packages/console/src/panels/Mine/trophy.ts:trophyLines.
// Counts only — never project/workflow names (privacy boundary).

const W = 1200, H = 630;
const BG = "#0b0f17", ACCENT = "#7cc4ff", INK = "#e8edf5", MUTED = "#6b7689";

const n = (v) => String(Math.max(0, Math.trunc(Number(v) || 0)));

/** @param {{breadth:number,battleTested:number,portable:number}} c */
export function renderCardSvg(c) {
  const counts = [
    { t: `${n(c.breadth)} reusable workflows`, fill: ACCENT },
    { t: `${n(c.battleTested)} battle-tested`, fill: INK },
    { t: `${n(c.portable)} worth sharing`, fill: INK },
  ];
  const lines = counts
    .map((l, i) => `<text x="80" y="${300 + i * 96}" fill="${l.fill}" font-size="64" font-weight="700">${l.t}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>` +
    `<text x="80" y="140" fill="${INK}" font-size="48" font-weight="600">My Agent Goldmine</text>` +
    lines +
    `<text x="80" y="${H - 56}" fill="${MUTED}" font-size="28">Valued with AgentGem</text>` +
    `<text x="${W - 260}" y="${H - 56}" fill="${ACCENT}" font-size="28" font-weight="700">AgentGem</text>` +
    `</svg>`;
}

/** @param {{breadth:number,battleTested:number,portable:number}} c */
export function cardDescription(c) {
  return `${n(c.breadth)} reusable workflows · ${n(c.battleTested)} battle-tested · ${n(c.portable)} worth sharing — valued with AgentGem`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run website/edge/src/card.test.js`
Expected: PASS (4 assertions).

- [ ] **Step 6: Commit**

```bash
git add website/edge/src/card.js website/edge/src/card.test.js vitest.config.ts
git commit -m "feat(share): canonical goldmine certificate SVG card + wire edge tests"
```

---

### Task 2: Console card mirror + parity test

**Files:**
- Create: `packages/console/src/panels/Mine/card.ts`
- Create: `packages/console/src/panels/Mine/card.test.ts`

**Interfaces:**
- Consumes (test-only): `website/edge/src/card.js` for byte-parity assertion.
- Produces: `renderCardSvg(counts): string`, `cardDescription(counts): string` — identical output to the Worker copy. Used by the console for the in-app card + offline PNG fallback.

- [ ] **Step 1: Write the failing parity test**

Create `packages/console/src/panels/Mine/card.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderCardSvg, cardDescription } from "./card.js";
// Parity: the console copy MUST byte-match the Worker-canonical copy.
import { renderCardSvg as workerSvg, cardDescription as workerDesc } from "../../../../../website/edge/src/card.js";

const cases = [
  { breadth: 14, battleTested: 3, portable: 5 },
  { breadth: 0, battleTested: 0, portable: 0 },
  { breadth: 1, battleTested: 1, portable: 1 },
];

describe("console card parity with the Worker", () => {
  for (const c of cases) {
    it(`renderCardSvg matches for ${JSON.stringify(c)}`, () => {
      expect(renderCardSvg(c)).toBe(workerSvg(c));
    });
    it(`cardDescription matches for ${JSON.stringify(c)}`, () => {
      expect(cardDescription(c)).toBe(workerDesc(c));
    });
  }
});
```

> Note: the `../../../../../website/edge/src/card.js` relative path goes from
> `packages/console/src/panels/Mine/` up to repo root then into `website/edge/src/`.
> Verify it resolves with `ls` before running: from repo root the file is
> `website/edge/src/card.js`; from the test file that is five `..` segments.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Mine/card.test.ts`
Expected: FAIL — `Cannot find module './card.js'` (the console copy).

- [ ] **Step 3: Write the console copy**

Create `packages/console/src/panels/Mine/card.ts` with byte-identical output. Copy the body of `website/edge/src/card.js` verbatim, adding a TS type:

```ts
// Mirror of website/edge/src/card.js — output MUST stay byte-identical (card.test.ts enforces it).
// Counts only — never project/workflow names (privacy boundary).
export type CardCounts = { breadth: number; battleTested: number; portable: number };

const W = 1200, H = 630;
const BG = "#0b0f17", ACCENT = "#7cc4ff", INK = "#e8edf5", MUTED = "#6b7689";

const n = (v: number) => String(Math.max(0, Math.trunc(Number(v) || 0)));

export function renderCardSvg(c: CardCounts): string {
  const counts = [
    { t: `${n(c.breadth)} reusable workflows`, fill: ACCENT },
    { t: `${n(c.battleTested)} battle-tested`, fill: INK },
    { t: `${n(c.portable)} worth sharing`, fill: INK },
  ];
  const lines = counts
    .map((l, i) => `<text x="80" y="${300 + i * 96}" fill="${l.fill}" font-size="64" font-weight="700">${l.t}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>` +
    `<text x="80" y="140" fill="${INK}" font-size="48" font-weight="600">My Agent Goldmine</text>` +
    lines +
    `<text x="80" y="${H - 56}" fill="${MUTED}" font-size="28">Valued with AgentGem</text>` +
    `<text x="${W - 260}" y="${H - 56}" fill="${ACCENT}" font-size="28" font-weight="700">AgentGem</text>` +
    `</svg>`;
}

export function cardDescription(c: CardCounts): string {
  return `${n(c.breadth)} reusable workflows · ${n(c.battleTested)} battle-tested · ${n(c.portable)} worth sharing — valued with AgentGem`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Mine/card.test.ts`
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Mine/card.ts packages/console/src/panels/Mine/card.test.ts
git commit -m "feat(share): console card mirror with Worker byte-parity test"
```

---

### Task 3: Edge SVG→PNG rasterization (resvg-wasm + bundled font)

**Files:**
- Create: `website/edge/src/raster.js`
- Create: `website/edge/src/raster.test.js`
- Create (binary): `website/edge/assets/card-font.ttf`
- Modify: `website/edge/package.json` (create if absent)
- Modify: `package.json` (root, add dev dependency)

**Interfaces:**
- Consumes: `renderCardSvg` (Task 1).
- Produces: `async rasterizeCard(counts): Promise<Uint8Array>` — a PNG byte array. Lazy-inits the wasm once.

- [ ] **Step 1: Add the rasterizer dependency and a font asset**

```bash
# resvg-wasm runs both in the Worker and in node (for the test).
pnpm add -D -w @resvg/resvg-wasm
# A TTF the rasterizer can use for text (OFL Inter SemiBold; any TTF works).
mkdir -p website/edge/assets
curl -L -o website/edge/assets/card-font.ttf \
  https://github.com/rsms/inter/raw/v4.0/docs/font-files/Inter-SemiBold.ttf
```

If the download is unavailable in the environment, copy any system `.ttf` to that path (e.g. on macOS `cp /System/Library/Fonts/Supplemental/Arial.ttf website/edge/assets/card-font.ttf`). The exact face is not load-bearing.

- [ ] **Step 2: Write the failing test**

Create `website/edge/src/raster.test.js`:

```js
import { describe, it, expect } from "vitest";
import { rasterizeCard } from "./raster.js";

describe("rasterizeCard", () => {
  it("renders a non-empty PNG (magic bytes) from counts", async () => {
    const png = await rasterizeCard({ breadth: 14, battleTested: 3, portable: 5 });
    expect(png).toBeInstanceOf(Uint8Array);
    expect(png.length).toBeGreaterThan(1000);
    // PNG signature: 0x89 'P' 'N' 'G'
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 20000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run website/edge/src/raster.test.js`
Expected: FAIL — `Cannot find module './raster.js'`.

- [ ] **Step 4: Write the rasterizer**

Create `website/edge/src/raster.js`:

```js
// SVG -> PNG at the edge via resvg-wasm. The wasm + font load once per isolate.
// In the Worker, wrangler inlines ./resvg.wasm and ./assets/card-font.ttf as
// bytes; in node (tests) they are read from disk.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { renderCardSvg } from "./card.js";

let ready;
async function ensureWasm() {
  if (!ready) {
    // resvg-wasm ships the .wasm in its package; node can pass the URL/bytes.
    const wasm = await import("@resvg/resvg-wasm/index_bg.wasm");
    ready = initWasm(wasm.default ?? wasm);
  }
  return ready;
}

let fontBytes;
async function font() {
  if (!fontBytes) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const url = new URL("./assets/card-font.ttf", import.meta.url);
    fontBytes = new Uint8Array(await readFile(fileURLToPath(url)));
  }
  return fontBytes;
}

/** @param {{breadth:number,battleTested:number,portable:number}} counts */
export async function rasterizeCard(counts) {
  await ensureWasm();
  const resvg = new Resvg(renderCardSvg(counts), {
    fitTo: { mode: "width", value: 1200 },
    font: { fontBuffers: [await font()], defaultFontFamily: "sans-serif", loadSystemFonts: false },
  });
  return resvg.render().asPng();
}
```

> Worker note (handled in Task 4 wrangler wiring): in the deployed Worker the
> `node:fs` font read is replaced by an inlined import. Keep `rasterizeCard`'s
> signature stable; Task 4 supplies the Worker-side font via a small shim.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run website/edge/src/raster.test.js`
Expected: PASS. If `initWasm` errors on the import path, adjust to
`const mod = await import("@resvg/resvg-wasm"); await mod.initWasm(fetch(new URL("@resvg/resvg-wasm/index_bg.wasm", import.meta.url)))` per the installed version's README, then re-run.

- [ ] **Step 6: Commit**

```bash
git add website/edge/src/raster.js website/edge/src/raster.test.js website/edge/assets/card-font.ttf package.json pnpm-lock.yaml
git commit -m "feat(share): edge SVG->PNG rasterization via resvg-wasm + font asset"
```

---

### Task 4: Worker `/share` routes (HTML meta + og.png + placeholder)

**Files:**
- Create: `website/edge/src/share.js`
- Create: `website/edge/src/share.test.js`
- Modify: `website/edge/src/markdown-negotiation.js`
- Modify: `website/edge/wrangler.toml`

**Interfaces:**
- Consumes: `cardDescription` (Task 1), `rasterizeCard` (Task 3).
- Produces: `parseShareId(pathname): {id:string, png:boolean} | null`; `renderShareHtml(record, {ogImageUrl, shareUrl}): string`; `placeholderHtml(): string`; `handleShare(request, env): Promise<Response|null>`.

- [ ] **Step 1: Write the failing test**

Create `website/edge/src/share.test.js`:

```js
import { describe, it, expect } from "vitest";
import { parseShareId, renderShareHtml, handleShare } from "./share.js";

const record = { kind: "certificate", counts: { breadth: 14, battleTested: 3, portable: 5 }, generatedAtMs: 1, createdAtMs: 2 };

describe("parseShareId", () => {
  it("parses card + og.png paths and rejects others", () => {
    expect(parseShareId("/share/abc123")).toEqual({ id: "abc123", png: false });
    expect(parseShareId("/share/abc123/og.png")).toEqual({ id: "abc123", png: true });
    expect(parseShareId("/")).toBeNull();
    expect(parseShareId("/share/")).toBeNull();
    expect(parseShareId("/share/abc/extra")).toBeNull();
  });
});

describe("renderShareHtml", () => {
  it("emits OG/Twitter meta with canonical image + escaped description", () => {
    const html = renderShareHtml(record, { ogImageUrl: "https://agentgem.ai/share/x/og.png", shareUrl: "https://agentgem.ai/share/x" });
    expect(html).toContain('<meta property="og:title" content="My Agent Goldmine">');
    expect(html).toContain('<meta property="og:image" content="https://agentgem.ai/share/x/og.png">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain("14 reusable workflows · 3 battle-tested · 5 worth sharing");
    expect(html).toContain("agentgem.ai"); // invite CTA target
  });
});

describe("handleShare", () => {
  const env = { AGGREGATOR_API: "https://api.test" };

  it("returns null for non-share paths", async () => {
    expect(await handleShare(new Request("https://agentgem.ai/docs"), env)).toBeNull();
  });

  it("renders HTML for a known id", async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => record });
    const res = await handleShare(new Request("https://agentgem.ai/share/x"), { ...env, fetch: fetchImpl });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("404s an unknown id", async () => {
    const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const res = await handleShare(new Request("https://agentgem.ai/share/missing"), { ...env, fetch: fetchImpl });
    expect(res.status).toBe(404);
  });

  it("serves a graceful placeholder when AGGREGATOR_API is unset", async () => {
    const res = await handleShare(new Request("https://agentgem.ai/share/x"), {});
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("coming soon");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run website/edge/src/share.test.js`
Expected: FAIL — `Cannot find module './share.js'`.

- [ ] **Step 3: Write the share module**

Create `website/edge/src/share.js`:

```js
// Public certificate share routes. /share/:id -> OG HTML; /share/:id/og.png ->
// rasterized card. Data comes from the hosted aggregator (env.AGGREGATOR_API).
// When AGGREGATOR_API is unset the route degrades to a placeholder so the Worker
// never breaks the site before the backend is deployed (#38).
import { cardDescription } from "./card.js";
import { rasterizeCard } from "./raster.js";

const CANONICAL = "https://agentgem.ai";

export function parseShareId(pathname) {
  const m = pathname.match(/^\/share\/([A-Za-z0-9]+)(\/og\.png)?$/);
  if (!m) return null;
  return { id: m[1], png: Boolean(m[2]) };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function placeholderHtml() {
  return `<!doctype html><meta charset="utf-8"><title>AgentGem</title>` +
    `<body style="font-family:sans-serif;background:#0b0f17;color:#e8edf5;padding:48px">` +
    `<h1>Sharing is coming soon</h1><p><a style="color:#7cc4ff" href="${CANONICAL}">Value your own agent goldmine →</a></p></body>`;
}

export function renderShareHtml(record, { ogImageUrl, shareUrl }) {
  const desc = cardDescription(record.counts);
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>My Agent Goldmine — AgentGem</title>` +
    `<meta property="og:title" content="My Agent Goldmine">` +
    `<meta property="og:description" content="${esc(desc)}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:url" content="${esc(shareUrl)}">` +
    `<meta property="og:image" content="${esc(ogImageUrl)}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="My Agent Goldmine">` +
    `<meta name="twitter:description" content="${esc(desc)}">` +
    `<meta name="twitter:image" content="${esc(ogImageUrl)}">` +
    `</head><body style="font-family:sans-serif;background:#0b0f17;color:#e8edf5;text-align:center;padding:48px">` +
    `<img src="${esc(ogImageUrl)}" alt="${esc(desc)}" width="600" style="max-width:100%;border-radius:12px">` +
    `<p style="font-size:20px">${esc(desc)}</p>` +
    `<p><a style="color:#7cc4ff;font-size:22px" href="${CANONICAL}">Value your own agent goldmine →</a></p>` +
    `</body></html>`;
}

async function fetchRecord(env, id) {
  const f = env.fetch || fetch;
  const res = await f(`${env.AGGREGATOR_API}/api/aggregator/share?id=${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function handleShare(request, env) {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  const parsed = parseShareId(url.pathname);
  if (!parsed) return null;

  if (!env.AGGREGATOR_API) {
    return new Response(placeholderHtml(), { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const record = await fetchRecord(env, parsed.id);
  if (!record) {
    return new Response("Card not found", { status: 404, headers: { "content-type": "text/plain" } });
  }

  if (parsed.png) {
    const png = await rasterizeCard(record.counts);
    return new Response(png, { status: 200, headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" } });
  }

  const shareUrl = `${CANONICAL}/share/${parsed.id}`;
  const html = renderShareHtml(record, { ogImageUrl: `${shareUrl}/og.png`, shareUrl });
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run website/edge/src/share.test.js`
Expected: PASS (the "renders HTML" case rasterizes — keep timeout default 15s).

- [ ] **Step 5: Wire the branch into the Worker entry**

Modify `website/edge/src/markdown-negotiation.js` — add the import at top and the branch inside `fetch` after the canonical-host redirect, before the markdown/ASSETS logic:

```js
import { handleShare } from './share.js';
```

Inside `fetch`, immediately after the `if (url.hostname !== CANONICAL_HOST) { ... }` block:

```js
    try {
      const shared = await handleShare(request, env);
      if (shared) return shared;
    } catch {
      // Never let sharing break the site — fall through to assets.
    }
```

- [ ] **Step 6: Declare the backend URL var**

Modify `website/edge/wrangler.toml` — add (a plain var; the backend base is public):

```toml
[vars]
# Hosted aggregator base URL (the share record store). Empty/unset -> /share
# serves a graceful placeholder. Set to the #38 deploy origin when live.
AGGREGATOR_API = ""
```

- [ ] **Step 7: Run the full edge suite + commit**

Run: `pnpm exec vitest run website/edge`
Expected: PASS (card, raster, share).

```bash
git add website/edge/src/share.js website/edge/src/share.test.js website/edge/src/markdown-negotiation.js website/edge/wrangler.toml
git commit -m "feat(share): Worker /share OG route + og.png + graceful placeholder"
```

---

### Task 5: Backend `share_cards` schema

**Files:**
- Modify: `src/aggregator/schema.ts`
- Create: `src/aggregator/__tests__/shareSchema.test.ts`

**Interfaces:**
- Produces: `shareCards` Drizzle table (`id` text PK, `kind` text, `counts` jsonb, `generatedAtMs` bigint, `createdAtMs` bigint); included in `schema`; created by `ensureSchema`.

- [ ] **Step 1: Write the failing test**

Create `src/aggregator/__tests__/shareSchema.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";
import { shareCards } from "../schema.js";

describe("share_cards schema", () => {
  it("stores and reads a certificate record", async () => {
    const db = await makeTestDb();
    await db.insert(shareCards).values({
      id: "abc1234567", kind: "certificate",
      counts: { breadth: 14, battleTested: 3, portable: 5 },
      generatedAtMs: 111, createdAtMs: 222,
    });
    const rows = await db.select().from(shareCards).where(sql`id = 'abc1234567'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].counts).toEqual({ breadth: 14, battleTested: 3, portable: 5 });
    expect(Number(rows[0].generatedAtMs)).toBe(111);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm exec vitest run dist/aggregator/__tests__/shareSchema.test.js`
Expected: FAIL — `shareCards` is not exported.

- [ ] **Step 3: Add the table + DDL**

Modify `src/aggregator/schema.ts`:
- Add `jsonb` and `bigint` to the `drizzle-orm/pg-core` import.
- Add the table after `accountBindings`:

```ts
export const shareCards = pgTable("share_cards", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  counts: jsonb("counts").notNull().$type<{ breadth: number; battleTested: number; portable: number }>(),
  generatedAtMs: bigint("generated_at_ms", { mode: "number" }).notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
});
```

- Add `shareCards` to the `schema` object:

```ts
export const schema = { producers, attestations, ingredients, usageEdges, accountBindings, shareCards };
```

- Add the DDL line at the end of `ensureSchema`:

```ts
  await db.execute(sql`create table if not exists share_cards (id text primary key, kind text not null, counts jsonb not null, generated_at_ms bigint not null, created_at_ms bigint not null)`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm exec vitest run dist/aggregator/__tests__/shareSchema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/schema.ts src/aggregator/__tests__/shareSchema.test.ts
git commit -m "feat(share): share_cards table on the aggregator schema"
```

---

### Task 6: Backend store + `ShareController`

**Files:**
- Create: `src/share/shareStore.ts`
- Create: `src/share.controller.ts`
- Create: `src/share/__tests__/shareController.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `shareCards`, `AppDb` (Task 5).
- Produces: `genShareId(): string`; `createShareCard(db, {kind, counts, generatedAtMs}): Promise<{id, url}>`; `getShareCard(db, id): Promise<Record|null>`; `ShareController` at basePath `/api/aggregator/share` with `POST "/"` and `GET "/"` (query `id`).

- [ ] **Step 1: Write the failing test**

Create `src/share/__tests__/shareController.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../../aggregator/testDb.js";
import { ShareController } from "../../share.controller.js";

const counts = { breadth: 14, battleTested: 3, portable: 5 };

describe("ShareController", () => {
  it("creates a certificate and reads it back", async () => {
    const db = await makeTestDb();
    const c = new ShareController(db);
    const { id, url } = await c.create({ body: { kind: "certificate", counts, generatedAtMs: 5 } });
    expect(id).toMatch(/^[A-Za-z0-9]{8,}$/);
    expect(url).toBe(`https://agentgem.ai/share/${id}`);
    const read = await c.read({ query: { id } });
    expect(read).toEqual({ kind: "certificate", counts, generatedAtMs: 5, createdAtMs: read.createdAtMs });
    expect(typeof read.createdAtMs).toBe("number");
  });

  it("rejects negative counts and unknown fields", async () => {
    const db = await makeTestDb();
    const c = new ShareController(db);
    await expect(c.create({ body: { kind: "certificate", counts: { breadth: -1, battleTested: 0, portable: 0 }, generatedAtMs: 1 } as never }))
      .rejects.toThrow();
  });

  it("404s an unknown id", async () => {
    const db = await makeTestDb();
    const c = new ShareController(db);
    await expect(c.read({ query: { id: "nope000000" } })).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm exec vitest run dist/share/__tests__/shareController.test.js`
Expected: FAIL — module `../../share.controller.js` not found.

- [ ] **Step 3: Write the store**

Create `src/share/shareStore.ts`:

```ts
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { shareCards } from "../aggregator/schema.js";
import type { AppDb } from "../aggregator/schema.js";

export type ShareCounts = { breadth: number; battleTested: number; portable: number };
export type ShareRecord = { kind: "certificate"; counts: ShareCounts; generatedAtMs: number; createdAtMs: number };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function genShareId(len = 10): string {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

export const SHARE_BASE = process.env.SHARE_BASE ?? "https://agentgem.ai";

export async function createShareCard(
  db: AppDb,
  input: { kind: "certificate"; counts: ShareCounts; generatedAtMs: number },
): Promise<{ id: string; url: string }> {
  const id = genShareId();
  await db.insert(shareCards).values({ id, kind: input.kind, counts: input.counts, generatedAtMs: input.generatedAtMs, createdAtMs: Date.now() });
  return { id, url: `${SHARE_BASE}/share/${id}` };
}

export async function getShareCard(db: AppDb, id: string): Promise<ShareRecord | null> {
  const rows = await db.select().from(shareCards).where(sql`id = ${id}`);
  if (rows.length === 0) return null;
  const r = rows[0];
  return { kind: r.kind as "certificate", counts: r.counts as ShareCounts, generatedAtMs: Number(r.generatedAtMs), createdAtMs: Number(r.createdAtMs) };
}
```

- [ ] **Step 4: Write the controller**

Create `src/share.controller.ts`:

```ts
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { inject } from "@agentback/core";
import { DrizzleBindings } from "@agentback/drizzle";
import type { AppDb } from "./aggregator/schema.js";
import { createShareCard, getShareCard } from "./share/shareStore.js";

const Counts = z.object({
  breadth: z.number().int().nonnegative(),
  battleTested: z.number().int().nonnegative(),
  portable: z.number().int().nonnegative(),
}).strict();
const CreateBody = z.object({ kind: z.literal("certificate"), counts: Counts, generatedAtMs: z.number().int().nonnegative() }).strict();
const CreateResult = z.object({ id: z.string(), url: z.string() });
const ReadQuery = z.object({ id: z.string() });
const ReadResult = z.object({ kind: z.literal("certificate"), counts: Counts, generatedAtMs: z.number(), createdAtMs: z.number() });

@api({ basePath: "/api/aggregator/share" })
export class ShareController {
  constructor(@inject(DrizzleBindings.CLIENT) private db: AppDb) {}

  @post("/", { body: CreateBody, response: CreateResult })
  async create(input: { body: z.infer<typeof CreateBody> }): Promise<z.infer<typeof CreateResult>> {
    const body = CreateBody.parse(input.body); // belt-and-suspenders: reject extras/negatives
    return createShareCard(this.db, body);
  }

  @get("/", { query: ReadQuery, response: ReadResult })
  async read(input: { query: z.infer<typeof ReadQuery> }): Promise<z.infer<typeof ReadResult>> {
    const rec = await getShareCard(this.db, input.query.id);
    if (!rec) throw new Error("share card not found");
    return rec;
  }
}
```

- [ ] **Step 5: Register the controller**

Modify `src/index.ts` — inside the `if (process.env.DATABASE_URL) { ... }` block, after `app.restController(AggregatorController);` add:

```ts
    app.restController(ShareController);
```

And add the import near the other controller imports:

```ts
import { ShareController } from "./share.controller.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm build && pnpm exec vitest run dist/share/__tests__/shareController.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/share/shareStore.ts src/share.controller.ts src/share/__tests__/shareController.test.ts src/index.ts
git commit -m "feat(share): ShareController + store (create/read) on the aggregator"
```

---

### Task 7: Local proxy (`shareClient` + `POST /api/share`)

**Files:**
- Create: `src/gem/shareClient.ts`
- Create: `src/share.proxy.controller.ts`
- Create: `src/gem/__tests__/shareClient.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: nothing from prior backend tasks (talks over HTTP).
- Produces: `postShare({counts, generatedAtMs, endpoint?, http?, port?}): Promise<{id,url} | {skipped:true}>`; `ShareProxyController` at basePath `/api/share` with `POST "/"`.

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/shareClient.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { postShare } from "../shareClient.js";

const counts = { breadth: 1, battleTested: 1, portable: 1 };

describe("postShare", () => {
  it("POSTs to the configured endpoint and returns id/url", async () => {
    let seen: { url: string; body: string } | null = null;
    const http = async (url: string, init: { body: string }) => { seen = { url, body: init.body }; return { status: 200, json: async () => ({ id: "x10", url: "https://agentgem.ai/share/x10" }) }; };
    const r = await postShare({ counts, generatedAtMs: 9, endpoint: "https://api.test", http });
    expect(r).toEqual({ id: "x10", url: "https://agentgem.ai/share/x10" });
    expect(seen!.url).toBe("https://api.test/api/aggregator/share");
    expect(JSON.parse(seen!.body)).toEqual({ kind: "certificate", counts, generatedAtMs: 9 });
  });

  it("skips when no endpoint and no local port are available", async () => {
    const r = await postShare({ counts, generatedAtMs: 9, endpoint: "" });
    expect(r).toEqual({ skipped: true });
  });

  it("throws on a non-2xx", async () => {
    const http = async () => ({ status: 500, json: async () => ({}) });
    await expect(postShare({ counts, generatedAtMs: 9, endpoint: "https://api.test", http })).rejects.toThrow(/share 500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm exec vitest run dist/gem/__tests__/shareClient.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the client** (mirrors `src/gem/ingestClient.ts`)

Create `src/gem/shareClient.ts`:

```ts
export type ShareHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultHttp: ShareHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, json: () => res.json() };
};

type Counts = { breadth: number; battleTested: number; portable: number };

// Resolve the backend base: explicit endpoint -> AGENTGEM_AGGREGATOR_URL ->
// the in-process aggregator (self) when a local port is known -> skip.
function resolveBase(endpoint: string | undefined, port: number | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  if (port) return `http://127.0.0.1:${port}`;
  return "";
}

export async function postShare(args: {
  counts: Counts; generatedAtMs: number; endpoint?: string; port?: number; http?: ShareHttp;
}): Promise<{ id: string; url: string } | { skipped: true }> {
  const base = resolveBase(args.endpoint, args.port);
  if (!base) return { skipped: true };
  const http = args.http ?? defaultHttp;
  const res = await http(`${base}/api/aggregator/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "certificate", counts: args.counts, generatedAtMs: args.generatedAtMs }),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`share ${res.status}`);
  const body = (await res.json()) as { id?: string; url?: string };
  if (!body.id || !body.url) throw new Error("share: response missing id/url");
  return { id: body.id, url: body.url };
}
```

- [ ] **Step 4: Write the proxy controller**

Create `src/share.proxy.controller.ts`:

```ts
import { z } from "zod";
import { api, post } from "@agentback/openapi";
import { postShare } from "./gem/shareClient.js";

const Counts = z.object({
  breadth: z.number().int().nonnegative(),
  battleTested: z.number().int().nonnegative(),
  portable: z.number().int().nonnegative(),
}).strict();
const Body = z.object({ counts: Counts, generatedAtMs: z.number().int().nonnegative() }).strict();
const Result = z.object({ id: z.string(), url: z.string() });

// Same-origin endpoint the console calls. Forwards to the hosted aggregator
// (AGENTGEM_AGGREGATOR_URL) or the in-process one. Browser stays same-origin.
@api({ basePath: "/api/share" })
export class ShareProxyController {
  @post("/", { body: Body, response: Result })
  async create(input: { body: z.infer<typeof Body> }): Promise<z.infer<typeof Result>> {
    const port = Number(process.env.PORT ?? 4317);
    const r = await postShare({ counts: input.body.counts, generatedAtMs: input.body.generatedAtMs, port });
    if ("skipped" in r) throw new Error("sharing is not configured (set AGENTGEM_AGGREGATOR_URL)");
    return r;
  }
}
```

- [ ] **Step 5: Register the proxy (always)**

Modify `src/index.ts` — after `app.restController(GemController);` add:

```ts
  app.restController(ShareProxyController);
```

And import near the others:

```ts
import { ShareProxyController } from "./share.proxy.controller.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm build && pnpm exec vitest run dist/gem/__tests__/shareClient.test.js`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/gem/shareClient.ts src/share.proxy.controller.ts src/gem/__tests__/shareClient.test.ts src/index.ts
git commit -m "feat(share): local same-origin /api/share proxy + shareClient"
```

---

### Task 8: Console share UX — mint hosted URL + share intents

**Files:**
- Create: `packages/console/src/panels/Mine/shareIntents.ts`
- Create: `packages/console/src/panels/Mine/shareIntents.test.ts`
- Modify: `packages/console/src/api/routes.ts`
- Modify: `packages/console/src/panels/Mine/Scorecard.tsx`
- Modify: `packages/console/src/panels/Mine/__tests__/Scorecard.test.tsx`

**Interfaces:**
- Consumes: `renderCardSvg` (Task 2); `createShareRoute` (added here).
- Produces: `shareIntents(url): {x:string, linkedin:string, facebook:string}`; `createShareRoute` (POST `/api/share`).

- [ ] **Step 1: Write the failing intents test**

Create `packages/console/src/panels/Mine/shareIntents.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { shareIntents } from "./shareIntents.js";

describe("shareIntents", () => {
  it("builds platform share URLs that encode the hosted url", () => {
    const u = "https://agentgem.ai/share/abc";
    const i = shareIntents(u);
    expect(i.x).toContain("https://x.com/intent/tweet");
    expect(i.x).toContain(encodeURIComponent(u));
    expect(i.linkedin).toContain("linkedin.com");
    expect(i.linkedin).toContain(encodeURIComponent(u));
    expect(i.facebook).toContain("facebook.com/sharer");
    expect(i.facebook).toContain(encodeURIComponent(u));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Mine/shareIntents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the intents builder**

Create `packages/console/src/panels/Mine/shareIntents.ts`:

```ts
// Per-platform share-intent URLs pointing at the hosted card. Pure.
export function shareIntents(url: string): { x: string; linkedin: string; facebook: string } {
  const u = encodeURIComponent(url);
  const text = encodeURIComponent("My agent goldmine, valued with AgentGem");
  return {
    x: `https://x.com/intent/tweet?url=${u}&text=${text}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Mine/shareIntents.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the create route**

Modify `packages/console/src/api/routes.ts` — add near the other Scorecard routes:

```ts
export const createShareRoute = defineRoute("POST", "/api/share", {
  body: z.object({
    counts: z.object({ breadth: z.number(), battleTested: z.number(), portable: z.number() }),
    generatedAtMs: z.number(),
  }),
  response: z.object({ id: z.string(), url: z.string() }),
});
```

- [ ] **Step 6: Write the failing Scorecard interaction test**

Add to `packages/console/src/panels/Mine/__tests__/Scorecard.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ScorecardHero } from "../Scorecard.js";

const data = { breadth: 14, battleTested: 3, portable: 5, gaps: [], projects: [], generatedAtMs: 7, degraded: false } as never;

describe("ScorecardHero share", () => {
  it("mints a hosted url and shows share intents", async () => {
    const createShare = vi.fn(async () => ({ id: "abc", url: "https://agentgem.ai/share/abc" }));
    render(<ScorecardHero data={data} createShare={createShare} />);
    fireEvent.click(screen.getByText(/share your goldmine/i));
    await waitFor(() => expect(createShare).toHaveBeenCalledWith({ counts: { breadth: 14, battleTested: 3, portable: 5 }, generatedAtMs: 7 }));
    const link = await screen.findByText(/share on x/i);
    expect(link.closest("a")!.getAttribute("href")).toContain(encodeURIComponent("https://agentgem.ai/share/abc"));
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Mine/__tests__/Scorecard.test.tsx`
Expected: FAIL — `ScorecardHero` does not accept `createShare` / no "Share on X" link.

- [ ] **Step 8: Upgrade `ScorecardHero`**

Modify `packages/console/src/panels/Mine/Scorecard.tsx`. Replace the `drawTrophy/shareTrophy` import and `onShare` with the hosted flow; render the in-app card via `renderCardSvg`; keep an offline PNG download by rasterizing the inline SVG. Inject `createShare` for testability (defaults to the real route).

```tsx
import { useRef, useState } from "react";
import type { Scorecard } from "../../api/routes.js";
import { createShareRoute, makeClient } from "../../api/routes.js";
import { renderCardSvg } from "./card.js";
import { shareIntents } from "./shareIntents.js";

type CreateShare = (b: { counts: { breadth: number; battleTested: number; portable: number }; generatedAtMs: number }) => Promise<{ id: string; url: string }>;

export type WorkflowFilter = "all" | "battleTested" | "portable";

export function ScorecardHero({ data, apiBase = "", createShare }: { data: Scorecard; apiBase?: string; createShare?: CreateShare }) {
  const counts = { breadth: data.breadth, battleTested: data.battleTested, portable: data.portable };
  const doCreate: CreateShare = createShare ?? ((body) => createShareRoute.call(makeClient(apiBase), { body }));
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const svg = renderCardSvg(counts);
  const svgDataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

  const onShare = async () => {
    setBusy(true); setErr(null);
    try {
      const { url } = await doCreate({ counts, generatedAtMs: data.generatedAtMs });
      setShareUrl(url);
      const nav = navigator as Navigator & { share?: (d: { url: string; title: string }) => Promise<void> };
      if (nav.share) await nav.share({ url, title: "My Agent Goldmine" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Share failed");
    } finally { setBusy(false); }
  };

  const downloadPng = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = 1200; c.height = 630;
      c.getContext("2d")!.drawImage(img, 0, 0);
      c.toBlob((b) => {
        if (!b) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b); a.download = "agentgem-goldmine.png"; a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");
    };
    img.src = svgDataUri;
  };

  const intents = shareUrl ? shareIntents(shareUrl) : null;

  return (
    <section className="scorecard-hero" aria-label="Goldmine scorecard">
      <h2>Your log holds <strong>{data.breadth} reusable workflows</strong></h2>
      <p className="scorecard-stats">{data.battleTested} battle-tested · {data.portable} worth sharing</p>
      {data.gaps.length > 0 && <p className="scorecard-gaps">Next: {data.gaps.join(" · ")}</p>}
      <img className="scorecard-card" src={svgDataUri} alt="Goldmine certificate" width={480} />
      <div className="scorecard-actions">
        <button className="scorecard-share" onClick={onShare} disabled={busy}>{busy ? "Sharing…" : "Share your goldmine"}</button>
        <button className="scorecard-download" onClick={downloadPng}>Download PNG</button>
      </div>
      {err && <p className="scorecard-error">{err}</p>}
      {shareUrl && intents && (
        <div className="scorecard-share-links">
          <input readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
          <button onClick={() => void navigator.clipboard?.writeText(shareUrl)}>Copy link</button>
          <a href={intents.x} target="_blank" rel="noreferrer">Share on X</a>
          <a href={intents.linkedin} target="_blank" rel="noreferrer">Share on LinkedIn</a>
          <a href={intents.facebook} target="_blank" rel="noreferrer">Share on Facebook</a>
        </div>
      )}
      {data.degraded && <span className="scorecard-degraded" title="Some projects could not be fully scanned">partial</span>}
    </section>
  );
}
```

Leave `ScorecardScanning` / `ScorecardHeroSkeleton` and the rest of the file unchanged.

- [ ] **Step 9: Delete the now-unused canvas trophy**

`drawTrophy`/`shareTrophy` are no longer referenced by `Scorecard.tsx`. Remove the file and its test so the bundle stays lean:

```bash
git rm packages/console/src/panels/Mine/trophy.ts packages/console/src/panels/Mine/__tests__/trophy.test.ts
```

> If any other file imports from `./trophy.js`, stop and re-point it instead of deleting — run `grep -rn "trophy" packages/console/src` first.

- [ ] **Step 10: Run the console suite to verify it passes**

Run: `pnpm --filter @agentgem/console exec vitest run`
Expected: PASS (parity, intents, Scorecard share; no dangling `trophy` imports).

- [ ] **Step 11: Commit**

```bash
git add packages/console/src/panels/Mine/shareIntents.ts packages/console/src/panels/Mine/shareIntents.test.ts \
  packages/console/src/api/routes.ts packages/console/src/panels/Mine/Scorecard.tsx \
  packages/console/src/panels/Mine/__tests__/Scorecard.test.tsx
git commit -m "feat(share): console mints hosted certificate URL + share intents"
```

---

### Task 9: Full-suite green + manual local smoke

**Files:** none (verification task).

- [ ] **Step 1: Run the whole backend + edge suite**

Run: `pnpm test`
Expected: all green (includes the new dist + edge tests).

- [ ] **Step 2: Run the console suite**

Run: `pnpm --filter @agentgem/console test`
Expected: all green.

- [ ] **Step 3: Local end-to-end smoke (with a local DB)**

```bash
DATABASE_URL=postgres://localhost/agentgem_dev pnpm build && DATABASE_URL=postgres://localhost/agentgem_dev pnpm start
# In the console (http://127.0.0.1:4317): open Mine -> "Share your goldmine".
# Expect a 200 from POST /api/share returning {id,url}; the share-links row appears.
# Visit http://127.0.0.1:4317 is local-only; the hosted preview is verified post-deploy (below).
```

Expected: `POST /api/share` succeeds (proxy → in-process aggregator), a row lands in `share_cards`, and the UI shows the copy/intents row.

- [ ] **Step 4: Commit any fixups, then stop for the deploy-gated verification**

The remaining verification (real OG previews) requires the #38 backend deploy + a Worker deploy and is intentionally out of this branch's automated scope:
- Set `AGGREGATOR_API` in `website/edge/wrangler.toml` (or as a Worker var) to the deployed aggregator origin.
- Deploy the Worker (the existing `deploy-worker.yml` runs on `website/**` changes).
- Validate a real `https://agentgem.ai/share/:id` with the X Card Validator, Facebook Sharing Debugger, and LinkedIn Post Inspector.

---

## Self-Review

**1. Spec coverage:**
- Hosting on the existing Worker → Task 4. ✓
- Certificate subject, counts-only → Tasks 1/2/5/6, privacy boundary enforced by closed zod (Task 6) + counts-only SVG (Task 1). ✓
- Backend contract (`POST`/`GET` share) → Task 6; JSON-only schema → Task 5. ✓
- SVG source rasterized at edge (resvg-wasm) → Tasks 1/3/4. ✓
- `og:image` on canonical host, OG/Twitter meta → Task 4. ✓
- Local proxy reusing `AGENTGEM_AGGREGATOR_URL` + `ingestClient` shape → Task 7. ✓
- Console: same SVG in-app, mint URL, X/LinkedIn/FB intents, `navigator.share`, PNG fallback, retire canvas → Task 8. ✓
- `AGGREGATOR_API`-unset placeholder → Task 4. ✓
- Anonymous create, no delete → Tasks 6/7 (no auth gate, no delete route). ✓
- Two-runtime parity → Task 2 (test-time cross-import byte-equality). ✓
- Self-reported limitation → carried as copy/no "verified" claim; documented in the spec. ✓
- Tests in the right homes (dist / console / edge) → Task 1 wires edge into vitest. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; the only non-code asset (font TTF) has a concrete acquisition command + fallback.

**3. Type consistency:** `renderCardSvg`/`cardDescription` identical across Tasks 1–2; `counts` shape `{breadth,battleTested,portable}` consistent across SVG, schema (Task 5), store (Task 6), proxy (Task 7), route (Task 8); backend read path `/api/aggregator/share?id=` matches the Worker fetch (Task 4) and `shareClient` POST target (Task 7); `ShareController.create/read` signatures match their test (Task 6).
