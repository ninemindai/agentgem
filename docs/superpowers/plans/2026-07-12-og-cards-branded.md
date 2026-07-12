# Branded OG cards (V1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every shareable AgentGem link (`/games/:key`, `/gems/:key`, `/@handle`, `/skills/:sourceId/*`) unfurls with a branded 1200×630 OG image card, served by a deployment-agnostic core that needs no Cloudflare primitive.

**Architecture:** A runtime-neutral `src/og/` core (resolve route → build meta → inject `<head>` → rasterize SVG→PNG via `@resvg/resvg-wasm`) is deployed by default as express handlers on the aggregator (`installOg`). The core runs in-process, so the HTML and PNG handlers call `buildOgMeta()` directly — no separate meta HTTP endpoint. The Cloudflare Worker is demoted to an optional zero-dep proxy+cache.

**Tech Stack:** TypeScript (Node 24, ESM), express (raw handlers via the aggregator's `expressApp`), `@resvg/resvg-wasm` (already a root dep), `@agentgem/aggregator` + `@agentgem/distribute` (data helpers), vitest.

## Global Constraints

Copied verbatim from the spec / codebase; every task implicitly includes these.

- **Node floor 24, ESM.** Relative imports use the `.js` extension even from `.ts` (e.g. `import { resolveCard } from "./resolve.js"`).
- **Tests run compiled `dist/`, not `src/`.** Always `pnpm build` (`tsc -b`) before `pnpm test`. `src/foo.ts` → `dist/foo.js` (rootDir `src`, outDir `dist`).
- **CI gates only root `dist/__tests__`.** Put every test for this plan under `src/__tests__/` so it lands in CI. (`packages/*/src/__tests__` are NOT run by CI.)
- **Data helpers come from workspace packages:** `buildProfile, getGemArchive, latestGemVersion, archiveOnlyVersion, gemAccessInfo, makeTestDb, upsertGemArchive, upsertCatalogGem, type AppDb` from `@agentgem/aggregator`; `importGem, exportGem` from `@agentgem/distribute`; `type Gem` from `@agentgem/model`.
- **`originGuard` uses EXACT-match `PUBLIC_READ_PATHS`** (`req.path`, no query). Crawlers (no `Sec-Fetch-Site`, no `Origin`) already pass; the `/og/card.png` entry is for headless-browser previewers that send cross-site `Sec-Fetch`.
- **The Cloudflare Worker (`packages/marketplace/src/worker.ts`) MUST keep ZERO `@agentgem` runtime deps** — a value import from an `@agentgem/*` package there breaks `pnpm build`. It stays a `fetch`-and-cache shim.
- **Route shapes are mirrored from `packages/marketplace/src/Router.tsx` (the source of truth):** game `^/games/(.+)$`, gem `^/gems/(.+)$` (note: **plural** `gems`), profile `^/@([^/]+)$`, skill `^/skills/([^/]+)/(.+)$`. Keep `resolveCard` consistent with it.
- **Image is identity-driven:** `/og/card.png?type=&key=` resolves real catalog meta; it never takes free-form title text.
- **Fail open, never 500 the page:** any meta/shell/render error → serve the plain shell (HTML) or a branded placeholder PNG (image). A card bug must never take down the site.

---

### Task 1: Route resolver (`src/og/resolve.ts`)

**Files:**
- Create: `src/og/resolve.ts`
- Test: `src/__tests__/ogResolve.test.ts`

**Interfaces:**
- Produces: `type CardType = "game" | "gem" | "profile" | "skill"`; `interface Card { type: CardType; key: string }`; `function resolveCard(pathname: string): Card | null`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/ogResolve.test.ts
// resolveCard mirrors the entity route shapes in packages/marketplace/src/Router.tsx
// (the source of truth). If a NEW shareable route is added there, add it here too.
import { describe, it, expect } from "vitest";
import { resolveCard } from "../og/resolve.js";

describe("resolveCard", () => {
  it("resolves the four entity shapes", () => {
    expect(resolveCard("/games/@acme/tetris")).toEqual({ type: "game", key: "@acme/tetris" });
    expect(resolveCard("/gems/@acme/toolkit")).toEqual({ type: "gem", key: "@acme/toolkit" });
    expect(resolveCard("/@ada")).toEqual({ type: "profile", key: "ada" });
    expect(resolveCard("/skills/github-xyz/agents/reviewer.md"))
      .toEqual({ type: "skill", key: "github-xyz/agents/reviewer.md" });
  });

  it("decodes percent-escapes in the captured key", () => {
    expect(resolveCard("/gems/@acme%2Ftool")).toEqual({ type: "gem", key: "@acme/tool" });
  });

  it("returns null for collection roots and non-entity paths", () => {
    for (const p of ["/", "/games", "/gems", "/skills", "/api/aggregator/game-meta", "/og/card.png", "/@"]) {
      expect(resolveCard(p)).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogResolve.test.js`
Expected: FAIL — cannot find module `../og/resolve.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/og/resolve.ts
// Resolve an SPA pathname to the entity a shareable link addresses. Route shapes mirror
// packages/marketplace/src/Router.tsx (the source of truth) — keep the two in sync.
export type CardType = "game" | "gem" | "profile" | "skill";
export interface Card { type: CardType; key: string }

function dec(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function resolveCard(pathname: string): Card | null {
  let m: RegExpMatchArray | null;
  if ((m = pathname.match(/^\/games\/(.+)$/))) return { type: "game", key: dec(m[1]) };
  if ((m = pathname.match(/^\/gems\/(.+)$/))) return { type: "gem", key: dec(m[1]) };
  if ((m = pathname.match(/^\/@([^/]+)$/))) return { type: "profile", key: dec(m[1]) };
  if ((m = pathname.match(/^\/skills\/([^/]+)\/(.+)$/))) return { type: "skill", key: `${dec(m[1])}/${dec(m[2])}` };
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogResolve.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/og/resolve.ts src/__tests__/ogResolve.test.ts
git commit -m "feat(og): route resolver for shareable entity links"
```

---

### Task 2: Head injection (`src/og/inject.ts`)

**Files:**
- Create: `src/og/inject.ts`
- Test: `src/__tests__/ogInject.test.ts`

**Interfaces:**
- Produces: `interface OgTagInput { title: string; description: string; url: string; image: string }`; `function ogTags(o: OgTagInput): string`; `function injectHead(shell: string, o: OgTagInput): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/ogInject.test.ts
import { describe, it, expect } from "vitest";
import { injectHead } from "../og/inject.js";

const SHELL = `<!doctype html><html><head><title>AgentGem</title></head><body><div id="root"></div></body></html>`;

describe("injectHead", () => {
  it("rewrites the title and injects large-image OG + twitter tags before </head>", () => {
    const out = injectHead(SHELL, {
      title: "Pizza Panic", description: "Play on AgentGem", url: "https://app.agentgem.ai/games/pizza",
      image: "https://app.agentgem.ai/og/card.png?type=game&key=pizza",
    });
    expect(out).toContain("<title>Pizza Panic — AgentGem</title>");
    expect(out).toContain(`<meta property="og:title" content="Pizza Panic">`);
    expect(out).toContain(`<meta property="og:image" content="https://app.agentgem.ai/og/card.png?type=game&amp;key=pizza">`);
    expect(out).toContain(`<meta name="twitter:card" content="summary_large_image">`);
    expect(out).toContain(`<div id="root"></div>`); // body preserved so React still hydrates
    expect(out.indexOf("og:title")).toBeLessThan(out.indexOf("</head>"));
  });

  it("escapes angle brackets/quotes in text to prevent tag breakout", () => {
    const out = injectHead(SHELL, { title: `A<b>"&`, description: "d", url: "u", image: "i" });
    expect(out).toContain(`content="A&lt;b&gt;&quot;&amp;">`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogInject.test.js`
Expected: FAIL — cannot find module `../og/inject.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/og/inject.ts
// Inject OG/Twitter meta into the SPA shell's <head>. String ops only (the shell is tiny and
// stable); the body is preserved so React still hydrates. Mirrors the shape of
// packages/marketplace/src/worker.ts's original injector, upgraded to summary_large_image.
export interface OgTagInput { title: string; description: string; url: string; image: string }

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export function ogTags(o: OgTagInput): string {
  const t = esc(o.title), d = esc(o.description), u = esc(o.url), img = esc(o.image);
  return (
    `<meta property="og:title" content="${t}">` +
    `<meta property="og:description" content="${d}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:url" content="${u}">` +
    `<meta property="og:image" content="${img}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${t}">` +
    `<meta name="twitter:description" content="${d}">` +
    `<meta name="twitter:image" content="${img}">`
  );
}

export function injectHead(shell: string, o: OgTagInput): string {
  return shell
    .replace(/<title>[^<]*<\/title>/i, `<title>${esc(o.title)} — AgentGem</title>`)
    .replace(/<\/head>/i, `${ogTags(o)}</head>`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogInject.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/og/inject.ts src/__tests__/ogInject.test.ts
git commit -m "feat(og): summary_large_image head injection"
```

---

### Task 3: Branded card SVG (`src/og/card.ts`)

**Files:**
- Create: `src/og/card.ts`
- Test: `src/__tests__/ogCard.test.ts`

**Interfaces:**
- Consumes: `type CardType` from `./resolve.js`.
- Produces: `function renderCardSvg(o: { type: CardType; title: string; subtitle: string }): string`; `function placeholderSvg(): string`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/ogCard.test.ts
import { describe, it, expect } from "vitest";
import { renderCardSvg, placeholderSvg } from "../og/card.js";

describe("renderCardSvg", () => {
  it("renders a 1200x630 SVG with the title, subtitle, per-type label and wordmark", () => {
    const svg = renderCardSvg({ type: "game", title: "Pizza Panic", subtitle: "Play on AgentGem" });
    expect(svg).toContain(`width="1200"`);
    expect(svg).toContain(`height="630"`);
    expect(svg).toContain("Pizza Panic");
    expect(svg).toContain("Play on AgentGem");
    expect(svg).toContain("Miniapp");   // per-type label for game
    expect(svg).toContain("AgentGem");  // wordmark
  });

  it("escapes markup so text cannot break out of the SVG", () => {
    const svg = renderCardSvg({ type: "gem", title: `A & B <x>`, subtitle: `"q"` });
    expect(svg).toContain("A &amp; B &lt;x&gt;");
    expect(svg).not.toContain("<x>");
    expect(svg).toContain("&quot;q&quot;");
  });

  it("caps very long titles with a trailing ellipsis", () => {
    const svg = renderCardSvg({ type: "gem", title: "x".repeat(200), subtitle: "s" });
    expect(svg).toContain("…");
  });

  it("placeholder renders a generic branded card", () => {
    const svg = placeholderSvg();
    expect(svg).toContain(`width="1200"`);
    expect(svg).toContain("AgentGem");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogCard.test.js`
Expected: FAIL — cannot find module `../og/card.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/og/card.ts
// Pure branded card: (type, title, subtitle) -> 1200x630 SVG string. One shared frame + a per-type
// accent/label. Sibling of website/edge/src/card.js's certificate template (kept separate; different
// content). Text is escaped and length-capped before it reaches the SVG.
import type { CardType } from "./resolve.js";

const W = 1200, H = 630;
const BG = "#0b0f17", INK = "#e8edf5", MUTED = "#6b7689";
const ACCENT: Record<CardType, string> = { game: "#7cc4ff", gem: "#c4b5fd", profile: "#86efac", skill: "#fbbf24" };
const LABEL: Record<CardType, string> = { game: "Miniapp", gem: "Gem", profile: "Profile", skill: "Skill" };

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function frame(accent: string, label: string, title: string, subtitle: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>` +
    `<text x="80" y="130" fill="${accent}" font-size="34" font-weight="700" letter-spacing="4">${esc(label.toUpperCase())}</text>` +
    `<text x="80" y="300" fill="${INK}" font-size="76" font-weight="700">${esc(cap(title, 80))}</text>` +
    `<text x="80" y="380" fill="${MUTED}" font-size="40">${esc(cap(subtitle, 120))}</text>` +
    `<text x="80" y="${H - 56}" fill="${MUTED}" font-size="28">agentgem.ai</text>` +
    `<text x="${W - 260}" y="${H - 56}" fill="${accent}" font-size="28" font-weight="700">AgentGem</text>` +
    `</svg>`
  );
}

export function renderCardSvg(o: { type: CardType; title: string; subtitle: string }): string {
  return frame(ACCENT[o.type], LABEL[o.type], o.title, o.subtitle);
}

export function placeholderSvg(): string {
  return frame("#7cc4ff", "AgentGem", "Discover agent gems", "Miniapps, skills & more on AgentGem");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogCard.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/og/card.ts src/__tests__/ogCard.test.ts
git commit -m "feat(og): branded per-type card SVG"
```

---

### Task 4: SVG→PNG rasterizer with embedded font (`src/og/font.ts`, `src/og/raster.ts`)

The certificate card proves `@resvg/resvg-wasm` works in production. resvg-wasm cannot load system fonts, so we embed the SAME font the certificate card uses (`website/edge/assets/card-font.ttf`) as a base64 TS module — no runtime asset file, portable to any deploy. The WASM binary loads from `node_modules` (present in every deploy).

**Files:**
- Create (generated): `src/og/font.ts`
- Create: `src/og/raster.ts`
- Test: `src/__tests__/ogRaster.test.ts`

**Interfaces:**
- Produces: `const CARD_FONT_B64: string` (font.ts); `function renderCardPng(svg: string): Promise<Uint8Array>` (raster.ts).

- [ ] **Step 1: Generate the embedded font module**

Run (from repo root):
```bash
node -e "const fs=require('node:fs');const b=fs.readFileSync('website/edge/assets/card-font.ttf').toString('base64');fs.writeFileSync('src/og/font.ts','// Generated: base64 of website/edge/assets/card-font.ttf (same font as the certificate card).\n// Regenerate with the node one-liner in docs/superpowers/plans/2026-07-12-og-cards-branded.md if the font changes.\nexport const CARD_FONT_B64 =\n  \"'+b+'\";\n')"
```
Expected: `src/og/font.ts` created (one large base64 string export). Verify: `node -e "import('./src/og/font.ts')" ` is not needed — just confirm the file exists and starts with `export const CARD_FONT_B64`.

- [ ] **Step 2: Write the failing test**

```typescript
// src/__tests__/ogRaster.test.ts
import { describe, it, expect } from "vitest";
import { renderCardPng } from "../og/raster.js";
import { renderCardSvg } from "../og/card.js";

describe("renderCardPng", () => {
  it("rasterizes a card SVG to a PNG", async () => {
    const png = await renderCardPng(renderCardSvg({ type: "game", title: "Pizza Panic", subtitle: "Play on AgentGem" }));
    // PNG magic bytes: 89 50 4E 47
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.length).toBeGreaterThan(1000);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogRaster.test.js`
Expected: FAIL — cannot find module `../og/raster.js`.

- [ ] **Step 4: Write minimal implementation**

```typescript
// src/og/raster.ts
// SVG -> PNG via resvg-wasm. wasm + font load once per process. Portable: the font is embedded
// (font.ts) so there is no runtime asset file; the wasm loads from node_modules (present in every
// deploy). Mirrors website/edge/src/raster.js's ensureWasm pattern.
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { CARD_FONT_B64 } from "./font.js";

let ready: Promise<unknown> | undefined;
let fontBytes: Uint8Array | undefined;

async function ensure(): Promise<void> {
  if (!ready) {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    let wasmUrl: string;
    try {
      wasmUrl = (import.meta as unknown as { resolve(s: string): string }).resolve("@resvg/resvg-wasm/index_bg.wasm");
    } catch {
      // dist/og/raster.js -> ../../node_modules resolves to <repo>/node_modules
      wasmUrl = new URL("../../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url).toString();
    }
    const bytes = await readFile(fileURLToPath(wasmUrl));
    ready = initWasm(bytes.buffer);
  }
  if (!fontBytes) fontBytes = Uint8Array.from(Buffer.from(CARD_FONT_B64, "base64"));
  await ready;
}

export async function renderCardPng(svg: string): Promise<Uint8Array> {
  await ensure();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
    font: { fontBuffers: [fontBytes as Uint8Array], defaultFontFamily: "sans-serif", loadSystemFonts: false },
  });
  return resvg.render().asPng();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogRaster.test.js`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add src/og/font.ts src/og/raster.ts src/__tests__/ogRaster.test.ts
git commit -m "feat(og): portable resvg-wasm rasterizer with embedded font"
```

---

### Task 5: Per-type meta providers (`src/og/meta.ts`)

**Files:**
- Create: `src/og/meta.ts`
- Test: `src/__tests__/ogMeta.test.ts`

**Interfaces:**
- Consumes: `type AppDb` from `@agentgem/aggregator`; `type Card` from `./resolve.js`.
- Produces: `interface OgMeta { title: string; description: string; imageUrl: string | null }`; `function buildOgMeta(db: AppDb, card: Card): Promise<OgMeta | null>`.

- [ ] **Step 1: Write the failing test** (uses the existing seed pattern from `gameMeta.controller.test.ts`)

```typescript
// src/__tests__/ogMeta.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertGemArchive, upsertCatalogGem } from "@agentgem/aggregator";
import { exportGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { buildOgMeta } from "../og/meta.js";

function gameGem(name: string, title: string): Gem {
  return { name, createdFrom: { kind: "blank", title }, artifacts: [{
    type: "game", name, title, genre: "project-fun",
    html: "<!doctype html><title>t</title><canvas></canvas>",
    createdFrom: { kind: "blank", title }, engineVersion: "1",
  }], checks: [], requiredSecrets: [] } as unknown as Gem;
}

async function seedGame(db: Awaited<ReturnType<typeof makeTestDb>>, key: string, title: string) {
  const { bytes } = exportGem(gameGem("g", title), { version: "1.0.0" });
  await upsertGemArchive(db, { gemKey: key, version: "1.0.0", bytes, digest: "d", createdAtMs: 1 });
  await upsertCatalogGem(db, { gemKey: key, version: "1.0.0", publishedBy: "acme", author: "acme",
    tags: [], artifactKinds: ["game"], type: "game", artifacts: [{ name: "g", type: "game" }], createdAtMs: 1 });
}

describe("buildOgMeta", () => {
  it("game: title + genre subtitle", async () => {
    const db = await makeTestDb();
    await seedGame(db, "@acme/tetris", "Tetris");
    expect(await buildOgMeta(db, { type: "game", key: "@acme/tetris" }))
      .toEqual({ title: "Tetris", description: "Play on AgentGem · project-fun", imageUrl: null });
  });

  it("game: null for an unknown key", async () => {
    const db = await makeTestDb();
    expect(await buildOgMeta(db, { type: "game", key: "@acme/nope" })).toBeNull();
  });

  it("skill: humanized last path segment, sourceId subtitle (no db needed)", async () => {
    const db = await makeTestDb();
    expect(await buildOgMeta(db, { type: "skill", key: "github-xyz/agents/reviewer.md" }))
      .toEqual({ title: "reviewer", description: "Skill · github-xyz on AgentGem", imageUrl: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogMeta.test.js`
Expected: FAIL — cannot find module `../og/meta.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/og/meta.ts
// Per-type OG metadata providers. game/gem/profile read real catalog/profile data (mirroring
// AggregatorController.gameMeta / .profile); skill is pure string derivation. Returns null for a
// missing/private entity (caller falls through to the plain shell / placeholder). imageUrl is null
// in V1 — the phase-2 hook for captured screenshots.
import type { AppDb } from "@agentgem/aggregator";
import { buildProfile, getGemArchive, latestGemVersion, archiveOnlyVersion, gemAccessInfo } from "@agentgem/aggregator";
import { importGem } from "@agentgem/distribute";
import type { Card } from "./resolve.js";

export interface OgMeta { title: string; description: string; imageUrl: string | null }

type Artifact = { type: string; title?: unknown; genre?: unknown };

async function loadGemArtifacts(db: AppDb, key: string): Promise<Artifact[] | null> {
  const version = (await latestGemVersion(db, key)) ?? (await archiveOnlyVersion(db, key));
  if (!version) return null;
  if ((await gemAccessInfo(db, key, version))?.visibility === "private") return null;
  const a = await getGemArchive(db, key, version);
  if (!a) return null;
  const { gem } = importGem(Buffer.from(a.bytes));
  return (gem as unknown as { artifacts: Artifact[] }).artifacts;
}

async function gameMeta(db: AppDb, key: string): Promise<OgMeta | null> {
  const arts = await loadGemArtifacts(db, key);
  if (!arts) return null;
  const game = arts.find((x) => x.type === "game");
  if (!game || typeof game.title !== "string") return null;
  const genre = typeof game.genre === "string" ? game.genre : null;
  return { title: game.title, description: genre ? `Play on AgentGem · ${genre}` : "Play on AgentGem", imageUrl: null };
}

async function gemMeta(db: AppDb, key: string): Promise<OgMeta | null> {
  const arts = await loadGemArtifacts(db, key);
  if (!arts) return null;
  const kinds = [...new Set(arts.map((x) => x.type))];
  return { title: key, description: kinds.length ? `${kinds.join(" · ")} on AgentGem` : "A gem on AgentGem", imageUrl: null };
}

async function profileMeta(db: AppDb, login: string): Promise<OgMeta | null> {
  const p = await buildProfile(db, login);
  if (!p) return null;
  return { title: `@${p.login}`, description: `${p.gems.length} apps · ${p.reviews.length} reviews on AgentGem`, imageUrl: null };
}

function skillMeta(key: string): OgMeta {
  const i = key.indexOf("/");
  const sourceId = i >= 0 ? key.slice(0, i) : key;
  const path = i >= 0 ? key.slice(i + 1) : "";
  const name = (path.split("/").pop() || path || key).replace(/\.md$/, "");
  return { title: name, description: `Skill · ${sourceId} on AgentGem`, imageUrl: null };
}

export async function buildOgMeta(db: AppDb, card: Card): Promise<OgMeta | null> {
  switch (card.type) {
    case "game": return gameMeta(db, card.key);
    case "gem": return gemMeta(db, card.key);
    case "profile": return profileMeta(db, card.key);
    case "skill": return skillMeta(card.key);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogMeta.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/og/meta.ts src/__tests__/ogMeta.test.ts
git commit -m "feat(og): per-type meta providers (game/gem/profile/skill)"
```

---

### Task 6: Express handlers + wiring helper (`src/og/install.ts`)

**Files:**
- Create: `src/og/install.ts`
- Test: `src/__tests__/ogInstall.test.ts`

**Interfaces:**
- Consumes: `resolveCard, type Card` from `./resolve.js`; `injectHead` from `./inject.js`; `renderCardSvg, placeholderSvg` from `./card.js`; `renderCardPng` from `./raster.js`; `buildOgMeta, type OgMeta` from `./meta.js`; `type AppDb` from `@agentgem/aggregator`.
- Produces:
  - `type GetMeta = (card: Card) => Promise<OgMeta | null>`
  - `function cardImageUrl(origin: string, card: Card): string`
  - `function renderCardResponse(getMeta: GetMeta, card: Card): Promise<Uint8Array>`
  - `function renderEntityHtml(deps: { getMeta: GetMeta; assetOrigin: string; ogImageOrigin: string; fetchImpl: typeof fetch }, pathname: string, pageUrl: string): Promise<string | null>`
  - `function installOg(app: OgExpressApp, deps: { db: AppDb; assetOrigin: string; ogImageOrigin: string }): void`

The pure functions take `getMeta`/`fetchImpl` by injection so they test without a DB or network. `installOg` wires them to express with `buildOgMeta(db, …)` and the global `fetch`.

- [ ] **Step 1: Write the failing test** (stub `getMeta` + stub `fetch`; no DB, no network)

```typescript
// src/__tests__/ogInstall.test.ts
import { describe, it, expect } from "vitest";
import { cardImageUrl, renderCardResponse, renderEntityHtml } from "../og/install.js";
import type { OgMeta } from "../og/meta.js";

const SHELL = `<!doctype html><html><head><title>AgentGem</title></head><body><div id="root"></div></body></html>`;
const fakeFetch = ((_url: string) => Promise.resolve(new Response(SHELL, { status: 200 }))) as unknown as typeof fetch;

describe("cardImageUrl", () => {
  it("builds an identity-driven card URL with an encoded key", () => {
    expect(cardImageUrl("https://app.agentgem.ai", { type: "game", key: "@acme/x" }))
      .toBe("https://app.agentgem.ai/og/card.png?type=game&key=%40acme%2Fx");
  });
});

describe("renderCardResponse", () => {
  it("renders a PNG when meta resolves", async () => {
    const png = await renderCardResponse(async () => ({ title: "Pizza", description: "Play on AgentGem", imageUrl: null }),
      { type: "game", key: "@acme/pizza" });
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  it("renders the placeholder PNG when meta is null", async () => {
    const png = await renderCardResponse(async () => null, { type: "gem", key: "nope" });
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

describe("renderEntityHtml", () => {
  const base = { assetOrigin: "https://assets.example", ogImageOrigin: "https://app.agentgem.ai", fetchImpl: fakeFetch };

  it("injects a card and points og:image at the identity card URL", async () => {
    const html = await renderEntityHtml({ ...base, getMeta: async (): Promise<OgMeta> => ({ title: "Pizza", description: "Play on AgentGem", imageUrl: null }) },
      "/games/@acme/pizza", "https://app.agentgem.ai/games/@acme/pizza");
    expect(html).toContain("<title>Pizza — AgentGem</title>");
    expect(html).toContain(`content="https://app.agentgem.ai/og/card.png?type=game&amp;key=%40acme%2Fpizza"`);
    expect(html).toContain("summary_large_image");
  });

  it("returns null for a non-entity path (caller serves the plain asset)", async () => {
    const html = await renderEntityHtml({ ...base, getMeta: async () => null }, "/api/whatever", "u");
    expect(html).toBeNull();
  });

  it("fails open (null) when meta is null", async () => {
    const html = await renderEntityHtml({ ...base, getMeta: async () => null }, "/games/@acme/x", "u");
    expect(html).toBeNull();
  });

  it("fails open (null) when the shell fetch is not ok", async () => {
    const bad = ((_u: string) => Promise.resolve(new Response("", { status: 502 }))) as unknown as typeof fetch;
    const html = await renderEntityHtml({ ...base, fetchImpl: bad, getMeta: async (): Promise<OgMeta> => ({ title: "P", description: "d", imageUrl: null }) },
      "/games/@acme/x", "u");
    expect(html).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogInstall.test.js`
Expected: FAIL — cannot find module `../og/install.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/og/install.ts
// Deployment-agnostic OG handlers, wired onto the aggregator's express app. renderCardResponse /
// renderEntityHtml take getMeta + fetch by injection so they unit-test with no DB or network;
// installOg binds them to buildOgMeta(db, …) and the global fetch. Fails open everywhere.
import type { AppDb } from "@agentgem/aggregator";
import { resolveCard, type Card, type CardType } from "./resolve.js";
import { injectHead } from "./inject.js";
import { renderCardSvg, placeholderSvg } from "./card.js";
import { renderCardPng } from "./raster.js";
import { buildOgMeta, type OgMeta } from "./meta.js";

export type GetMeta = (card: Card) => Promise<OgMeta | null>;

// Minimal express surface we depend on (avoids importing express types here).
interface OgReq { method: string; path: string; query: Record<string, unknown>; protocol: string; originalUrl: string; get(h: string): string | undefined }
interface OgRes { set(h: string, v: string): OgRes; status(c: number): OgRes; send(b: unknown): void; end(): void }
type OgNext = () => void;
export interface OgExpressApp {
  get(path: string, h: (req: OgReq, res: OgRes) => void): void;
  use(h: (req: OgReq, res: OgRes, next: OgNext) => void): void;
}

const CARD_TYPES: readonly CardType[] = ["game", "gem", "profile", "skill"];
const isCardType = (v: unknown): v is CardType => typeof v === "string" && (CARD_TYPES as readonly string[]).includes(v);

export function cardImageUrl(origin: string, card: Card): string {
  return `${origin}/og/card.png?type=${card.type}&key=${encodeURIComponent(card.key)}`;
}

export async function renderCardResponse(getMeta: GetMeta, card: Card): Promise<Uint8Array> {
  const meta = await getMeta(card).catch(() => null);
  const svg = meta ? renderCardSvg({ type: card.type, title: meta.title, subtitle: meta.description }) : placeholderSvg();
  return renderCardPng(svg);
}

export async function renderEntityHtml(
  deps: { getMeta: GetMeta; assetOrigin: string; ogImageOrigin: string; fetchImpl: typeof fetch },
  pathname: string,
  pageUrl: string,
): Promise<string | null> {
  const card = resolveCard(pathname);
  if (!card) return null;
  const meta = await deps.getMeta(card).catch(() => null);
  if (!meta) return null;
  let shell: string;
  try {
    const r = await deps.fetchImpl(`${deps.assetOrigin}/index.html`);
    if (!r.ok) return null;
    shell = await r.text();
  } catch { return null; }
  const image = meta.imageUrl ?? cardImageUrl(deps.ogImageOrigin, card);
  return injectHead(shell, { title: meta.title, description: meta.description, url: pageUrl, image });
}

export function installOg(app: OgExpressApp, deps: { db: AppDb; assetOrigin: string; ogImageOrigin: string }): void {
  const getMeta: GetMeta = (card) => buildOgMeta(deps.db, card);

  app.get("/og/card.png", (req, res) => {
    void (async () => {
      const { type, key } = req.query;
      if (!isCardType(type) || typeof key !== "string") { res.status(400).end(); return; }
      try {
        const png = await renderCardResponse(getMeta, { type, key });
        res.set("Content-Type", "image/png").set("Cache-Control", "public, max-age=300, s-maxage=3600").send(Buffer.from(png));
      } catch {
        const png = await renderCardPng(placeholderSvg());
        res.set("Content-Type", "image/png").send(Buffer.from(png));
      }
    })();
  });

  app.use((req, res, next) => {
    if (req.method !== "GET" || !resolveCard(req.path)) { next(); return; }
    void (async () => {
      try {
        const pageUrl = `${req.protocol}://${req.get("host") ?? deps.ogImageOrigin}${req.originalUrl}`;
        const html = await renderEntityHtml({ getMeta, assetOrigin: deps.assetOrigin, ogImageOrigin: deps.ogImageOrigin, fetchImpl: fetch }, req.path, pageUrl);
        if (html == null) { next(); return; }
        res.set("Content-Type", "text/html; charset=utf-8").send(html);
      } catch { next(); }
    })();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogInstall.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/og/install.ts src/__tests__/ogInstall.test.ts
git commit -m "feat(og): express card.png + entity-HTML handlers (fail-open)"
```

---

### Task 7: Wire into the aggregator + open the image path in originGuard

**Files:**
- Modify: `src/index.ts` (near `installCatalog(...)`, ~line 290)
- Modify: `src/originGuard.ts:36` (add `/og/card.png` to `PUBLIC_READ_PATHS`)
- Test: `src/__tests__/originGuard.test.ts` (add a case)

**Interfaces:**
- Consumes: `installOg` from `./og/install.js`.

- [ ] **Step 1: Add the failing originGuard test**

Append to `src/__tests__/originGuard.test.ts`:

```typescript
it("allows a cross-site GET of /og/card.png with a wildcard CORS header", () => {
  const req = { method: "GET", path: "/og/card.png", get: (h: string) => (h.toLowerCase() === "sec-fetch-site" ? "cross-site" : undefined) };
  const headers: Record<string, string> = {};
  const res = { set: (k: string, v: string) => { headers[k] = v; }, status: () => res, send: () => {}, json: () => {} };
  let nexted = false;
  // Cast to the guard's param types as the other cases in this file do.
  originGuard(req as never, res as never, () => { nexted = true; });
  expect(nexted).toBe(true);
  expect(headers["Access-Control-Allow-Origin"]).toBe("*");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/originGuard.test.js -t "og/card.png"`
Expected: FAIL — `/og/card.png` not in `PUBLIC_READ_PATHS`, so the cross-site GET is blocked and `next` is never called.

- [ ] **Step 3: Add the path to `PUBLIC_READ_PATHS`**

In `src/originGuard.ts:36`, add `"/og/card.png"` to the `new Set([...])` literal (append before the closing `]`):

```typescript
// ...existing entries..., "/api/sources/import", "/og/card.png"]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/__tests__/originGuard.test.js -t "og/card.png"`
Expected: PASS.

- [ ] **Step 5: Wire `installOg` into `src/index.ts`**

Add the import near the other installers (by `import { installCatalog } from "./catalog/install.js";`, ~line 73):

```typescript
import { installOg } from "./og/install.js";
```

Immediately after the `installCatalog(server.expressApp as never, { db: aggDb, auth, webOrigins });` line (~290), add:

```typescript
// Deployment-agnostic OG cards. assetOrigin = where the built SPA index.html lives; ogImageOrigin =
// the public host whose /og/card.png crawlers fetch. Both default to the public app host and are
// overridable so a non-Cloudflare deploy needs zero code change.
const ogAssetOrigin = process.env.AGENTGEM_ASSET_ORIGIN ?? "https://app.agentgem.ai";
const ogImageOrigin = process.env.AGENTGEM_OG_IMAGE_ORIGIN ?? "https://app.agentgem.ai";
installOg(server.expressApp as never, { db: aggDb, assetOrigin: ogAssetOrigin, ogImageOrigin });
```

- [ ] **Step 6: Build + run the full aggregator suite to confirm no regressions**

Run: `pnpm build && pnpm vitest run dist/__tests__/`
Expected: PASS (all existing tests + the new og* tests).

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/originGuard.ts src/__tests__/originGuard.test.ts
git commit -m "feat(og): wire OG handlers into the aggregator; open /og/card.png in originGuard"
```

---

### Task 8: Cloudflare Worker → optional proxy+cache shim

Replaces the old text-only injector in `packages/marketplace/src/worker.ts`. The Worker now intercepts the entity paths + `/og/*` and proxies them to the aggregator's OG handler with edge caching. It imports **zero `@agentgem` deps** (a `fetch`-and-cache shim), and falls through to `env.ASSETS.fetch` for everything else and on any error. Removing the Worker leaves cards working (uncached) from the origin.

`OG_ORIGIN` MUST be the aggregator's own public origin (e.g. `https://api.agentgem.ai`), NOT the worker's own host `app.agentgem.ai` — proxying to the worker's host would loop.

**Files:**
- Modify: `packages/marketplace/src/worker.ts` (full rewrite of the handler)
- Modify: `packages/marketplace/src/worker.test.ts`
- Modify: `packages/marketplace/wrangler.jsonc` (add the `OG_ORIGIN` var; keep `run_worker_first`)

**Interfaces:**
- Consumes: `env.ASSETS.fetch`, `env.OG_ORIGIN` (string), Cloudflare `caches.default`.

- [ ] **Step 1: Write the failing test**

Rewrite `packages/marketplace/src/worker.test.ts` to the proxy behavior:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "./worker";

// The Worker uses the Cloudflare Cache API (caches.default), absent in the vitest env — stub it.
beforeEach(() => {
  const store = new Map<string, Response>();
  (globalThis as unknown as { caches: { default: Cache } }).caches = {
    default: {
      match: async (k: Request) => store.get(k.url),
      put: async (k: Request, v: Response) => { store.set(k.url, v); },
    },
  } as unknown as { default: Cache };
});

function env(overrides: Partial<{ OG_ORIGIN: string; assets: string }> = {}) {
  return {
    OG_ORIGIN: overrides.OG_ORIGIN ?? "https://api.agentgem.ai",
    ASSETS: { fetch: vi.fn(async () => new Response(overrides.assets ?? "<html>SPA</html>", { status: 200, headers: { "content-type": "text/html" } })) },
  };
}

describe("marketplace worker (proxy+cache shim)", () => {
  it("proxies an entity path to OG_ORIGIN and returns the enriched HTML", async () => {
    const e = env();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>CARD</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const res = await worker.fetch(new Request("https://app.agentgem.ai/games/@acme/pizza"), e as never);
    expect(fetchSpy).toHaveBeenCalledWith("https://api.agentgem.ai/games/@acme/pizza", expect.anything());
    expect(await res.text()).toBe("<html>CARD</html>");
    expect(e.ASSETS.fetch).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("proxies /og/card.png to OG_ORIGIN", async () => {
    const e = env();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("PNGBYTES", { status: 200, headers: { "content-type": "image/png" } }));
    await worker.fetch(new Request("https://app.agentgem.ai/og/card.png?type=game&key=x"), e as never);
    expect(fetchSpy).toHaveBeenCalledWith("https://api.agentgem.ai/og/card.png?type=game&key=x", expect.anything());
    fetchSpy.mockRestore();
  });

  it("falls through to ASSETS for a non-entity path", async () => {
    const e = env();
    await worker.fetch(new Request("https://app.agentgem.ai/gems"), e as never);
    expect(e.ASSETS.fetch).toHaveBeenCalled();
  });

  it("falls through to ASSETS when the origin proxy fails", async () => {
    const e = env();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    await worker.fetch(new Request("https://app.agentgem.ai/games/@acme/x"), e as never);
    expect(e.ASSETS.fetch).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/marketplace build && pnpm --filter @agentgem/marketplace test -- worker`
Expected: FAIL — current `worker.ts` injects rather than proxying; `fetch` to `OG_ORIGIN` is never called.

- [ ] **Step 3: Rewrite `packages/marketplace/src/worker.ts`**

```typescript
// Cloudflare Worker fronting the marketplace's static assets. OPTIONAL acceleration only: it proxies
// the shareable entity paths (/games, /gems, /@handle, /skills) and /og/* to the aggregator's
// deployment-agnostic OG handler (env.OG_ORIGIN) with edge caching, so crawlers get a branded card.
// Everything else — and any error — falls through to env.ASSETS.fetch. Removing this Worker leaves
// cards working (uncached) straight from the origin. ZERO @agentgem imports by design.
//
// OG_ORIGIN MUST be the aggregator's own origin (e.g. https://api.agentgem.ai), never this worker's
// host (app.agentgem.ai) — proxying to our own host would loop.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  OG_ORIGIN?: string;
}

// Mirrors packages/marketplace/src/Router.tsx entity shapes + the /og image route.
const OG_INTERCEPT = [/^\/games\/.+$/, /^\/gems\/.+$/, /^\/@[^/]+$/, /^\/skills\/[^/]+\/.+$/, /^\/og\/.+$/];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const intercept = request.method === "GET" && !!env.OG_ORIGIN && OG_INTERCEPT.some((re) => re.test(url.pathname));
    if (!intercept) return env.ASSETS.fetch(request);

    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      const origin = `${env.OG_ORIGIN}${url.pathname}${url.search}`;
      const res = await fetch(origin, { headers: { "user-agent": request.headers.get("user-agent") ?? "" } });
      if (!res.ok) return env.ASSETS.fetch(request);
      const body = await res.arrayBuffer();
      const out = new Response(body, { status: res.status, headers: res.headers });
      if (res.headers.get("cache-control")) await cache.put(cacheKey, out.clone());
      return out;
    } catch {
      return env.ASSETS.fetch(request);
    }
  },
};
```

- [ ] **Step 4: Add `OG_ORIGIN` to `packages/marketplace/wrangler.jsonc`**

In the `"vars"` object add (keep `run_worker_first: true`):

```jsonc
"vars": {
  // ...existing vars...
  "OG_ORIGIN": "https://api.agentgem.ai"
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/marketplace build && pnpm --filter @agentgem/marketplace test -- worker`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/src/worker.ts packages/marketplace/src/worker.test.ts packages/marketplace/wrangler.jsonc
git commit -m "feat(og): demote marketplace Worker to an optional proxy+cache shim"
```

---

## Deployment notes (not code — for whoever ships this)

- **Env on the aggregator:** `AGENTGEM_ASSET_ORIGIN` (built SPA `index.html` host; default `https://app.agentgem.ai`) and `AGENTGEM_OG_IMAGE_ORIGIN` (public host whose `/og/card.png` crawlers fetch; default `https://app.agentgem.ai`).
- **Sequencing:** deploy the aggregator (Task 7) FIRST so `/og/card.png` and the entity-HTML routes are live before the Worker (Task 8) starts pointing `og:image` at them.
- **Non-Cloudflare hosts:** skip Task 8 entirely; instead add a routing rule that sends `/games/*`, `/gems/*`, `/@*`, `/skills/*`, and `/og/*` to the aggregator OG handler, and everything else to static assets. That single rule is the only platform-specific piece.
- **Validation (manual, deploy-gated):** confirm live unfurls with the X, Facebook, and LinkedIn card debuggers — the same caveat the certificate card carries. Watch for edge-cache staleness (a changed title/play-count is stale until the `s-maxage=3600` TTL).

## Self-Review

- **Spec coverage:** portable core (T1–T4) ✓; per-type meta incl. the corrected `/gems` + new `/skills`, leaderboard dropped (T1, T5) ✓; identity-driven `/og/card.png` (T6) ✓; in-process meta, no separate og-meta HTTP endpoint (spec's YAGNI note) ✓; `summary_large_image` (T2) ✓; fail-open everywhere (T6) ✓; originGuard public-read for the image (T7) ✓; optional zero-dep CF adapter (T8) ✓; phase-2 `imageUrl` hook (T5 returns `imageUrl:null`, T6 prefers it) ✓; deploy sequencing + neutral routing requirement (Deployment notes) ✓.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `Card`/`CardType` (T1) used unchanged through T5/T6/T8; `OgMeta` (T5) consumed in T6; `renderCardSvg({type,title,subtitle})` signature identical in T3/T4/T6; `renderCardPng` identical in T4/T6; `resolveCard` identical in T1/T6/T8 (T8 re-expresses the same regexes in the Worker, which must have zero `@agentgem` imports — intentional duplication, noted).
