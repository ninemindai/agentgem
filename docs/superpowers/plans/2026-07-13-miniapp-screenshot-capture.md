# Miniapp screenshot capture (OG cards V2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A miniapp's OG card shows a real screenshot of the game — captured client-side in the Studio preview at publish time, stored per `(gemKey, version)`, and composited into the existing branded `/og/card.png`.

**Architecture:** Backend first (all CI-testable): a `gem_covers` `bytea` table, a one-field `coverDataUrl` addition to the publish chain, and a cover-aware `/og/card.png` that embeds the screenshot as a resvg `<image>`. Then the console capture UI: a capture shim in the sealed `sandboxDoc`, a `requestCapture()` on `Runner`, and a capture-confirm step in `Studio`.

**Tech Stack:** TypeScript (Node 24, ESM), drizzle + Postgres (`bytea`), `@resvg/resvg-wasm`, React (console), vitest.

## Global Constraints

- **Node 24, ESM.** Relative imports use `.js` even from `.ts`.
- **Root aggregator tests run compiled `dist/`; CI gates root `dist/__tests__`.** Always `pnpm build` before `pnpm vitest run dist/...`. Put backend tests under `src/__tests__/`.
- **Console + marketplace tests are NOT in CI** (run locally). Console tests: `pnpm --filter @agentgem/console test`.
- **Depends on V1** ([[og-cards-branded]], merged): `src/og/{resolve,meta,card,install,raster}.ts`, `/og/card.png`, and its fail-open contract. Do not change `og-meta`'s returned `imageUrl` (stays `null` for game) — the screenshot enriches what `/og/card.png` *draws*, via a separate cover lookup.
- **Cover is cosmetic, NOT signed** into the manifest digest (Decision A). It rides the already-authenticated `publish-gem` request. A bad/oversized cover must NEVER fail the gem publish (Decision B / error handling).
- **Games only.** `gemMeta`/`profileMeta`/`skillMeta` unchanged.
- **Cover size cap 512 KB; content-type allowlist `image/png`, `image/jpeg`, `image/webp`.**
- **Fail open** everywhere on the render side (V1 rule): no cover / DB error / bad data → the existing synthetic card renders unchanged.
- Helper import sources: `getGemArchive, latestGemVersion, archiveOnlyVersion, gemAccessInfo, type AppDb, makeTestDb, upsertGemArchive, upsertCatalogGem` from `@agentgem/aggregator`; `importGem, exportGem` from `@agentgem/distribute`; `type Gem` from `@agentgem/model`.

---

### Task 1: `gem_covers` storage (schema + helpers)

**Files:**
- Modify: `packages/aggregator/src/schema.ts` (add `gemCovers` pgTable near `gemArchives:313`; add DDL in `ensureSchema` near `:636`)
- Modify: `packages/aggregator/src/catalog.ts` (add `upsertGemCover`/`getGemCover`; extend the `schema.js` import at `:9`)
- Test: `src/__tests__/gemCovers.test.ts`

**Interfaces:**
- Produces: `upsertGemCover(db, { gemKey, version, bytes, contentType, createdAtMs }): Promise<void>`; `getGemCover(db, gemKey, version): Promise<{ bytes: Uint8Array; contentType: string } | null>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/gemCovers.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertGemCover, getGemCover } from "@agentgem/aggregator";

describe("gem_covers storage", () => {
  it("round-trips cover bytes + content type by (gemKey, version)", async () => {
    const db = await makeTestDb();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await upsertGemCover(db, { gemKey: "@acme/tetris", version: "1.0.0", bytes, contentType: "image/png", createdAtMs: 5 });
    const got = await getGemCover(db, "@acme/tetris", "1.0.0");
    expect(got?.contentType).toBe("image/png");
    expect(got ? [...got.bytes] : null).toEqual([...bytes]);
    expect(await getGemCover(db, "@acme/tetris", "9.9.9")).toBeNull();
  });

  it("upsert overwrites an existing cover for the same key+version", async () => {
    const db = await makeTestDb();
    await upsertGemCover(db, { gemKey: "@a/b", version: "1", bytes: new Uint8Array([1]), contentType: "image/png", createdAtMs: 1 });
    await upsertGemCover(db, { gemKey: "@a/b", version: "1", bytes: new Uint8Array([2, 2]), contentType: "image/webp", createdAtMs: 2 });
    const got = await getGemCover(db, "@a/b", "1");
    expect(got?.contentType).toBe("image/webp");
    expect(got ? [...got.bytes] : null).toEqual([2, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/gemCovers.test.js`
Expected: FAIL — `upsertGemCover`/`getGemCover` not exported.

- [ ] **Step 3: Add the `gemCovers` table** — in `packages/aggregator/src/schema.ts`, immediately after the `gemArchives` table (ends at `:321`), add (reuses the module-scoped `bytea` customType defined at `:308`):

```typescript
// Per-(gem_key, version) cover image for OG cards — a screenshot captured at publish time. Cosmetic:
// NOT part of the signed manifest/gemDigest. Streamed only as pixels composited inside /og/card.png.
export const gemCovers = pgTable("gem_covers", {
  gemKey: text("gem_key").notNull(),
  version: text("version").notNull(),
  bytes: bytea("bytes").notNull(),
  contentType: text("content_type").notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
}, (t) => [primaryKey({ columns: [t.gemKey, t.version] })]);
```

- [ ] **Step 4: Add the DDL in `ensureSchema`** — in the same file, inside `ensureSchema` (after the `gem_adoptions` block around `:640`, before the `account_scopes` line), add:

```typescript
  await db.execute(sql`create table if not exists gem_covers (gem_key text not null, version text not null, bytes bytea not null, content_type text not null, created_at_ms bigint not null, primary key (gem_key, version))`);
```

- [ ] **Step 5: Add the helpers** — in `packages/aggregator/src/catalog.ts`, add `gemCovers` to the `./schema.js` import (`:9`) and append these functions (mirroring `upsertGemArchive`/`getGemArchive` at `:74-83`):

```typescript
export async function upsertGemCover(db: AppDb, c: { gemKey: string; version: string; bytes: Uint8Array; contentType: string; createdAtMs: number }): Promise<void> {
  await db.insert(gemCovers).values({ gemKey: c.gemKey, version: c.version, bytes: c.bytes, contentType: c.contentType, createdAtMs: c.createdAtMs })
    .onConflictDoUpdate({ target: [gemCovers.gemKey, gemCovers.version], set: { bytes: c.bytes, contentType: c.contentType, createdAtMs: c.createdAtMs } });
}

export async function getGemCover(db: AppDb, gemKey: string, version: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const r = (await db.select({ bytes: gemCovers.bytes, contentType: gemCovers.contentType }).from(gemCovers)
    .where(and(eq(gemCovers.gemKey, gemKey), eq(gemCovers.version, version))).limit(1))[0];
  return r ? { bytes: r.bytes, contentType: r.contentType } : null;
}
```

Confirm both are re-exported through `packages/aggregator/src/index.ts` (the barrel that already exports `upsertGemArchive`/`getGemArchive`); add them there if the barrel lists exports explicitly.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/__tests__/gemCovers.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/aggregator/src/schema.ts packages/aggregator/src/catalog.ts packages/aggregator/src/index.ts src/__tests__/gemCovers.test.ts
git commit -m "feat(og): gem_covers table + upsert/get helpers"
```

---

### Task 2: `coverDataUrl` parse/build util (`src/og/coverDataUrl.ts`)

**Files:**
- Create: `src/og/coverDataUrl.ts`
- Test: `src/__tests__/ogCoverDataUrl.test.ts`

**Interfaces:**
- Produces:
  - `const COVER_MAX_BYTES = 512 * 1024`; `const COVER_TYPES = ["image/png","image/jpeg","image/webp"] as const`
  - `parseImageDataUrl(s: string): { contentType: string; bytes: Uint8Array } | null` — null on non-image, disallowed type, malformed base64, or > `COVER_MAX_BYTES`.
  - `toDataUrl(contentType: string, bytes: Uint8Array): string`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/ogCoverDataUrl.test.ts
import { describe, it, expect } from "vitest";
import { parseImageDataUrl, toDataUrl, COVER_MAX_BYTES } from "../og/coverDataUrl.js";

const b64 = (b: number[]) => Buffer.from(b).toString("base64");

describe("parseImageDataUrl", () => {
  it("parses an allowed image data URL to {contentType, bytes}", () => {
    const r = parseImageDataUrl(`data:image/png;base64,${b64([0x89, 0x50, 1])}`);
    expect(r?.contentType).toBe("image/png");
    expect(r ? [...r.bytes] : null).toEqual([0x89, 0x50, 1]);
  });
  it("rejects a disallowed content type", () => {
    expect(parseImageDataUrl(`data:image/svg+xml;base64,${b64([1])}`)).toBeNull();
    expect(parseImageDataUrl(`data:text/html;base64,${b64([1])}`)).toBeNull();
  });
  it("rejects a non-data / malformed string", () => {
    expect(parseImageDataUrl("https://x/y.png")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64,")).toBeNull();
    expect(parseImageDataUrl("")).toBeNull();
  });
  it("rejects an oversized payload", () => {
    const big = Buffer.alloc(COVER_MAX_BYTES + 1).toString("base64");
    expect(parseImageDataUrl(`data:image/png;base64,${big}`)).toBeNull();
  });
});

describe("toDataUrl", () => {
  it("round-trips with parseImageDataUrl", () => {
    const url = toDataUrl("image/webp", new Uint8Array([1, 2, 3]));
    expect(url.startsWith("data:image/webp;base64,")).toBe(true);
    expect(parseImageDataUrl(url)).toEqual({ contentType: "image/webp", bytes: new Uint8Array([1, 2, 3]) });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogCoverDataUrl.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/og/coverDataUrl.ts
// Parse/build image data URLs for miniapp cover screenshots. Used on the store side (publishGem parses
// the client's coverDataUrl) and the render side (getCoverDataUri rebuilds one from stored bytes).
export const COVER_MAX_BYTES = 512 * 1024;
export const COVER_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const RE = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

export function parseImageDataUrl(s: string): { contentType: string; bytes: Uint8Array } | null {
  const m = typeof s === "string" ? s.match(RE) : null;
  if (!m) return null;
  const contentType = m[1];
  if (!(COVER_TYPES as readonly string[]).includes(contentType)) return null;
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(Buffer.from(m[2], "base64")); } catch { return null; }
  if (bytes.length === 0 || bytes.length > COVER_MAX_BYTES) return null;
  return { contentType, bytes };
}

export function toDataUrl(contentType: string, bytes: Uint8Array): string {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogCoverDataUrl.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/og/coverDataUrl.ts src/__tests__/ogCoverDataUrl.test.ts
git commit -m "feat(og): image data-URL parse/build util for covers"
```

---

### Task 3: `publish-gem` stores the cover (best-effort)

**Files:**
- Modify: `src/aggregator.controller.ts` (`PublishGemBody:151`; `publishGem:326-341`; imports at `:21`, `:28`)
- Test: `src/__tests__/publishGemCover.test.ts`

**Interfaces:**
- Consumes: `upsertGemCover, getGemCover` (Task 1), `parseImageDataUrl` (Task 2).
- Produces: `PublishGemBody` gains optional `coverDataUrl`; `publishGem` stores a valid cover after the archive.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/publishGemCover.test.ts
// Reuses the EXACT signed-body + bound-producer pattern from
// src/aggregator/__tests__/publishGem.controller.test.ts (do not invent signing).
import { describe, it, expect } from "vitest";
import { makeTestDb, producers, accountBindings, accounts, getGemCover } from "@agentgem/aggregator";
import { AggregatorController } from "../aggregator.controller.js";
import { signer, gameGem, signedPublishBody } from "../aggregator/__tests__/helpers/publishFixtures.js";

// Copied verbatim from publishGem.controller.test.ts:8-17 — binds the signer's pubkey to a seeded
// account so recordCatalogShare resolves an owner (else the publish is rejected "not-connected").
async function boundDb() {
  const db = await makeTestDb();
  const s = signer();
  await db.insert(producers).values({ pubkey: s.pubkey });
  await db.insert(accounts).values({ id: crypto.randomUUID(), provider: "github", providerAccountId: "1", login: "octocat" });
  await db.insert(accountBindings).values({ pubkey: s.pubkey, provider: "github", accountId: "1", accountLogin: "octocat" });
  return { db, s };
}

function bodyWithCover(s: ReturnType<typeof signer>, coverDataUrl?: string) {
  const base = signedPublishBody(gameGem(), s, { gemKey: "@octocat/tetris", version: "1.0.0", signedAt: Date.now() });
  return { ...base, ...(coverDataUrl ? { coverDataUrl } : {}) };
}

describe("publishGem cover", () => {
  it("stores a valid cover after the archive", async () => {
    const { db, s } = await boundDb();
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]).toString("base64")}`;
    const res = await new AggregatorController(db).publishGem({ body: bodyWithCover(s, png) as never });
    expect(res).toMatchObject({ shared: true, publishedBy: "octocat" });
    const cover = await getGemCover(db, "@octocat/tetris", "1.0.0");
    expect(cover?.contentType).toBe("image/png");
  });

  it("ignores an invalid cover WITHOUT failing the publish", async () => {
    const { db, s } = await boundDb();
    const res = await new AggregatorController(db).publishGem({ body: bodyWithCover(s, "data:text/html;base64,AAAA") as never });
    expect(res).toMatchObject({ shared: true });      // publish still succeeds
    expect(await getGemCover(db, "@octocat/tetris", "1.0.0")).toBeNull();
  });

  it("publishes fine with no cover", async () => {
    const { db, s } = await boundDb();
    const res = await new AggregatorController(db).publishGem({ body: bodyWithCover(s, undefined) as never });
    expect(res).toMatchObject({ shared: true });
  });
});
```

> `signedPublishBody` (in `publishFixtures.ts`) returns extra `bytes`/`gemDigest` fields alongside `{manifest, archiveBase64, pubkey, signedAt, signature}`; the controller ignores them, exactly as `publishGem.controller.test.ts` already relies on. The `as never` cast is only needed until Step 3 adds `coverDataUrl` to `PublishGemBody`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/publishGemCover.test.js`
Expected: FAIL — `coverDataUrl` not accepted / cover not stored.

- [ ] **Step 3: Extend `PublishGemBody`** (`src/aggregator.controller.ts:151`):

```typescript
const PublishGemBody = z.object({ manifest: CatalogManifestSchema, archiveBase64: z.string(), pubkey: z.string(), signedAt: z.number(), signature: z.string(), coverDataUrl: z.string().optional() });
```

- [ ] **Step 4: Store the cover in `publishGem`** — add `upsertGemCover` to the `@agentgem/aggregator` import at `:21` and `parseImageDataUrl` from `"./og/coverDataUrl.js"`. Then after the existing `upsertGemArchive(...)` call (`:339`) and before the `return`, add:

```typescript
    // Cover is cosmetic and unsigned (Decision A): store it best-effort, NEVER fail the publish over it.
    if (input.body.coverDataUrl) {
      const cover = parseImageDataUrl(input.body.coverDataUrl);
      if (cover) {
        try {
          await upsertGemCover(this.db, { gemKey: r.gemKey, version: r.version, bytes: cover.bytes, contentType: cover.contentType, createdAtMs: Date.now() });
        } catch { /* cover is decorative; a store failure must not fail the gem publish */ }
      }
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/__tests__/publishGemCover.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/aggregator.controller.ts src/__tests__/publishGemCover.test.ts
git commit -m "feat(og): publish-gem accepts + best-effort stores a cover"
```

---

### Task 4: Cover-aware card SVG (`src/og/card.ts`)

**Files:**
- Modify: `src/og/card.ts`
- Test: `src/__tests__/ogCard.test.ts` (extend the existing file)

**Interfaces:**
- Produces: `renderCardSvg(o: { type: CardType; title: string; subtitle: string; screenshotDataUri?: string }): string` — when `screenshotDataUri` is present, the screenshot is the full-bleed hero with a legibility band + title + wordmark; otherwise unchanged.

- [ ] **Step 1: Write the failing test** (append to `src/__tests__/ogCard.test.ts`)

```typescript
describe("renderCardSvg with a screenshot", () => {
  const shot = "data:image/png;base64,iVBORw0KGgo=";
  it("embeds the screenshot as an <image> hero with title + wordmark over a legibility band", () => {
    const svg = renderCardSvg({ type: "game", title: "Pizza Panic", subtitle: "Play on AgentGem", screenshotDataUri: shot });
    expect(svg).toContain(`<image href="${shot}"`);
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(svg).toContain("Pizza Panic");
    expect(svg).toContain("AgentGem");
    expect(svg).toContain("opacity"); // the semi-opaque legibility band behind the text
  });
  it("falls back to the synthetic frame when no screenshot is given", () => {
    const svg = renderCardSvg({ type: "game", title: "Pizza", subtitle: "Play on AgentGem" });
    expect(svg).not.toContain("<image");
    expect(svg).toContain("Miniapp"); // the per-type label frame
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogCard.test.js`
Expected: FAIL — `screenshotDataUri` ignored, no `<image>`.

- [ ] **Step 3: Implement** — in `src/og/card.ts`, add a `hero()` builder and branch `renderCardSvg`:

```typescript
// Screenshot-hero variant: the captured game fills the card (cover-cropped), with a semi-opaque band
// at the bottom carrying the title + AgentGem wordmark so text stays legible over any screenshot.
// The data URI is pre-validated base64 (parseImageDataUrl), so it needs no attribute escaping.
function hero(accent: string, title: string, screenshotDataUri: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">` +
    `<rect width="${W}" height="${H}" fill="${BG}"/>` +
    `<image href="${screenshotDataUri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>` +
    `<rect x="0" y="470" width="${W}" height="160" fill="${BG}" opacity="0.82"/>` +
    `<text x="80" y="548" fill="${INK}" font-size="60" font-weight="700">${esc(cap(title, 60))}</text>` +
    `<text x="80" y="600" fill="${MUTED}" font-size="30">agentgem.ai</text>` +
    `<text x="${W - 260}" y="600" fill="${accent}" font-size="28" font-weight="700">AgentGem</text>` +
    `</svg>`
  );
}

export function renderCardSvg(o: { type: CardType; title: string; subtitle: string; screenshotDataUri?: string }): string {
  if (o.screenshotDataUri) return hero(ACCENT[o.type], o.title, o.screenshotDataUri);
  return frame(ACCENT[o.type], LABEL[o.type], o.title, o.subtitle);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogCard.test.js`
Expected: PASS (existing 4 + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/og/card.ts src/__tests__/ogCard.test.ts
git commit -m "feat(og): screenshot-hero card variant"
```

---

### Task 5: `getCoverDataUri` + cover-aware `/og/card.png`

**Files:**
- Create: `src/og/cover.ts`
- Modify: `src/og/install.ts` (`renderCardResponse` gains a `getCover` param; `installOg` binds it and passes it to the `/og/card.png` handler)
- Test: `src/__tests__/ogCover.test.ts`, `src/__tests__/ogInstall.test.ts` (extend)

**Interfaces:**
- Produces: `getCoverDataUri(db: AppDb, card: Card): Promise<string | null>` (game only); `type GetCover = (card: Card) => Promise<string | null>`; `renderCardResponse(getMeta, getCover, card)`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/ogCover.test.ts
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertGemArchive, upsertCatalogGem, upsertGemCover } from "@agentgem/aggregator";
import { exportGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";
import { getCoverDataUri } from "../og/cover.js";

function gameGem(title: string): Gem {
  return { name: "g", createdFrom: { kind: "blank", title }, artifacts: [{
    type: "game", name: "g", title, genre: "project-fun",
    html: "<!doctype html><title>t</title><canvas></canvas>", createdFrom: { kind: "blank", title }, engineVersion: "1",
  }], checks: [], requiredSecrets: [] } as unknown as Gem;
}
async function seed(db: Awaited<ReturnType<typeof makeTestDb>>, key: string, cover?: boolean) {
  const { bytes } = exportGem(gameGem("T"), { version: "1.0.0" });
  await upsertGemArchive(db, { gemKey: key, version: "1.0.0", bytes, digest: "d", createdAtMs: 1 });
  await upsertCatalogGem(db, { gemKey: key, version: "1.0.0", publishedBy: "a", author: "a", tags: [], artifactKinds: ["game"], type: "game", artifacts: [{ name: "g", type: "game" }], createdAtMs: 1 });
  if (cover) await upsertGemCover(db, { gemKey: key, version: "1.0.0", bytes: new Uint8Array([0x89, 0x50, 1]), contentType: "image/png", createdAtMs: 1 });
}

describe("getCoverDataUri", () => {
  it("returns a data URI for a game with a stored cover", async () => {
    const db = await makeTestDb(); await seed(db, "@a/g", true);
    const uri = await getCoverDataUri(db, { type: "game", key: "@a/g" });
    expect(uri?.startsWith("data:image/png;base64,")).toBe(true);
  });
  it("returns null for a game with no cover", async () => {
    const db = await makeTestDb(); await seed(db, "@a/g", false);
    expect(await getCoverDataUri(db, { type: "game", key: "@a/g" })).toBeNull();
  });
  it("returns null for non-game types", async () => {
    const db = await makeTestDb();
    expect(await getCoverDataUri(db, { type: "gem", key: "@a/g" })).toBeNull();
    expect(await getCoverDataUri(db, { type: "skill", key: "s/x.md" })).toBeNull();
  });
});
```

```typescript
// append to src/__tests__/ogInstall.test.ts
import type { OgMeta } from "../og/meta.js";
describe("renderCardResponse with a cover", () => {
  it("composites the screenshot when getCover returns a data URI", async () => {
    const meta: OgMeta = { title: "Pizza", description: "Play on AgentGem", imageUrl: null };
    const png = await renderCardResponse(async () => meta, async () => "data:image/png;base64,iVBORw0KGgo=", { type: "game", key: "@a/g" });
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]); // valid PNG (composited)
  });
  it("renders the synthetic card when getCover returns null", async () => {
    const meta: OgMeta = { title: "Pizza", description: "Play on AgentGem", imageUrl: null };
    const png = await renderCardResponse(async () => meta, async () => null, { type: "game", key: "@a/g" });
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
```

Update the existing `renderCardResponse` calls in `ogInstall.test.ts` (the two from V1) to pass a third `getCover` stub `async () => null` between `getMeta` and `card`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogCover.test.js dist/__tests__/ogInstall.test.js`
Expected: FAIL — `getCoverDataUri` missing / `renderCardResponse` arity.

- [ ] **Step 3: Implement `getCoverDataUri`**

```typescript
// src/og/cover.ts
// The captured cover screenshot for a game card, as a data URI (or null). Resolves the same latest/
// archive version gameMeta does, honors the private-visibility gate, and only ever returns for games.
import type { AppDb } from "@agentgem/aggregator";
import { getGemCover, latestGemVersion, archiveOnlyVersion, gemAccessInfo } from "@agentgem/aggregator";
import type { Card } from "./resolve.js";
import { toDataUrl } from "./coverDataUrl.js";

export async function getCoverDataUri(db: AppDb, card: Card): Promise<string | null> {
  if (card.type !== "game") return null;
  const version = (await latestGemVersion(db, card.key)) ?? (await archiveOnlyVersion(db, card.key));
  if (!version) return null;
  if ((await gemAccessInfo(db, card.key, version))?.visibility === "private") return null;
  const cover = await getGemCover(db, card.key, version);
  return cover ? toDataUrl(cover.contentType, cover.bytes) : null;
}
```

- [ ] **Step 4: Thread `getCover` through `install.ts`** — add the import and type, extend `renderCardResponse`, and bind it in `installOg`:

```typescript
// add to imports:
import { getCoverDataUri } from "./cover.js";
// add near GetMeta:
export type GetCover = (card: Card) => Promise<string | null>;
```

Change `renderCardResponse` to take `getCover` and pass the screenshot into `renderCardSvg`:

```typescript
export async function renderCardResponse(getMeta: GetMeta, getCover: GetCover, card: Card): Promise<Uint8Array> {
  const meta = await getMeta(card).catch(() => null);
  const screenshotDataUri = (await getCover(card).catch(() => null)) ?? undefined;
  const svg = meta
    ? renderCardSvg({ type: card.type, title: meta.title, subtitle: meta.description, screenshotDataUri })
    : placeholderSvg();
  return renderCardPng(svg);
}
```

In `installOg`, bind `getCover` and pass it in the `/og/card.png` handler's call:

```typescript
  const getMeta: GetMeta = (card) => buildOgMeta(deps.db, card);
  const getCover: GetCover = (card) => getCoverDataUri(deps.db, card);
  // ... inside app.get("/og/card.png", ...): 
  //     const png = await renderCardResponse(getMeta, getCover, { type, key });
```

(Change ONLY the `renderCardResponse(getMeta, { type, key })` call to `renderCardResponse(getMeta, getCover, { type, key })`. The placeholder fallback path is unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm build && pnpm vitest run dist/__tests__/ogCover.test.js dist/__tests__/ogInstall.test.js dist/__tests__/ogCard.test.js`
Expected: PASS (all, including the updated V1 renderCardResponse cases).

- [ ] **Step 6: Commit**

```bash
git add src/og/cover.ts src/og/install.ts src/__tests__/ogCover.test.ts src/__tests__/ogInstall.test.ts
git commit -m "feat(og): /og/card.png composites a stored cover when present"
```

---

### Task 6: Publish payload plumbing (console → aggregator)

**Files:**
- Modify: `packages/console/src/api/routes.ts` (`publishSetupRoute` body, `:805`)
- Modify: `src/schemas.ts` (`PlaybookPublishBodySchema`, `:586`)
- Modify: `src/gem.controller.ts` (`publishSetup`, `:626` — thread `b.coverDataUrl` into `postGemPublish`)
- Modify: `src/gem/gemPublishClient.ts` (`postGemPublish`, `:26` — accept + POST `coverDataUrl`)
- Test: `src/__tests__/gemPublishClientCover.test.ts`

**Interfaces:**
- Produces: `coverDataUrl?: string` on the publish-setup body and `postGemPublish` args; forwarded into the `publish-gem` POST body.

- [ ] **Step 1: Write the failing test** (verifies the client forwards the cover into the POST body via a stub `http`)

```typescript
// src/__tests__/gemPublishClientCover.test.ts
import { describe, it, expect } from "vitest";
import { postGemPublish } from "../gem/gemPublishClient.js";
import type { Identity } from "@agentgem/model";

const identity = { publicKey: "pk", sign: () => "sig" } as unknown as Identity;
const manifest = { gemKey: "@a/g", version: "1.0.0" } as never;

describe("postGemPublish coverDataUrl", () => {
  it("includes coverDataUrl in the POST body when provided", async () => {
    let sent: Record<string, unknown> = {};
    const http = async (_url: string, init: { body: string }) => { sent = JSON.parse(init.body); return { status: 200, json: async () => ({ shared: true, publishedBy: "a" }) }; };
    await postGemPublish({ manifest, archiveBase64: "AAA", identity, http: http as never, now: () => 1, coverDataUrl: "data:image/png;base64,AAAA" });
    expect(sent.coverDataUrl).toBe("data:image/png;base64,AAAA");
    expect(sent.manifest).toBeDefined(); // manifest still sent alongside (cover is NOT in the signed payload)
  });
  it("omits coverDataUrl when not provided", async () => {
    let sent: Record<string, unknown> = {};
    const http = async (_url: string, init: { body: string }) => { sent = JSON.parse(init.body); return { status: 200, json: async () => ({ shared: true, publishedBy: "a" }) }; };
    await postGemPublish({ manifest, archiveBase64: "AAA", identity, http: http as never, now: () => 1 });
    expect("coverDataUrl" in sent).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run dist/__tests__/gemPublishClientCover.test.js`
Expected: FAIL — `coverDataUrl` not in the body.

- [ ] **Step 3: `postGemPublish`** (`src/gem/gemPublishClient.ts`) — add `coverDataUrl?: string` to the args object type (`:26-28`) and include it in the POST body only when present (`:36`):

```typescript
export async function postGemPublish(args: {
  manifest: CatalogManifest; archiveBase64: string; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number; coverDataUrl?: string;
}): Promise<{ shared: true; publishedBy: string } | { shared: false; rejected: string }> {
  // ...unchanged up to the body...
  const res = await http(`${base}/api/aggregator/publish-gem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: args.manifest, archiveBase64: args.archiveBase64, pubkey: args.identity.publicKey, signedAt: now, signature, ...(args.coverDataUrl ? { coverDataUrl: args.coverDataUrl } : {}) }),
  });
  // ...unchanged...
}
```

- [ ] **Step 4: `publishSetup`** (`src/gem.controller.ts:642`) — pass the cover through:

```typescript
        const r = await postGemPublish({ manifest, archiveBase64: bytes.toString("base64"), identity, coverDataUrl: b.coverDataUrl });
```

- [ ] **Step 5: `PlaybookPublishBodySchema`** (`src/schemas.ts:586`) — add the field:

```typescript
export const PlaybookPublishBodySchema = z.object({
  workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(),
  description: z.string().optional(), tags: z.array(z.string()).optional(), provenance: z.string(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  coverDataUrl: z.string().optional(),
});
```

- [ ] **Step 6: `publishSetupRoute` body** (`packages/console/src/api/routes.ts:805`) — mirror the field so the client type carries it:

```typescript
  body: z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), description: z.string().optional(), tags: z.array(z.string()).optional(), provenance: z.string(), visibility: z.enum(["public", "unlisted", "private"]).optional(), coverDataUrl: z.string().optional() }),
```

- [ ] **Step 7: Run tests + full aggregator build**

Run: `pnpm build && pnpm vitest run dist/__tests__/gemPublishClientCover.test.js && pnpm build`
Expected: client test PASS; full `tsc -b` clean (the console route + schema changes typecheck).

- [ ] **Step 8: Commit**

```bash
git add src/gem/gemPublishClient.ts src/gem.controller.ts src/schemas.ts packages/console/src/api/routes.ts src/__tests__/gemPublishClientCover.test.ts
git commit -m "feat(og): thread coverDataUrl through the publish chain"
```

---

### Task 7: Capture shim in the sealed preview (`sandboxDoc`)

**Files:**
- Modify: `packages/console/src/panels/Watch/sandboxDoc.ts`
- Test: `packages/console/src/panels/Watch/__tests__/sandboxDoc.capture.test.ts`

**Interfaces:**
- Produces: `sandboxDoc(html)` now injects a `CAPTURE_SHIM` script that, on `postMessage({type:"agentgem:capture"})` from the parent, replies `postMessage({type:"agentgem:capture-result", ok, dataUrl?, reason?})`.

- [ ] **Step 1: Write the failing test** — the shim is an inline string; test the string contains the contract, and (since jsdom can't paint) unit-test the *selection/serialization logic* by extracting it into a pure exported helper the shim calls.

Extract a pure helper and test it:

```typescript
// packages/console/src/panels/Watch/__tests__/sandboxDoc.capture.test.ts
import { describe, it, expect } from "vitest";
import { sandboxDoc } from "../sandboxDoc.js";
import { pickCaptureCanvas } from "../captureCanvas.js";

describe("capture shim wiring", () => {
  it("injects the capture shim + its message contract into the sealed doc", () => {
    const doc = sandboxDoc("<canvas></canvas>");
    expect(doc).toContain("agentgem:capture");
    expect(doc).toContain("agentgem:capture-result");
  });
});

describe("pickCaptureCanvas", () => {
  const c = (w: number, h: number) => ({ getBoundingClientRect: () => ({ width: w, height: h }) }) as unknown as HTMLCanvasElement;
  it("picks the largest-area canvas", () => {
    const small = c(10, 10), big = c(400, 300);
    expect(pickCaptureCanvas([small, big])).toBe(big);
  });
  it("returns null for an empty list", () => {
    expect(pickCaptureCanvas([])).toBeNull();
  });
  it("ignores zero-area canvases", () => {
    expect(pickCaptureCanvas([c(0, 0)])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agentgem/console build && pnpm --filter @agentgem/console test -- sandboxDoc.capture`
Expected: FAIL — `captureCanvas.js` missing, shim not injected.

- [ ] **Step 3: Add the pure helper**

```typescript
// packages/console/src/panels/Watch/captureCanvas.ts
// Pure selection logic for the capture shim: pick the largest visible canvas (ties → first in DOM order).
// Kept out of the inline shim string so it is unit-testable; the shim inlines an equivalent tiny loop.
export function pickCaptureCanvas(canvases: HTMLCanvasElement[]): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null, bestArea = 0;
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) { best = c; bestArea = area; }
  }
  return best;
}
```

- [ ] **Step 4: Add the shim** — in `sandboxDoc.ts`, add a `CAPTURE_SHIM` constant (mirrors the `STORAGE_SHIM`/`ANCHOR_SHIM` inline-script style) and include it in `head` (after `ANCHOR_SHIM`):

```typescript
// Publish-time screenshot capture. On the parent's request, pick the largest visible <canvas>, serialize
// it to a PNG data URL, and post it back on a channel SEPARATE from the MCP-Apps protocol (so a game's
// capability surface is untouched). WebGL canvases without preserveDrawingBuffer serialize blank — the
// host's confirm UI + manual-upload fallback cover that; we do not touch the game's context.
const CAPTURE_SHIM =
  "<script>(function(){window.addEventListener('message',function(e){" +
  "if(!e.data||e.data.type!=='agentgem:capture')return;" +
  "try{var cs=document.querySelectorAll('canvas');var best=null,ba=0;" +
  "for(var i=0;i<cs.length;i++){var r=cs[i].getBoundingClientRect();var a=r.width*r.height;if(a>ba){best=cs[i];ba=a;}}" +
  "if(!best||ba===0){parent.postMessage({type:'agentgem:capture-result',ok:false,reason:'no-canvas'},'*');return;}" +
  "var u=best.toDataURL('image/png');" +
  "if(!u||u.length<64){parent.postMessage({type:'agentgem:capture-result',ok:false,reason:'blank'},'*');return;}" +
  "parent.postMessage({type:'agentgem:capture-result',ok:true,dataUrl:u},'*');" +
  "}catch(err){parent.postMessage({type:'agentgem:capture-result',ok:false,reason:'error'},'*');}});})();</script>";
```

And in `sandboxDoc`, extend the head: `const head = \`...${STORAGE_SHIM}${ANCHOR_SHIM}${CAPTURE_SHIM}\`;`.

> The `u.length<64` check is a cheap blank-heuristic proxy (an empty/degenerate canvas serializes to a tiny data URL). The real gate is the human confirm in Task 8.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @agentgem/console build && pnpm --filter @agentgem/console test -- sandboxDoc.capture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/panels/Watch/sandboxDoc.ts packages/console/src/panels/Watch/captureCanvas.ts packages/console/src/panels/Watch/__tests__/sandboxDoc.capture.test.ts
git commit -m "feat(og): capture shim in the sealed miniapp preview"
```

---

### Task 8: `requestCapture` + Studio capture-confirm UX

Console UI — NOT in CI; verify locally (`pnpm --filter @agentgem/console test` + manual). This is the fiddliest task: it wires an imperative capture call from `Studio` into the `Runner` iframe and inserts a capture-confirm step before publish.

**Files:**
- Modify: `packages/console/src/panels/Play/Runner.tsx` (expose `requestCapture()` via `forwardRef`/`useImperativeHandle`)
- Modify: `packages/console/src/panels/Play/Studio.tsx` (hold a `runnerRef`; capture-confirm banner; thread `coverDataUrl` into `publishWorkspace` → `publishSetupRoute`)
- Test: `packages/console/src/panels/Play/__tests__/StudioShare.test.tsx` (extend — assert the cover threads into the publish body)

**Interfaces:**
- Consumes: the `agentgem:capture`/`agentgem:capture-result` channel (Task 7); `publishSetupRoute` body's `coverDataUrl` (Task 6).
- Produces: `Runner` exposes `requestCapture(): Promise<{ ok: boolean; dataUrl?: string; reason?: string }>`.

- [ ] **Step 1: `Runner.requestCapture`** — convert `Runner` to `forwardRef` and add:

```tsx
// Post a capture request to the sealed frame and await its one-shot reply on the dedicated channel
// (separate from the MCP host listener). Times out to {ok:false}.
useImperativeHandle(ref, () => ({
  requestCapture(): Promise<{ ok: boolean; dataUrl?: string; reason?: string }> {
    const target = iframeRef.current?.contentWindow;
    if (!target) return Promise.resolve({ ok: false, reason: "no-frame" });
    return new Promise((resolve) => {
      const onMsg = (e: MessageEvent) => {
        if (!e.data || e.data.type !== "agentgem:capture-result") return;
        window.removeEventListener("message", onMsg); clearTimeout(timer);
        resolve({ ok: !!e.data.ok, dataUrl: e.data.dataUrl, reason: e.data.reason });
      };
      const timer = setTimeout(() => { window.removeEventListener("message", onMsg); resolve({ ok: false, reason: "timeout" }); }, 3000);
      window.addEventListener("message", onMsg);
      target.postMessage({ type: "agentgem:capture" }, "*");
    });
  },
}), []);
```

Export the handle type: `export interface RunnerHandle { requestCapture(): Promise<{ ok: boolean; dataUrl?: string; reason?: string }> }` and wrap the component with `forwardRef<RunnerHandle, Props>`. Keep all existing props/behavior; the MCP host listener effect is unchanged (the capture channel is a separate, temporary listener that filters on `agentgem:capture-result`, which the MCP host ignores).

- [ ] **Step 2: `Studio` — hold a ref + capture-confirm state.** Add `const runnerRef = useRef<RunnerHandle>(null);` and pass it to the rendered `<Runner ref={runnerRef} ... />` (locate the existing `<Runner .../>` render site in Studio.tsx). Add state:

```tsx
const [cover, setCover] = useState<string | null>(null);          // accepted coverDataUrl to publish
const [coverPreview, setCoverPreview] = useState<string | null>(null); // shown in the confirm banner
const [captureBusy, setCaptureBusy] = useState(false);
```

- [ ] **Step 3: `Studio` — capture step before publish.** In `shareToExplore`, after `save()` succeeds and before `checkAndPublish`, request a capture and show the preview banner (do NOT block publish on capture):

```tsx
  async function shareToExplore() {
    setStatus("preparing…"); setShare(null); setPendingVersion(null); setCover(null); setCoverPreview(null);
    if (!(await save())) return;
    setCaptureBusy(true);
    const cap = await runnerRef.current?.requestCapture();
    setCaptureBusy(false);
    if (cap?.ok && cap.dataUrl) setCoverPreview(cap.dataUrl); // author confirms in the banner (Step 4)
    if (!(identity?.bound && identity.login)) { setStatus(""); setPendingPublish(true); return; }
    await checkAndPublish(identity.login);
  }
```

Thread `cover` into `publishWorkspace`'s `publishSetupRoute.call(...)` body: add `coverDataUrl: cover ?? undefined` to the `body` object (`Studio.tsx:284`).

- [ ] **Step 4: `Studio` — the capture-confirm banner.** Render a banner (near the `pendingVersion` banner, same `play-banner` style) when `coverPreview` is set, with a thumbnail `<img src={coverPreview}>` and four controls:
  - **Use this** → `setCover(coverPreview); setCoverPreview(null);`
  - **Re-capture** → `setCaptureBusy(true); const c = await runnerRef.current?.requestCapture(); setCaptureBusy(false); if (c?.ok && c.dataUrl) setCoverPreview(c.dataUrl);`
  - **Upload** → an `<input type="file" accept="image/png,image/jpeg,image/webp">`; on change, read via the `FileReader.readAsDataURL` pattern from `packages/marketplace/src/upload.ts` (keep the FULL data URL — do NOT strip the prefix — since the server parses `data:type;base64,…`), `setCover(dataUrl); setCoverPreview(null);`
  - **Skip** → `setCover(null); setCoverPreview(null);`

Enforce the client-side 512 KB cap on both captured and uploaded covers (reject + message if `dataUrl.length` exceeds ~700 KB of base64 ≈ 512 KB binary); this mirrors the server cap so an oversized cover never round-trips.

- [ ] **Step 5: Extend the Studio test** — in `StudioShare.test.tsx`, add a case that mocks `runnerRef`'s capture to return a data URL, drives the share flow, and asserts the `publishSetupRoute` call body includes `coverDataUrl`. (Follow the existing test's mocking of `publishSetupRoute.call`.)

Run: `pnpm --filter @agentgem/console test -- StudioShare`
Expected: PASS (existing cases + the cover case).

- [ ] **Step 6: Local verification (manual — no CI coverage):** `pnpm --filter @agentgem/console build`, run the console, open Studio with a canvas mini-game, click Share → confirm the thumbnail appears with Use/Re-capture/Upload/Skip, publish, and confirm the published game's `/og/card.png` composites the screenshot (or falls back cleanly on Skip / a WebGL-blank capture).

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Play/Runner.tsx packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/__tests__/StudioShare.test.tsx
git commit -m "feat(og): capture-confirm UX in Studio publish; Runner.requestCapture"
```

---

## Self-Review

- **Spec coverage:** capture shim + human-confirm + manual upload (T7, T8) ✓; composite into branded card.png via resvg `<image>` (T4, T5) ✓; `gem_covers` bytea storage (T1) ✓; cover NOT signed / best-effort store never fails publish (T3) ✓; games only (T5 `getCoverDataUri` type guard) ✓; `og-meta` unchanged / `imageUrl` still null (T5 keeps card.png the image URL) ✓; private-gem cover not served (T5 `gemAccessInfo` gate) ✓; 512 KB cap + type allowlist (T2, enforced T3 + T8) ✓; fail-open render (T5 `.catch(()=>null)`) ✓; one-field `coverDataUrl` plumbing (T6) ✓.
- **Placeholder scan:** none — T3's signed-body construction now uses the real `signedPublishBody`/`gameGem`/`boundDb` fixtures from `publishGem.controller.test.ts` verbatim. Every step has complete code.
- **Type consistency:** `renderCardSvg` gains an optional `screenshotDataUri` (T4) consumed by `renderCardResponse` (T5); `getCoverDataUri(db, card)`/`GetCover` (T5) match; `coverDataUrl` is the single field name across route body, `PlaybookPublishBodySchema`, `postGemPublish`, `PublishGemBody`, and `publishGem` (T3, T6); `upsertGemCover`/`getGemCover` shapes identical across T1/T3/T5; `parseImageDataUrl`/`toDataUrl` (T2) used by T3 and T5.
- **CI note:** T1–T6 land under root `dist/__tests__` (CI-gated). T7 is console-tested (not CI). T8 is console-tested + manual (React iframe messaging can't be fully unit-tested) — the plan flags this explicitly and puts it last so the CI-covered backend is solid first.
