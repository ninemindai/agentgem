# Gem Share Card (fast-follow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second share-card **kind** (`gem`) — a hosted, link-unfurlable teaser (name + provenance, no image) — and move the per-workflow "Share" / per-build "Share gem" buttons off the local-canvas path onto it, reusing the polished share row.

**Architecture:** Reuse the certificate `/share` spine end-to-end; make the create body a discriminated union (`certificate` | `gem`). Backend stores gem `{name, provenance}` in a new nullable `payload` column; the Worker renders a text-only OG unfurl (`twitter:card=summary`, no `og:image`) for gem records; the console mints a hosted URL per item and shows the shared `ShareLinks` row.

**Tech Stack:** TypeScript + `@agentback/{rest,openapi,drizzle}` + Drizzle/Postgres (pglite in tests); plain-JS Cloudflare Worker; React + esbuild + vitest/jsdom console.

## Global Constraints

- **PREREQUISITE: PR #35 (`feat/share-ui-polish`) must be merged first.** This plan extracts the polished share row introduced there (`.scorecard-share-links`/`.scorecard-intent` markup + CSS) into a shared component and reuses its spinner/pending pattern. **Rebase this branch onto post-#35 `main` before executing.**
- **No per-gem image.** Gem unfurl is text only: `og:title`=name, `og:description`=provenance, `twitter:card=summary`, **no `og:image`**. No gem SVG, no edge rasterization. `og.png` stays certificate-only.
- **Teaser only.** No gem install, no gem bytes, no registry publish (all deferred).
- **Discriminated by `kind`.** Existing `kind:"certificate"` rows/paths must keep working unchanged.
- **Gem payload:** `{ name, provenance }`, both strings. `name` ≤120 chars, `provenance` ≤200 chars, both trimmed + control-chars stripped server-side. Closed zod (`.strict()`), never `.loose()`.
- **Privacy:** store only name + provenance (user-chosen); no raw logs, no step dumps, no project paths.
- **Provenance copy:** workflow → `"Distilled from <N> session(s)"`; build → `"<N> skill(s)"`.
- **Tests:** backend in `src/**/__tests__/*.test.ts` (run via `pnpm build && pnpm exec vitest run dist/...`). Worker JS in `website/edge/**/*.test.js` (`pnpm exec vitest run website/edge`). Console in `packages/console/src/**/*.test.{ts,tsx}` (`pnpm --filter @agentgem/console exec vitest run`) — also run `pnpm --filter @agentgem/console typecheck`.
- **Commits:** body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; git author `Raymond Feng <raymond@ninemind.ai>` (`-c user.name=... -c user.email=...`).

---

### Task 1: `share_cards` — add `payload`, relax `counts`

**Files:**
- Modify: `src/aggregator/schema.ts` (table def + `ensureSchema`)
- Test: `src/aggregator/__tests__/shareSchema.test.ts` (extend)

**Interfaces:**
- Produces: `shareCards.payload` jsonb column (nullable), typed `{name:string;provenance:string} | null`; `counts` now nullable.

- [ ] **Step 1: Write the failing test** — append to `src/aggregator/__tests__/shareSchema.test.ts`:

```ts
import { shareCards } from "../schema.js";
import { sql } from "drizzle-orm";
import { makeTestDb } from "../testDb.js";

it("stores a gem row (payload set, counts null)", async () => {
  const db = await makeTestDb();
  await db.insert(shareCards).values({
    id: "gem1234567", kind: "gem", counts: null,
    payload: { name: "my-workflow", provenance: "Distilled from 5 sessions" },
    generatedAtMs: 111, createdAtMs: 222,
  });
  const rows = await db.select().from(shareCards).where(sql`id = 'gem1234567'`);
  expect(rows[0].payload).toEqual({ name: "my-workflow", provenance: "Distilled from 5 sessions" });
  expect(rows[0].counts).toBeNull();
});
```

- [ ] **Step 2: Run — expect FAIL** (`payload` not a column / not nullable):

Run: `pnpm build && pnpm exec vitest run dist/aggregator/__tests__/shareSchema.test.js`
Expected: FAIL (`payload` unknown, or counts NOT NULL violation).

- [ ] **Step 3: Implement** — in `src/aggregator/schema.ts`, change the `shareCards` table:

```ts
export const shareCards = pgTable("share_cards", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  counts: jsonb("counts").$type<{ breadth: number; battleTested: number; portable: number }>(),
  payload: jsonb("payload").$type<{ name: string; provenance: string }>(),
  generatedAtMs: bigint("generated_at_ms", { mode: "number" }).notNull(),
  createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
});
```

(Removed `.notNull()` from `counts`; added nullable `payload`.) Then in `ensureSchema`, after the `create table if not exists share_cards (...)` line, add idempotent migrations:

```ts
  await db.execute(sql`alter table share_cards add column if not exists payload jsonb`);
  await db.execute(sql`alter table share_cards alter column counts drop not null`);
```

- [ ] **Step 4: Run — expect PASS** (both the new gem row test and the existing certificate test):

Run: `pnpm build && pnpm exec vitest run dist/aggregator/__tests__/shareSchema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aggregator/schema.ts src/aggregator/__tests__/shareSchema.test.ts
git commit -m "feat(share): share_cards gains nullable payload (gem); counts nullable"
```

---

### Task 2: `shareStore` — discriminated create/read

**Files:**
- Modify: `src/share/shareStore.ts`
- Test: `src/share/__tests__/shareStore.test.ts` (create if absent)

**Interfaces:**
- Consumes: `shareCards` (Task 1).
- Produces: `CreateInput` union; `ShareRecord` union; `createShareCard(db, input): {id,url}`; `getShareCard(db, id): ShareRecord | null`.

- [ ] **Step 1: Write the failing test** — `src/share/__tests__/shareStore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeTestDb } from "../../aggregator/testDb.js";
import { createShareCard, getShareCard } from "../shareStore.js";

describe("shareStore gem", () => {
  it("creates + reads a gem record", async () => {
    const db = await makeTestDb();
    const { id, url } = await createShareCard(db, { kind: "gem", name: "wf", provenance: "Distilled from 5 sessions", generatedAtMs: 5 });
    expect(url).toBe(`https://agentgem.ai/share/${id}`);
    const rec = await getShareCard(db, id);
    expect(rec).toMatchObject({ kind: "gem", name: "wf", provenance: "Distilled from 5 sessions" });
  });
  it("still creates + reads a certificate record", async () => {
    const db = await makeTestDb();
    const { id } = await createShareCard(db, { kind: "certificate", counts: { breadth: 1, battleTested: 1, portable: 1 }, generatedAtMs: 5 });
    expect((await getShareCard(db, id))!.kind).toBe("certificate");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (gem not supported):

Run: `pnpm build && pnpm exec vitest run dist/share/__tests__/shareStore.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** — replace the types + functions in `src/share/shareStore.ts` (keep `genShareId`, `SHARE_BASE`, imports):

```ts
export type ShareCounts = { breadth: number; battleTested: number; portable: number };
export type GemPayload = { name: string; provenance: string };

export type CreateInput =
  | { kind: "certificate"; counts: ShareCounts; generatedAtMs: number }
  | { kind: "gem"; name: string; provenance: string; generatedAtMs: number };

export type ShareRecord =
  | { kind: "certificate"; counts: ShareCounts; generatedAtMs: number; createdAtMs: number }
  | { kind: "gem"; name: string; provenance: string; generatedAtMs: number; createdAtMs: number };

export async function createShareCard(db: AppDb, input: CreateInput): Promise<{ id: string; url: string }> {
  const id = genShareId();
  const row = {
    id, kind: input.kind, generatedAtMs: input.generatedAtMs, createdAtMs: Date.now(),
    counts: input.kind === "certificate" ? input.counts : null,
    payload: input.kind === "gem" ? { name: input.name, provenance: input.provenance } : null,
  };
  await db.insert(shareCards).values(row);
  return { id, url: `${SHARE_BASE}/share/${id}` };
}

export async function getShareCard(db: AppDb, id: string): Promise<ShareRecord | null> {
  const rows = await db.select().from(shareCards).where(sql`id = ${id}`);
  if (rows.length === 0) return null;
  const r = rows[0];
  const base = { generatedAtMs: Number(r.generatedAtMs), createdAtMs: Number(r.createdAtMs) };
  if (r.kind === "gem") {
    const p = r.payload as GemPayload;
    return { kind: "gem", name: p.name, provenance: p.provenance, ...base };
  }
  return { kind: "certificate", counts: r.counts as ShareCounts, ...base };
}
```

- [ ] **Step 4: Run — expect PASS** (gem + certificate):

Run: `pnpm build && pnpm exec vitest run dist/share/__tests__/shareStore.test.js dist/share/__tests__/shareController.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/share/shareStore.ts src/share/__tests__/shareStore.test.ts
git commit -m "feat(share): shareStore discriminated certificate|gem create/read"
```

---

### Task 3: `ShareController` — discriminated union body + sanitize

**Files:**
- Modify: `src/share.controller.ts`
- Test: `src/share/__tests__/shareController.test.ts` (extend)

**Interfaces:**
- Consumes: `createShareCard`/`getShareCard` (Task 2).
- Produces: `POST /api/aggregator/share` accepting `certificate` | `gem`; `GET` returns the discriminated record.

- [ ] **Step 1: Write the failing test** — append to `src/share/__tests__/shareController.test.ts`:

```ts
it("creates + reads a gem card, sanitizing name/provenance", async () => {
  const db = await makeTestDb();
  const c = new ShareController(db);
  const { id } = await c.create({ body: { kind: "gem", name: "  my wf\x07 ", provenance: "Distilled from 5 sessions", generatedAtMs: 1 } as never });
  const rec = await c.read({ query: { id } });
  expect(rec).toMatchObject({ kind: "gem", name: "my wf", provenance: "Distilled from 5 sessions" });
});
it("rejects an empty gem name and over-length provenance", async () => {
  const db = await makeTestDb();
  const c = new ShareController(db);
  await expect(c.create({ body: { kind: "gem", name: "", provenance: "x", generatedAtMs: 1 } as never })).rejects.toThrow();
  await expect(c.create({ body: { kind: "gem", name: "ok", provenance: "x".repeat(201), generatedAtMs: 1 } as never })).rejects.toThrow();
});
```

- [ ] **Step 2: Run — expect FAIL** (gem kind rejected by the certificate-only schema):

Run: `pnpm build && pnpm exec vitest run dist/share/__tests__/shareController.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `src/share.controller.ts`, replace the schemas + `create`/`read`:

```ts
const sanitize = (s: string) => s.replace(/[\u0000-\u001f]/g, "").trim();

const Counts = z.object({
  breadth: z.number().int().nonnegative(),
  battleTested: z.number().int().nonnegative(),
  portable: z.number().int().nonnegative(),
}).strict();
const CertBody = z.object({ kind: z.literal("certificate"), counts: Counts, generatedAtMs: z.number().int().nonnegative() }).strict();
const GemBody = z.object({
  kind: z.literal("gem"),
  name: z.string().transform(sanitize).pipe(z.string().min(1).max(120)),
  provenance: z.string().transform(sanitize).pipe(z.string().max(200)),
  generatedAtMs: z.number().int().nonnegative(),
}).strict();
const CreateBody = z.discriminatedUnion("kind", [CertBody, GemBody]);
const CreateResult = z.object({ id: z.string(), url: z.string() });
const ReadQuery = z.object({ id: z.string() });
const ReadResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("certificate"), counts: Counts, generatedAtMs: z.number(), createdAtMs: z.number() }),
  z.object({ kind: z.literal("gem"), name: z.string(), provenance: z.string(), generatedAtMs: z.number(), createdAtMs: z.number() }),
]);
```

`create` keeps `const body = CreateBody.parse(input.body); return createShareCard(this.db, body);`. `read` is unchanged (still throws the 404 AgentError on miss). Confirm `create`/`read` generic types use `z.infer<typeof CreateBody>` / `z.infer<typeof ReadResult>`.

- [ ] **Step 4: Run — expect PASS** (gem create/read + sanitize + rejections + the existing certificate tests):

Run: `pnpm build && pnpm exec vitest run dist/share/__tests__/shareController.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/share.controller.ts src/share/__tests__/shareController.test.ts
git commit -m "feat(share): ShareController accepts gem kind (sanitized name/provenance)"
```

---

### Task 4: `shareClient` + `ShareProxyController` — pass through the discriminated body

**Files:**
- Modify: `src/gem/shareClient.ts`, `src/share.proxy.controller.ts`
- Test: `src/gem/__tests__/shareClient.test.ts` (extend)

**Interfaces:**
- Produces: `postShare({ body, endpoint?, http? })` where `body` is the discriminated create body; proxy `POST /api/share` accepts the union.

- [ ] **Step 1: Write the failing test** — append to `src/gem/__tests__/shareClient.test.ts`:

```ts
it("forwards a gem body verbatim", async () => {
  let sent = "";
  const http = async (_u: string, init: { body: string }) => { sent = init.body; return { status: 200, json: async () => ({ id: "g", url: "u" }) }; };
  await postShare({ body: { kind: "gem", name: "wf", provenance: "Distilled from 5 sessions", generatedAtMs: 9 }, endpoint: "https://api.test", http });
  expect(JSON.parse(sent)).toEqual({ kind: "gem", name: "wf", provenance: "Distilled from 5 sessions", generatedAtMs: 9 });
});
```

(Also update the existing certificate tests in this file: they call `postShare({ counts, generatedAtMs, ... })`; change them to `postShare({ body: { kind: "certificate", counts, generatedAtMs }, ... })`.)

- [ ] **Step 2: Run — expect FAIL** (postShare signature is counts-based):

Run: `pnpm build && pnpm exec vitest run dist/gem/__tests__/shareClient.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `src/gem/shareClient.ts`, change `postShare` to forward a caller-supplied body (keep `DEFAULT_AGGREGATOR_URL`, `resolveBase`, `defaultHttp`):

```ts
type CreateBody =
  | { kind: "certificate"; counts: { breadth: number; battleTested: number; portable: number }; generatedAtMs: number }
  | { kind: "gem"; name: string; provenance: string; generatedAtMs: number };

export async function postShare(args: {
  body: CreateBody; endpoint?: string; http?: ShareHttp;
}): Promise<{ id: string; url: string } | { skipped: true }> {
  const base = resolveBase(args.endpoint);
  if (!base) return { skipped: true };
  const http = args.http ?? defaultHttp;
  const res = await http(`${base}/api/aggregator/share`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args.body),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`share ${res.status}`);
  const b = (await res.json()) as { id?: string; url?: string };
  if (!b.id || !b.url) throw new Error("share: response missing id/url");
  return { id: b.id, url: b.url };
}
```

In `src/share.proxy.controller.ts`, accept the union body and forward it:

```ts
const Counts = z.object({ breadth: z.number().int().nonnegative(), battleTested: z.number().int().nonnegative(), portable: z.number().int().nonnegative() }).strict();
const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("certificate"), counts: Counts, generatedAtMs: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("gem"), name: z.string().min(1).max(120), provenance: z.string().max(200), generatedAtMs: z.number().int().nonnegative() }).strict(),
]);
// in create():
const r = await postShare({ body: input.body });
if ("skipped" in r) throw new Error("sharing is disabled (AGENTGEM_AGGREGATOR_URL set empty)");
return r;
```

(Note: the hero's certificate caller must now send `{kind:"certificate", counts, generatedAtMs}` — handled in Task 6's route.)

- [ ] **Step 4: Run — expect PASS:**

Run: `pnpm build && pnpm exec vitest run dist/gem/__tests__/shareClient.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gem/shareClient.ts src/share.proxy.controller.ts src/gem/__tests__/shareClient.test.ts
git commit -m "feat(share): proxy + shareClient pass through certificate|gem body"
```

---

### Task 5: Worker — gem text unfurl + route branch

**Files:**
- Modify: `website/edge/src/share.js`
- Test: `website/edge/src/share.test.js` (extend)

**Interfaces:**
- Consumes: the backend gem record shape `{kind:"gem", name, provenance}`.
- Produces: `renderGemShareHtml(record, { shareUrl }): string`; `handleShare` routes by `record.kind`; gem `og.png` → 404.

- [ ] **Step 1: Write the failing test** — append to `website/edge/src/share.test.js`:

```js
import { renderGemShareHtml } from "./share.js";
describe("gem unfurl", () => {
  it("is a text summary card (no og:image)", () => {
    const html = renderGemShareHtml({ kind: "gem", name: "my-wf", provenance: "Distilled from 5 sessions" }, { shareUrl: "https://agentgem.ai/share/g" });
    expect(html).toContain('<meta property="og:title" content="my-wf">');
    expect(html).toContain('<meta property="og:description" content="Distilled from 5 sessions">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
    expect(html).not.toContain("og:image");
    expect(html).toContain("agentgem.ai");
  });
  it("handleShare routes a gem record to the gem unfurl, og.png 404s", async () => {
    const rec = { kind: "gem", name: "my-wf", provenance: "Distilled from 5 sessions", generatedAtMs: 1, createdAtMs: 2 };
    const env = { AGGREGATOR_API: "https://api.test", fetch: async () => ({ ok: true, json: async () => rec }) };
    const page = await handleShare(new Request("https://agentgem.ai/share/g"), env);
    expect(await page.text()).toContain("twitter:card");
    const png = await handleShare(new Request("https://agentgem.ai/share/g/og.png"), env);
    expect(png.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`renderGemShareHtml` undefined):

Run: `pnpm exec vitest run website/edge/src/share.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `website/edge/src/share.js`, add the gem renderer (reuse `esc`, `CANONICAL`):

```js
export function renderGemShareHtml(record, { shareUrl }) {
  const name = esc(record.name), prov = esc(record.provenance);
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>${name} — AgentGem</title>` +
    `<meta property="og:title" content="${name}">` +
    `<meta property="og:description" content="${prov}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:url" content="${esc(shareUrl)}">` +
    `<meta name="twitter:card" content="summary">` +
    `<meta name="twitter:title" content="${name}">` +
    `<meta name="twitter:description" content="${prov}">` +
    `</head><body style="font-family:sans-serif;background:#0b0f17;color:#e8edf5;text-align:center;padding:48px">` +
    `<h1 style="font-size:34px;margin:0 0 8px">${name}</h1>` +
    `<p style="font-size:18px;color:#9aa">${prov}</p>` +
    `<p><a style="color:#7cc4ff;font-size:22px" href="${CANONICAL}">Value your own agent goldmine →</a></p>` +
    `</body></html>`;
}
```

Then branch in `handleShare` — replace the `if (parsed.png) {...}` + final return block:

```js
  if (record.kind === "gem") {
    if (parsed.png) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    const shareUrl = `${CANONICAL}/share/${parsed.id}`;
    const html = renderGemShareHtml(record, { shareUrl });
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
  }

  if (parsed.png) {
    const png = await rasterizeCard(record.counts);
    return new Response(png, { status: 200, headers: { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" } });
  }
  const shareUrl = `${CANONICAL}/share/${parsed.id}`;
  const html = renderShareHtml(record, { ogImageUrl: `${shareUrl}/og.png`, shareUrl });
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
```

- [ ] **Step 4: Run — expect PASS** (full edge suite):

Run: `pnpm exec vitest run website/edge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add website/edge/src/share.js website/edge/src/share.test.js
git commit -m "feat(share): Worker renders gem text unfurl (summary, no image); og.png gem 404"
```

---

### Task 6: Console — `createGemShareRoute` + certificate caller update

**Files:**
- Modify: `packages/console/src/api/routes.ts`, `packages/console/src/panels/Mine/Scorecard.tsx`
- Test: covered by Task 7/8 console tests.

**Interfaces:**
- Produces: `createGemShareRoute` (POST `/api/share`, gem body). Certificate caller now sends `{kind:"certificate", ...}`.

- [ ] **Step 1: Add the gem route + update the certificate route body** — in `packages/console/src/api/routes.ts`, replace `createShareRoute` and add the gem route:

```ts
export const createShareRoute = defineRoute("POST", "/api/share", {
  body: z.object({
    kind: z.literal("certificate"),
    counts: z.object({ breadth: z.number(), battleTested: z.number(), portable: z.number() }),
    generatedAtMs: z.number(),
  }),
  response: z.object({ id: z.string(), url: z.string() }),
});
export const createGemShareRoute = defineRoute("POST", "/api/share", {
  body: z.object({ kind: z.literal("gem"), name: z.string(), provenance: z.string(), generatedAtMs: z.number() }),
  response: z.object({ id: z.string(), url: z.string() }),
});
```

- [ ] **Step 2: Update the hero's certificate create call** — in `packages/console/src/panels/Mine/Scorecard.tsx`, the `doCreate` body must now include `kind`. Change the default `createShare` and the call site so the body is `{ kind: "certificate", counts, generatedAtMs: data.generatedAtMs }`. (The `CreateShare` type's body param gains `kind: "certificate"`.)

- [ ] **Step 3: Run the console typecheck** to confirm the route/body change compiles:

Run: `pnpm --filter @agentgem/console typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Mine/Scorecard.tsx
git commit -m "feat(share): createGemShareRoute + certificate body carries kind"
```

---

### Task 7: Console — extract `ShareLinks` component

**Files:**
- Create: `packages/console/src/panels/Mine/ShareLinks.tsx`, `packages/console/src/panels/Mine/__tests__/ShareLinks.test.tsx`
- Modify: `packages/console/src/panels/Mine/Scorecard.tsx`

**Interfaces:**
- Produces: `ShareLinks({ url }: { url: string })` — renders the copy-link (+ "Copied") row and the X/LinkedIn/Facebook intents, using the `.scorecard-share-links` markup/classes from #35.

- [ ] **Step 1: Write the failing test** — `packages/console/src/panels/Mine/__tests__/ShareLinks.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ShareLinks } from "../ShareLinks.js";

describe("ShareLinks", () => {
  it("shows the url, copies it, and links each platform with the encoded url", () => {
    render(<ShareLinks url="https://agentgem.ai/share/abc" />);
    expect((screen.getByLabelText(/share link/i) as HTMLInputElement).value).toBe("https://agentgem.ai/share/abc");
    expect(screen.getByRole("link", { name: "X" }).getAttribute("href")).toContain(encodeURIComponent("https://agentgem.ai/share/abc"));
    fireEvent.click(screen.getByText(/copy link/i));
    expect(screen.getByText(/copied/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing):

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Mine/__tests__/ShareLinks.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** — create `packages/console/src/panels/Mine/ShareLinks.tsx` by moving the polished row out of `ScorecardHero` (the `.scorecard-share-links` block #35 added):

```tsx
import { useState } from "react";
import { shareIntents } from "./shareIntents.js";

export function ShareLinks({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const intents = shareIntents(url);
  const copy = () => { void navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1600); };
  return (
    <div className="scorecard-share-links">
      <div className="scorecard-share-copy">
        <input readOnly value={url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="is-copy" onClick={copy}>{copied ? "Copied" : "Copy link"}</button>
      </div>
      <div className="scorecard-share-intents">
        <span className="scorecard-share-on">Share to</span>
        <a className="scorecard-intent" href={intents.x} target="_blank" rel="noreferrer">X</a>
        <a className="scorecard-intent" href={intents.linkedin} target="_blank" rel="noreferrer">LinkedIn</a>
        <a className="scorecard-intent" href={intents.facebook} target="_blank" rel="noreferrer">Facebook</a>
      </div>
    </div>
  );
}
```

In `Scorecard.tsx`: import `ShareLinks`, delete the inline `.scorecard-share-links` block + the now-unused `copied`/`copyLink`/`intents` locals, and render `{shareUrl && <ShareLinks url={shareUrl} />}`. Keep the `shareIntents` import only if still used (it isn't after extraction — remove it from Scorecard.tsx).

- [ ] **Step 4: Run — expect PASS** (ShareLinks test + existing Scorecard test + typecheck):

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Mine/__tests__/ShareLinks.test.tsx src/panels/Mine/__tests__/Scorecard.test.tsx && pnpm --filter @agentgem/console typecheck`
Expected: PASS, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Mine/ShareLinks.tsx packages/console/src/panels/Mine/__tests__/ShareLinks.test.tsx packages/console/src/panels/Mine/Scorecard.tsx
git commit -m "refactor(share): extract ShareLinks; hero reuses it"
```

---

### Task 8: Console — rewire per-item share to the hosted gem flow; delete `shareCard.ts`

**Files:**
- Modify: `packages/console/src/panels/Mine/Workflows.tsx`
- Delete: `packages/console/src/panels/Mine/shareCard.ts`, `packages/console/src/panels/Mine/__tests__/shareCard.test.ts`
- Test: `packages/console/src/panels/Mine/__tests__/Workflows.test.tsx` (extend or create)

**Interfaces:**
- Consumes: `createGemShareRoute` (Task 6), `ShareLinks` (Task 7), `scorecardWorkflowRoute` (existing).

- [ ] **Step 1: Write the failing test** — add to `packages/console/src/panels/Mine/__tests__/Workflows.test.tsx` (create if absent; mock the client):

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MineWorkflows } from "../index.js"; // or "../Workflows.js" — match the existing export path

// Minimal scorecard with one workflow; stub createGemShareRoute via the injected creator.
it("per-workflow Share mints a gem link and shows ShareLinks", async () => {
  const createGemShare = vi.fn(async () => ({ id: "g1", url: "https://agentgem.ai/share/g1" }));
  const data = { breadth: 1, battleTested: 1, portable: 1, gaps: [], degraded: false, generatedAtMs: 7,
    projects: [{ root: "/p", label: "p", breadth: 1, battleTested: 1, portable: 1,
      workflows: [{ key: "k", name: "my-wf", confidence: "high", portable: true, sessions: 5 }] }] } as never;
  render(<MineWorkflows data={data} filter="all" onFilter={() => {}} onBuild={() => {}} building={false} result={null} error={null} apiBase="" createGemShare={createGemShare} />);
  fireEvent.click(screen.getByLabelText(/share my-wf/i));
  await waitFor(() => expect(createGemShare).toHaveBeenCalledWith(expect.objectContaining({ kind: "gem", name: "my-wf" })));
  expect(await screen.findByRole("link", { name: "X" })).toBeTruthy();
});
```

> Note: the test injects `createGemShare`; mirror the `createShare` injection pattern `ScorecardHero` uses (default to the real route, override in tests). Confirm the `MineWorkflows` export path and existing prop names before writing — adapt the import/props to match.

- [ ] **Step 2: Run — expect FAIL** (Share still draws a canvas / no injected creator):

Run: `pnpm --filter @agentgem/console exec vitest run src/panels/Mine/__tests__/Workflows.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** — in `Workflows.tsx`:
  - Remove `import { drawWorkflowCard, drawGemCard, shareCanvas } from "./shareCard.js";` and the `shareCanvasRef` + the hidden `<canvas>`.
  - Add imports: `createGemShareRoute` (from `../../api/routes.js`), `ShareLinks` (from `./ShareLinks.js`).
  - Add a `createGemShare` prop (default to the real route): `createGemShare = (body) => createGemShareRoute.call(makeClient(apiBase), { body })`.
  - Add per-key share state: `const [shareUrls, setShareUrls] = useState<Record<string,string>>({})` and a busy/err map (mirror the hero's busy/slow/err — keep it simple: a `sharing` set + the error map already present).
  - Replace `shareWorkflow`: after resolving `detail`, call `createGemShare({ kind: "gem", name: wfName, provenance: \`Distilled from ${detail.sessions} session${detail.sessions === 1 ? "" : "s"}\`, generatedAtMs: Date.now() })` → `setShareUrls((m) => ({ ...m, [cacheKey]: url }))`. On error, set `detailError[cacheKey]`.
  - Replace `shareGem`: `createGemShare({ kind: "gem", name: result.name, provenance: \`${result.skills.length} skill${result.skills.length === 1 ? "" : "s"}\`, generatedAtMs: Date.now() })` → store under a `"__gem__"` key; render `<ShareLinks>` when set.
  - After each workflow's row (and after the build-ok line), render `{shareUrls[cacheKey] && <ShareLinks url={shareUrls[cacheKey]} />}`.

- [ ] **Step 4: Delete the dead canvas module** (confirm no other importer first):

```bash
grep -rn "shareCard" packages/console/src   # expect only Workflows.tsx (now removed) + the test
git rm packages/console/src/panels/Mine/shareCard.ts packages/console/src/panels/Mine/__tests__/shareCard.test.ts
```

- [ ] **Step 5: Run — expect PASS** (Workflows test + full console suite + typecheck + no dangling import):

Run: `pnpm --filter @agentgem/console exec vitest run && pnpm --filter @agentgem/console typecheck && ! grep -rq "shareCard" packages/console/src && echo CLEAN`
Expected: tests PASS, typecheck exit 0, prints `CLEAN`.

- [ ] **Step 6: Commit**

```bash
git add -A packages/console/src/panels/Mine
git commit -m "feat(share): per-workflow/per-build Share mints a hosted gem link; drop canvas path"
```

---

### Task 9: Full-suite verification

**Files:** none (verification).

- [ ] **Step 1: Backend + edge suite**

Run: `pnpm test`
Expected: all green (includes new gem schema/store/controller/shareClient + edge gem tests).

- [ ] **Step 2: Console suite + typecheck**

Run: `pnpm --filter @agentgem/console test && pnpm --filter @agentgem/console typecheck`
Expected: all green, typecheck exit 0.

- [ ] **Step 3: Local smoke (optional)** — run the app, open Mine, click a per-workflow "Share":

```bash
PORT=4319 AGENTGEM_AGGREGATOR_URL=http://127.0.0.1:4319 SHARE_BASE=http://127.0.0.1:4319 pnpm dev
# Mine → a workflow "Share" → expect a /share/<id> URL + the ShareLinks row (copy + intents)
```

Expected: `POST /api/share` with `{kind:"gem",…}` succeeds against the in-process pglite aggregator; the ShareLinks row appears. (Real OG-unfurl verification is deploy-gated, like the certificate.)

---

## Self-Review

**1. Spec coverage:** no per-gem image (Task 5: `summary`, no og:image, og.png 404) ✓; teaser+CTA (Task 5 body) ✓; reuse spine + discriminated kind (Tasks 1-4) ✓; provenance one string (Tasks 2/3/8) ✓; extract ShareLinks (Task 7) ✓; per-workflow + per-build rewire + delete canvas (Task 8) ✓; privacy sanitize/cap (Task 3) ✓; certificate path preserved (Tasks 2-6 keep cert arm + tests) ✓.

**2. Placeholder scan:** every code step has full code; the two "match the existing export path/props" notes (Task 8) are explicit adaptation instructions for verifiable names, not deferred work.

**3. Type consistency:** `CreateInput`/`ShareRecord`/`CreateBody` discriminated on `kind` across store (T2), controller (T3), proxy/client (T4); gem payload `{name, provenance}` consistent T1→T8; `createGemShareRoute` body `{kind:"gem",name,provenance,generatedAtMs}` matches the proxy union (T4) and store input (T2); `ShareLinks({url})` consumed by hero (T7) and Workflows (T8).
