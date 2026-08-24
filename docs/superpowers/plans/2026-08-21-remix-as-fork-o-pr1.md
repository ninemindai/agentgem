# Remix-as-Fork O-PR1 (fork plumbing + remix UX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A published game can be forked into the local Studio as a real copy with pinned
lineage (`remixOf`), via `agentgem://play?remix=<key>` → console confirm card → same-origin
source proxy → `importStudio`.

**Architecture:** `remixOf: { gemKey, version }` is threaded through the meta.json seams
(engine type → artifact → both wire schema stacks → Studio echo), `importStudio` gains an
opts param that bakes lineage + the original genre at fork creation, a new
`GET /api/play/remix-source` proxies `game-meta`/`game-html` from the aggregator fail-closed
on `allowRemix`, and the console Play panel adds a `remix=` deep-link branch that renders a
confirm card and only fetches/creates after the click. The publish manifest is **not**
touched in this PR (see Global Constraints).

**Tech Stack:** TypeScript ESM, zod, AgentBack decorators (`@api`/`@get`/`@post`), React,
vitest (+ @testing-library/react for console).

**Spec:** `docs/superpowers/specs/2026-08-21-remix-as-fork.md` (§3.1, §3.6, §4, and the
O-PR1 breakdown in §6). One deviation from the spec: the Studio "Allow remixing" checkbox
moves wholly to O-PR2 (rendering a control that isn't sent invites reviewer confusion; the
spec already allows "the field is simply not sent").

## Global Constraints

- **Do NOT add `allowRemix`/`remixOf` to the publish body, `publishSetup`, or the signed
  `CatalogManifest` *value* the console sends.** The deployed aggregator zod-strips unknown
  manifest keys before signature verification — sending them fails every publish. O-PR2
  flips this after the enterprise side deploys. (Contract *types* gain the optional fields
  in Task 5; nothing populates them in this PR.)
- zod strips unknown keys at every hop: a new meta field must be added at **every** schema
  listed in Task 2 or it silently vanishes (routes.ts:1041-1043 documents this trap).
- Root tests execute **compiled dist**: always root `pnpm build` (the script, never bare
  `tsc -b` — it leaves the console bundle stale) before `npx vitest run dist/...`.
- Console tests: `pnpm --filter @agentgem/console test -- --run <pattern>` (use `--filter`,
  not `--root`; the console pool is capped at 4 workers).
- No edits to `MINIAPP_BUILDER_BRIEF` / `skills/agentgem-miniapp/SKILL.md` (the authoring
  contract does not change; the drift test will fail if touched inconsistently).
- Never write a literal NUL byte via Write/Edit (it makes grep and `git diff` skip the file).
- Work in a dedicated worktree branched off freshly fetched `origin/main`
  (`git fetch origin && git worktree add ../agentgem-worktrees/remix-fork -b remix-fork origin/main`);
  never commit to `main`; integrate via PR gated by CI check `test (24)`.
- Match file style: 2-space indent, double quotes, dense comment style stating constraints.
- Git author: Raymond Feng <raymond@ninemind.ai>.

---

### Task 1: Engine lineage — `RemixRef` in meta, artifact, gem dual-write, and `importStudio`

**Files:**
- Modify: `packages/model/src/types.ts` (~line 102, above `GameArtifact`)
- Modify: `packages/play/src/miniapps.ts` (lines 10, 20-24, 87-93, 182-186)
- Modify: `packages/play/src/studio.ts` (lines 8, 111-128)
- Test: `src/play/__tests__/remixFork.test.ts` (create)

**Interfaces:**
- Consumes: existing `MiniappMeta`, `GameArtifact`, `importStudio`, `saveMiniapp`.
- Produces: `RemixRef { gemKey: string; version: string }` exported from `@agentgem/model`;
  `MiniappMeta.remixOf?: RemixRef`; `GameArtifact.remixOf?: RemixRef`;
  `importStudio(title, html, name?, files?, opts?: { remixOf?: RemixRef; genre?: GameGenre })`.
  Task 2 depends on these exact names.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/remixFork.test.ts` (conventions copied from
`src/play/__tests__/miniapps.test.ts` — temp `AGENTGEM_HOME`, sealed html fixture):

```ts
// src/play/__tests__/remixFork.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importStudio, saveMiniapp, miniappDir } from "@agentgem/play";
import { workspaceDir } from "@agentgem/base";
import { readGemArchive, readArchiveDir } from "@agentgem/archive";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const REMIX = { gemKey: "@bob/snake", version: "1.2.0" };
const sealed = "<!doctype html><body><canvas></canvas><script>const x=1;</script></body>";
const metaFor = (name: string) => ({
  title: name, genre: "project-fun" as const,
  createdFrom: { kind: "html" as const, title: name }, engineVersion: "1",
});

describe("remix fork lineage", () => {
  it("importStudio bakes remixOf + the original genre into meta.json", async () => {
    const { name } = await importStudio("snake-remix", sealed, undefined, undefined, { remixOf: REMIX, genre: "skill-run" });
    const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(meta.remixOf).toEqual(REMIX);
    expect(meta.genre).toBe("skill-run");
  });

  it("without opts, importStudio behaves exactly as before (no remixOf, project-fun)", async () => {
    const { name } = await importStudio("plain", sealed);
    const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(meta.remixOf).toBeUndefined();
    expect(meta.genre).toBe("project-fun");
  });

  it("saveMiniapp round-trips remixOf into the dual-written gem artifact", async () => {
    const { name } = await importStudio("snake-remix", sealed, undefined, undefined, { remixOf: REMIX });
    await saveMiniapp({ name, html: sealed, meta: { ...metaFor("snake-remix"), remixOf: REMIX } });
    const gem = readGemArchive(readArchiveDir(workspaceDir(name)));
    expect((gem.artifacts[0] as { remixOf?: unknown }).remixOf).toEqual(REMIX);
  });

  it("a save that omits remixOf carries it forward from disk (uploads-style)", async () => {
    const { name } = await importStudio("snake-remix", sealed, undefined, undefined, { remixOf: REMIX });
    await saveMiniapp({ name, html: sealed, meta: metaFor("snake-remix") });
    const meta = JSON.parse(readFileSync(join(miniappDir(name), "meta.json"), "utf8"));
    expect(meta.remixOf).toEqual(REMIX);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && npx vitest run dist/play/__tests__/remixFork.test.js`
Expected: the build itself FAILS on the `opts` argument (`importStudio` takes 4 params), or
if built loosely, the first assertion fails with `meta.remixOf` undefined.

- [ ] **Step 3: Implement**

`packages/model/src/types.ts` — insert directly above `export interface GameArtifact` (line 103):

```ts
// Lineage of a remix fork: the published game this miniapp was forked from, pinned to the
// exact version fetched at fork time. Metadata only — it never grants anything (needs are
// re-derived from the fork's own code), and it survives deletion of the original because a
// fork is a full copy.
export interface RemixRef { gemKey: string; version: string }
```

Add `remixOf?: RemixRef; // forked from this published game (pinned at fork time)` to
`GameArtifact` after the `mcpNeeds?` member (line 113).

`packages/play/src/miniapps.ts`:
- Line 10 import: add `RemixRef` →
  `import type { Gem, GameArtifact, GameGenre, GameSource, GameCapability, McpNeed, RemixRef } from "@agentgem/model";`
- `MiniappMeta` (line 20): add member
  `remixOf?: RemixRef;   // lineage, set once at fork creation; carried forward like uploads`
- `writeGameGem` artifact literal (lines 88-93): add after the `mcpNeeds` spread:
  `...(meta.remixOf ? { remixOf: meta.remixOf } : {}),`
  (Unlike `uploads`, `remixOf` deliberately DOES reach the gem — attribution travels with
  the artifact. Do not add it to the `delete gemMeta.uploads` line 190.)
- Replace the uploads carry-forward block (lines 183-186) with a shared one:

```ts
  if ((meta.uploads === undefined || meta.remixOf === undefined) && existsSync(metaPath)) {
    try {
      const prev = JSON.parse(readFileSync(metaPath, "utf8")) as MiniappMeta;
      if (meta.uploads === undefined && prev.uploads) meta.uploads = prev.uploads;
      // remixOf is set once at fork creation; a client that echoes meta without it must not erase lineage.
      if (meta.remixOf === undefined && prev.remixOf) meta.remixOf = prev.remixOf;
    } catch { /* no readable prior meta — nothing to preserve */ }
  }
```

`packages/play/src/studio.ts`:
- Line 8 import: add `type RemixRef` →
  `import { type GameSource, type GameGenre, type RemixRef, AUTO_CAPS } from "@agentgem/model";`
- Change `importStudio`'s signature and meta literal (lines 111, 124) and make the brief
  name the origin when it is a remix:

```ts
export interface ImportOpts { remixOf?: RemixRef; genre?: GameGenre }

// Import a miniapp from existing self-contained HTML. The HTML becomes the miniapp verbatim (a draft);
// NOT gated here — Save enforces the seal, so imperfect HTML can be brought in and fixed in the studio.
// `opts` is the remix-fork seam: lineage + the original's genre, baked once at creation.
export async function importStudio(title: string, html: string, name?: string, files?: UploadFile[], opts?: ImportOpts): Promise<{ name: string; brief: string }> {
```

and (line 124, keeping the existing needs comment above it unchanged):

```ts
  const meta: MiniappMeta = { title, genre: opts?.genre ?? "project-fun", createdFrom: source, engineVersion: "1", ...(opts?.remixOf ? { remixOf: opts.remixOf } : {}), ...(needs.length ? { needs } : {}), ...((uploads.ship || uploads.ref) ? { uploads } : {}) };
```

and the return (line 127):

```ts
  const refining = opts?.remixOf
    ? `You are refining "${title}", the user's remix of the published mini-game "${opts.remixOf.gemKey}".`
    : `You are refining "${title}", a self-contained HTML mini-game the user imported.`;
  return { name: id, brief: `${refining}${uploadsBrief(uploads)}\n\n${studioInstructions(MINIAPP_HTML)}` };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/play/__tests__/remixFork.test.js`
Expected: 4 passed.

- [ ] **Step 5: Regression check + commit**

Run: `npx vitest run dist/play/__tests__/miniapps.test.js dist/play/__tests__/studio.import.test.js`
Expected: PASS (no behavior change without opts).

```bash
git add packages/model/src/types.ts packages/play/src/miniapps.ts packages/play/src/studio.ts src/play/__tests__/remixFork.test.ts
git commit -m "feat(play): remixOf lineage in miniapp meta, gem artifact, and importStudio"
```

---

### Task 2: Wire schemas — `remixOf` survives both HTTP schema stacks

**Files:**
- Modify: `packages/app/src/schemas.ts` (lines 893-903, 968-972, 1029)
- Modify: `packages/app/src/play.controller.ts` (lines 75-81, 149-161)
- Modify: `packages/console/src/api/routes.ts` (lines 1053-1057, 1062-1069, 1090-1093)
- Modify: `packages/console/src/panels/Play/Studio.tsx` (lines 431-438)
- Test: `src/play/__tests__/remixFork.test.ts` (extend), `packages/console/src/panels/Play/__tests__/remixMeta.drift.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `RemixRef`, `ImportOpts`.
- Produces: `RemixRefSchema` exported from `packages/app/src/schemas.ts`;
  `PlayImportRequestSchema` accepts `remixOf?`/`genre?`; `playImportRoute` (console) body
  accepts `remixOf?`/`genre?`; `GET /api/play/miniapp` responses carry `meta.remixOf`.
  Task 4 calls `playImportRoute` with `remixOf` and `genre`.

- [ ] **Step 1: Write the failing tests**

Append to `src/play/__tests__/remixFork.test.ts`:

```ts
import { PlaySaveRequestSchema, PlayMiniappSchema, PlayImportRequestSchema } from "@agentgem/app/schemas";

describe("remixOf wire schemas (zod must not strip lineage)", () => {
  const meta = { title: "t", genre: "project-fun", createdFrom: { kind: "html", title: "t" }, engineVersion: "1", remixOf: REMIX };
  it("PlaySaveRequestSchema keeps meta.remixOf", () => {
    expect(PlaySaveRequestSchema.parse({ name: "g", html: "<x>", meta }).meta.remixOf).toEqual(REMIX);
  });
  it("PlayMiniappSchema keeps meta.remixOf on the way out", () => {
    expect(PlayMiniappSchema.parse({ name: "g", html: "<x>", meta }).meta.remixOf).toEqual(REMIX);
  });
  it("PlayImportRequestSchema accepts remixOf + genre", () => {
    const p = PlayImportRequestSchema.parse({ title: "t", html: "<x>", remixOf: REMIX, genre: "skill-run" });
    expect(p.remixOf).toEqual(REMIX);
    expect(p.genre).toBe("skill-run");
  });
  it("RemixRef rejects empty members", () => {
    expect(() => PlayImportRequestSchema.parse({ title: "t", html: "<x>", remixOf: { gemKey: "", version: "1" } })).toThrow();
  });
});
```

Create `packages/console/src/panels/Play/__tests__/remixMeta.drift.test.ts` (guards the
client mirror — the file-header note in routes.ts says a missing echo member is silently
stripped):

```ts
// packages/console/src/panels/Play/__tests__/remixMeta.drift.test.ts
// Drift guard for the remixOf lineage field: if either client schema drops it, the Studio's
// save echo would silently erase lineage on every save (routes.ts strips unknown keys).
import { describe, it, expect } from "vitest";
import { playMiniappRoute, playSaveRoute, playImportRoute } from "../../../api/routes.js";

const REMIX = { gemKey: "@bob/snake", version: "1.2.0" };
const meta = { title: "t", genre: "project-fun", createdFrom: { kind: "html", title: "t" }, engineVersion: "1", remixOf: REMIX };

describe("remixOf client-schema drift", () => {
  it("playMiniappRoute response keeps meta.remixOf", () => {
    const parsed = playMiniappRoute.schema.response.parse({ name: "g", html: "<x>", meta });
    expect(parsed.meta.remixOf).toEqual(REMIX);
  });
  it("playSaveRoute body keeps meta.remixOf", () => {
    const parsed = playSaveRoute.schema.body.parse({ name: "g", html: "<x>", meta });
    expect(parsed.meta.remixOf).toEqual(REMIX);
  });
  it("playImportRoute body keeps remixOf + genre", () => {
    const parsed = playImportRoute.schema.body.parse({ title: "t", html: "<x>", remixOf: REMIX, genre: "skill-run" });
    expect(parsed.remixOf).toEqual(REMIX);
    expect(parsed.genre).toBe("skill-run");
  });
});
```

Note: if `defineRoute`'s return shape doesn't expose `.schema.body`/`.schema.response`
under those names, open `packages/console/src/api/routes.ts` line ~1-40 to find the actual
property names (`body`/`response` directly, or similar) and use those — the assertion
content stays identical.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm build && npx vitest run dist/play/__tests__/remixFork.test.js`
Expected: the three new schema tests FAIL (`remixOf` stripped → `undefined`).
Run: `pnpm --filter @agentgem/console test -- --run remixMeta`
Expected: FAIL the same way.

- [ ] **Step 3: Implement**

`packages/app/src/schemas.ts` — above `PlaySaveRequestSchema` (line 893):

```ts
// Lineage of a remix fork: the published game it was forked from, pinned at fork time.
// Optional on every meta hop; zod strips unknown keys, so every play schema that carries
// meta must name it (PlaySaveRequestSchema, PlayMiniappSchema, PlayImportRequestSchema).
export const RemixRefSchema = z.object({ gemKey: z.string().min(1), version: z.string().min(1) });
```

- `PlaySaveRequestSchema.meta`: add `remixOf: RemixRefSchema.optional(),` after `mcpNeeds`.
- `PlayMiniappSchema.meta` (line 970): add `remixOf: RemixRefSchema.optional()` after `mcpNeeds`.
- `PlayImportRequestSchema` (line 1029): append `remixOf: RemixRefSchema.optional(), genre: GameGenreEnum.optional()` to the object.

`packages/app/src/play.controller.ts`:
- `import()` (line 78): `const { name } = await importStudio(input.body.title, input.body.html, input.body.name, input.body.files, { remixOf: input.body.remixOf, genre: input.body.genre });`
- `miniapp()` meta projection (lines 154-158): add `...(r.meta.remixOf ? { remixOf: r.meta.remixOf } : {}),` after the `mcpNeeds` spread.

`packages/console/src/api/routes.ts`:
- Above `PlayMetaSchema` (line 1053):
  `const PlayRemixRefSchema = z.object({ gemKey: z.string(), version: z.string() });`
- `PlayMetaSchema`: add `remixOf: PlayRemixRefSchema.optional(),` after `mcpNeeds`.
- `playMiniappRoute` response meta object (line 1066): add `remixOf: PlayRemixRefSchema.optional()` after `mcpNeeds`.
- `playImportRoute` body (line 1091): append `remixOf: PlayRemixRefSchema.optional(), genre: z.enum(["replay", "skill-run", "project-fun", "session-heatmap", "project-map", "skill-tuner"]).optional()`.

`packages/console/src/panels/Play/Studio.tsx` — `save()` body meta (after the `mcpNeeds`
spread at line 437): add

```ts
        // remixOf is lineage set once at fork creation — echo it or the save would erase it
        // (the server's carry-forward is the backstop, this is the primary path).
        ...(cur.meta.remixOf ? { remixOf: cur.meta.remixOf } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && npx vitest run dist/play/__tests__/remixFork.test.js`
Expected: all pass.
Run: `pnpm --filter @agentgem/console test -- --run remixMeta`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/schemas.ts packages/app/src/play.controller.ts packages/console/src/api/routes.ts packages/console/src/panels/Play/Studio.tsx src/play/__tests__/remixFork.test.ts packages/console/src/panels/Play/__tests__/remixMeta.drift.test.ts
git commit -m "feat(play): thread remixOf through both wire-schema stacks and the Studio save echo"
```

---

### Task 3: Remix-source proxy — fetch a published game's sealed HTML, fail-closed on allowRemix

**Files:**
- Create: `packages/app/src/gem/remixSourceClient.ts`
- Modify: `packages/app/src/schemas.ts` (after `PlayBlankRequestSchema`, ~line 1032)
- Modify: `packages/app/src/play.controller.ts` (imports + new route after `blank()`, line 89)
- Test: `src/__tests__/remixSourceClient.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks (independent seam).
- Produces: `fetchRemixSource({ key, endpoint?, http? }): Promise<{ title, genre, version, html }>`;
  `GET /api/play/remix-source?key=…` → `{ title: string; genre: string; version: string; html: string }`.
  Task 4's `playRemixSourceRoute` mirrors this response shape exactly.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/remixSourceClient.test.ts`:

```ts
// src/__tests__/remixSourceClient.test.ts
import { describe, it, expect } from "vitest";
import { fetchRemixSource, type RemixHttp } from "@agentgem/app";

const ok = (body: unknown) => ({ status: 200, json: async () => body });
const httpFor = (meta: unknown, html: unknown = { html: "<x>" }): RemixHttp => async (url) =>
  url.includes("game-meta") ? ok(meta) : ok(html);

describe("fetchRemixSource", () => {
  it("returns title/genre/version/html when the creator allows remixing", async () => {
    const src = await fetchRemixSource({ key: "@bob/snake", endpoint: "http://agg", http: httpFor({ title: "Snake", genre: "project-fun", version: "1.2.0", allowRemix: true }) });
    expect(src).toEqual({ title: "Snake", genre: "project-fun", version: "1.2.0", html: "<x>" });
  });
  it("pins the version game-meta resolved (game-html is fetched with it)", async () => {
    const urls: string[] = [];
    const http: RemixHttp = async (url) => { urls.push(url); return url.includes("game-meta") ? ok({ title: "S", genre: "project-fun", version: "2.0.1", allowRemix: true }) : ok({ html: "<x>" }); };
    await fetchRemixSource({ key: "@bob/snake", endpoint: "http://agg", http });
    expect(urls[1]).toContain("version=2.0.1");
  });
  it("refuses when allowRemix is false", async () => {
    await expect(fetchRemixSource({ key: "@bob/snake", endpoint: "http://agg", http: httpFor({ title: "S", genre: "project-fun", version: "1.0.0", allowRemix: false }) }))
      .rejects.toThrow(/hasn't allowed remixing/);
  });
  it("fail-closed: refuses when allowRemix is absent (pre-remix aggregator)", async () => {
    await expect(fetchRemixSource({ key: "@bob/snake", endpoint: "http://agg", http: httpFor({ title: "S", genre: "project-fun", version: "1.0.0" }) }))
      .rejects.toThrow(/hasn't allowed remixing/);
  });
  it("maps a 404 to a clean not-available error", async () => {
    const http: RemixHttp = async () => ({ status: 404, json: async () => ({}) });
    await expect(fetchRemixSource({ key: "@bob/gone", endpoint: "http://agg", http }))
      .rejects.toThrow(/not available to remix/);
  });
});
```

Note: if `@agentgem/app` doesn't re-export new symbols automatically, add
`fetchRemixSource`/`RemixHttp` to whatever export barrel the package uses (check how
`fetchHostedArchive` from `gem/hostedInstall.ts` is exported and mirror it).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build`
Expected: FAIL to compile — `fetchRemixSource` does not exist.

- [ ] **Step 3: Implement**

Create `packages/app/src/gem/remixSourceClient.ts` (mirrors `hostedInstall.ts`'s
http-injection + base-resolution conventions):

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Remix-source fetch: pull a published game's meta + sealed html from the hosted aggregator so the
// console can fork it locally. FAIL-CLOSED on allowRemix — an aggregator that doesn't state
// allowRemix (a pre-remix deploy) refuses too; the creator's opt-out must never default open.
import { InvalidInputError } from "@agentgem/model";

export interface RemixSource { title: string; genre: string; version: string; html: string }

export type RemixHttp = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
const defaultHttp: RemixHttp = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: () => res.json() };
};

// Resolve the hosted base: explicit endpoint -> AGENTGEM_AGGREGATOR_URL -> the hosted default.
function resolveBase(endpoint: string | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return "https://api.agentgem.ai";
}

export async function fetchRemixSource(args: { key: string; endpoint?: string; http?: RemixHttp }): Promise<RemixSource> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const metaRes = await http(`${base}/api/aggregator/game-meta?key=${encodeURIComponent(args.key)}`);
  if (metaRes.status === 404) throw new InvalidInputError("that game is not available to remix");
  if (metaRes.status < 200 || metaRes.status >= 300) throw new InvalidInputError(`could not fetch the game (HTTP ${metaRes.status}); try again in a moment`);
  const meta = (await metaRes.json()) as { title?: string; genre?: string; version?: string; allowRemix?: boolean };
  if (meta.allowRemix !== true) throw new InvalidInputError("the creator hasn't allowed remixing for this game");
  if (!meta.title || !meta.version) throw new InvalidInputError("that game is not available to remix");
  const htmlRes = await http(`${base}/api/aggregator/game-html?key=${encodeURIComponent(args.key)}&version=${encodeURIComponent(meta.version)}`);
  if (htmlRes.status < 200 || htmlRes.status >= 300) throw new InvalidInputError(`could not fetch the game (HTTP ${htmlRes.status}); try again in a moment`);
  const body = (await htmlRes.json()) as { html?: string };
  if (!body.html) throw new InvalidInputError("that game is not available to remix");
  return { title: meta.title, genre: meta.genre ?? "project-fun", version: meta.version, html: body.html };
}
```

`packages/app/src/schemas.ts` — after `PlayBlankRequestSchema` (line 1032):

```ts
// Remix-source proxy (GET /api/play/remix-source): the console fetches a published game's meta+html
// through the local core (browser stays same-origin; base resolution + allowRemix gate server-side).
export const PlayRemixSourceQuerySchema = z.object({ key: z.string().min(1) });
export const PlayRemixSourceSchema = z.object({ title: z.string(), genre: z.string(), version: z.string(), html: z.string() });
```

`packages/app/src/play.controller.ts` — import `fetchRemixSource` from
`"./gem/remixSourceClient.js"`, add `PlayRemixSourceQuerySchema, PlayRemixSourceSchema` to
the `./schemas.js` import, and add after `blank()` (line 89):

```ts
  // Same-origin remix-source proxy (mirrors the ShareProxy/Benchmark proxy pattern): the browser never
  // talks to the aggregator. InvalidInputError from the client maps to a clean 4xx like the session
  // routes' throws do; the allowRemix gate inside fetchRemixSource is fail-closed.
  @get("/play/remix-source", { query: PlayRemixSourceQuerySchema, response: PlayRemixSourceSchema })
  async remixSource(input: { query: z.infer<typeof PlayRemixSourceQuerySchema> }): Promise<z.infer<typeof PlayRemixSourceSchema>> {
    return fetchRemixSource({ key: input.query.key });
  }
```

Export `fetchRemixSource`/`RemixHttp` from the package barrel the same way
`gem/hostedInstall.ts` symbols are exported.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && npx vitest run dist/__tests__/remixSourceClient.test.js`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/gem/remixSourceClient.ts packages/app/src/schemas.ts packages/app/src/play.controller.ts src/__tests__/remixSourceClient.test.ts
git commit -m "feat(play): remix-source proxy, fail-closed on the creator's allowRemix"
```

(Include the barrel-export file in the `git add` if one was edited.)

---

### Task 4: Console — `remix=` deep link, confirm card, fork creation

**Files:**
- Create: `packages/console/src/panels/Play/RemixConfirm.tsx`
- Modify: `packages/console/src/api/routes.ts` (new route beside `playImportRoute`)
- Modify: `packages/console/src/panels/Play/index.tsx` (lines 10-13, 32-41, 71-83)
- Test: `packages/console/src/panels/Play/__tests__/PlayDeepLink.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 2's `playImportRoute` body (`remixOf`, `genre`); Task 3's response shape
  `{ title, genre, version, html }`.
- Produces: `playRemixSourceRoute` (console client route);
  `RemixConfirm({ apiBase, gemKey, onCreated, onCancel })` where `onCreated` has the same
  `(name: string, seedPrompt?: string) => void` signature Composer's `onCreated` uses.

- [ ] **Step 1: Write the failing tests**

Append to `packages/console/src/panels/Play/__tests__/PlayDeepLink.test.tsx` (add
`playRemixSourceRoute, playImportRoute` to the existing routes import):

```tsx
describe("Play deep link (#/play?remix=…)", () => {
  it("shows the confirm card and fetches NOTHING before the click", async () => {
    stubBoot();
    const srcCall = vi.spyOn(playRemixSourceRoute, "call");
    window.location.hash = "#/play?remix=%40bob%2Fsnake";
    render(<Play apiBase="" />);
    await waitFor(() => expect(screen.getByText(/Remix .@bob\/snake./)).toBeTruthy());
    expect(srcCall).not.toHaveBeenCalled();
  });

  it("confirming fetches the source and imports the fork with pinned lineage", async () => {
    stubBoot();
    vi.spyOn(playRemixSourceRoute, "call").mockResolvedValue(
      { title: "Snake", genre: "project-fun", version: "1.2.0", html: "<html>x</html>" } as never);
    const importCall = vi.spyOn(playImportRoute, "call").mockResolvedValue({ name: "snake-remix" } as never);
    window.location.hash = "#/play?remix=%40bob%2Fsnake";
    render(<Play apiBase="" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remix" })).toBeTruthy());
    screen.getByRole("button", { name: "Remix" }).click();
    await waitFor(() => expect(importCall).toHaveBeenCalledWith(expect.anything(), {
      body: expect.objectContaining({
        title: "snake-remix", html: "<html>x</html>", genre: "project-fun",
        remixOf: { gemKey: "@bob/snake", version: "1.2.0" },
      }),
    }));
  });

  it("a refused source (allowRemix off) surfaces the error and stays on the card", async () => {
    stubBoot();
    vi.spyOn(playRemixSourceRoute, "call").mockRejectedValue(new Error("the creator hasn't allowed remixing for this game"));
    window.location.hash = "#/play?remix=%40bob%2Fsnake";
    render(<Play apiBase="" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remix" })).toBeTruthy());
    screen.getByRole("button", { name: "Remix" }).click();
    await waitFor(() => expect(screen.getByText(/hasn't allowed remixing/)).toBeTruthy());
  });

  it("cancel returns to the Arcade", async () => {
    stubBoot();
    window.location.hash = "#/play?remix=%40bob%2Fsnake";
    render(<Play apiBase="" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy());
    screen.getByRole("button", { name: "Cancel" }).click();
    await waitFor(() => expect(screen.queryByText(/Remix .@bob\/snake./)).toBeNull());
    expect(screen.getByText("+ New miniapp")).toBeTruthy();
  });
});
```

(Wrap the two `.click()` calls in `act(...)` if testing-library warns.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @agentgem/console test -- --run PlayDeepLink`
Expected: compile FAILS on `playRemixSourceRoute` (doesn't exist yet).

- [ ] **Step 3: Implement**

`packages/console/src/api/routes.ts` — beside `playImportRoute`:

```ts
// Same-origin remix-source proxy: the core fetches game-meta + game-html from the aggregator
// (fail-closed on the creator's allowRemix) so the browser never goes cross-origin.
export const playRemixSourceRoute = defineRoute("GET", "/api/play/remix-source", {
  query: z.object({ key: z.string() }),
  response: z.object({ title: z.string(), genre: z.string(), version: z.string(), html: z.string() }),
});
```

Create `packages/console/src/panels/Play/RemixConfirm.tsx`:

```tsx
// packages/console/src/panels/Play/RemixConfirm.tsx
// The remix deep-link consent card. NOTHING is fetched or written on arrival — the arrival only
// renders this card; the fetch + fork happen on the explicit click (spec I3's mirror: pulling a
// published artifact IN is an authored act too). deeplink.ts's "play installs nothing" stays true.
import { useState } from "react";
import { makeClient, playRemixSourceRoute, playImportRoute } from "../../api/routes.js";

const GENRES = ["replay", "skill-run", "project-fun", "session-heatmap", "project-map", "skill-tuner"] as const;
type Genre = (typeof GENRES)[number];
const asGenre = (g: string): Genre | undefined => (GENRES as readonly string[]).includes(g) ? (g as Genre) : undefined;

export function RemixConfirm({ apiBase, gemKey, onCreated, onCancel }: {
  apiBase: string;
  gemKey: string;
  onCreated: (name: string, seedPrompt?: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function doRemix() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const src = await playRemixSourceRoute.call(makeClient(apiBase), { query: { key: gemKey } });
      const short = gemKey.split("/").pop() ?? gemKey;
      const genre = asGenre(src.genre);
      const res = await playImportRoute.call(makeClient(apiBase), { body: {
        title: `${short}-remix`, html: src.html,
        remixOf: { gemKey, version: src.version },
        ...(genre ? { genre } : {}),
      } });
      onCreated(res.name, `This is a remix of "${gemKey}" — make it your own.`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <div className="play-banner">
      <span className="play-banner__ico">🍴</span>
      <div className="play-banner__body">
        <div className="play-banner__title">Remix “{gemKey}”?</div>
        <div className="play-banner__detail">{error || "This copies the published game into your arcade so you can make it your own. Nothing is fetched until you confirm."}</div>
      </div>
      <button className="play-btn play-btn--primary" disabled={busy} onClick={() => void doRemix()}>{busy ? "Fetching…" : "Remix"}</button>
      <button className="play-btn play-btn--ghost" disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  );
}
```

(`play-banner`/`play-btn` classes already have console CSS rules — Studio's banners use
them; no new stylesheet entries needed.)

`packages/console/src/panels/Play/index.tsx`:
- Import: `import { RemixConfirm } from "./RemixConfirm.js";`
- `View` union: add `| { kind: "remix-confirm"; gemKey: string }` after the composer member.
- Deep-link handler — replace the body of `applyDeepLink` (keep the surrounding effect):

```ts
    const applyDeepLink = () => {
      const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
      // remix=<gemKey>: a published game's fork link (marketplace "Remix"). Renders a consent
      // card only — the fetch and the local write happen on the explicit confirm click.
      const remix = params.get("remix");
      if (remix) { setView({ kind: "remix-confirm", gemKey: remix }); return; }
      if (!params.get("new")) return;
      setView({ kind: "composer", title: params.get("title") ?? undefined, prompt: params.get("prompt") ?? undefined });
    };
```

- Render branch (beside the composer branch, line 81):

```tsx
      {view.kind === "remix-confirm" && <RemixConfirm apiBase={apiBase} gemKey={view.gemKey}
        onCreated={(name, seedPrompt) => setView({ kind: "studio", name, seedPrompt })}
        onCancel={() => setView({ kind: "arcade" })} />}
```

Also render `<Arcade …>` behind the card so Cancel's destination is visible context: change
the arcade condition to `{(view.kind === "arcade" || view.kind === "remix-confirm") && <Arcade …/>}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @agentgem/console test -- --run PlayDeepLink`
Expected: all pass (3 pre-existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Play/RemixConfirm.tsx packages/console/src/panels/Play/index.tsx packages/console/src/panels/Play/__tests__/PlayDeepLink.test.tsx
git commit -m "feat(console): remix deep link renders a consent card, then forks with pinned lineage"
```

---

### Task 5: Contract types + docs (spec §9 row, evolution D10 row)

**Files:**
- Modify: `packages/contract/src/catalog.ts` (lines 12-20, 37-44)
- Modify: `docs/miniapps/spec.md` (§9 table, line ~314)
- Modify: `docs/miniapps/evolution.md` (D10 table, lines 102-114)

**Interfaces:**
- Produces: `CatalogRow.allowRemix?/remixOf?` and `CatalogManifest.allowRemix?/remixOf?`
  — consumed by E-PR1 (aggregator) and O-PR2 (console sends). Nothing in this repo
  populates them yet.

- [ ] **Step 1: Implement (docs/types — no runtime behavior, no test; the compile is the check)**

`packages/contract/src/catalog.ts` — above `CatalogRow` add:

```ts
// Remix lineage on the catalog wire. OPTIONAL end-to-end and NOT yet sent by this repo's
// publish path: the aggregator must accept these fields before any console signs a manifest
// containing them (the manifest hash covers the whole object — an aggregator that strips an
// unknown key verifies a different hash and rejects the publish). Rollout: enterprise E-PR1
// deploys acceptance; O-PR2 then flips the console to send.
export interface CatalogRemixRef { gemKey: string; version: string }
```

Add to `CatalogRow` (after `visibility?`): `allowRemix?: boolean; remixOf?: CatalogRemixRef;`
Add to `CatalogManifest` (after `visibility?`): `allowRemix?: boolean; remixOf?: CatalogRemixRef;`

`docs/miniapps/spec.md` — add a row to the §9 table before the authoring-contract row:

```
| remix fork (source proxy, consent card, lineage) | `packages/app/src/gem/remixSourceClient.ts`, `packages/console/src/panels/Play/RemixConfirm.tsx` |
```

`docs/miniapps/evolution.md` — in D10: change "The pattern repeats five times" to
"The pattern repeats six times" and add a table row:

```
| one-tap remix of published games | creator `allowRemix` gate, fail-closed at three layers; fork re-derives `needs` from its own code |
```

- [ ] **Step 2: Verify**

Run: `pnpm build`
Expected: clean compile.
Run: `grep -n "remixOf" packages/contract/src/catalog.ts`
Expected: 2+ hits (both interfaces).

- [ ] **Step 3: Commit**

```bash
git add packages/contract/src/catalog.ts docs/miniapps/spec.md docs/miniapps/evolution.md
git commit -m "feat(contract): optional allowRemix/remixOf catalog fields + remix D10 entry (not yet sent)"
```

---

### Task 6: Full verification + PR

- [ ] **Step 1: Full build + root suite**

Run: `pnpm build && pnpm test`
Expected: green. If pre-existing failures appear, verify them against a clean `origin/main`
checkout before attributing them to this branch, and say so in the PR body.

- [ ] **Step 2: Console suite**

Run: `pnpm --filter @agentgem/console test`
Expected: green (jsdom warnings are fine; assertions must pass AND the process must exit 0 —
this repo has seen green assertions with a red exit).

- [ ] **Step 3: Open the PR**

```bash
git push -u origin remix-fork
gh pr create --title "Remix-as-fork O-PR1: lineage plumbing + remix deep-link UX" \
  --body "$(cat <<'EOF'
Implements O-PR1 of docs/superpowers/specs/2026-08-21-remix-as-fork.md.

- remixOf lineage: engine meta + gem artifact + both wire-schema stacks + Studio echo + uploads-style carry-forward
- importStudio opts (remixOf, genre) — a fork re-derives needs from its own code (D10 tightening)
- GET /api/play/remix-source same-origin proxy, FAIL-CLOSED on allowRemix
- Console: agentgem://play?remix=<key> renders a consent card; fetch + fork happen only on click
- Contract: optional allowRemix/remixOf manifest/row types — NOT sent yet (signature-ordering: enterprise must accept first; O-PR2 flips the console)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch CI and merge**

Run: `gh pr checks --watch` then verify the run's **conclusion** (not just the watch exit
status): `gh run list --branch remix-fork -L 1 --json conclusion`.
Merge: `gh pr merge --rebase --delete-branch` (the local branch-delete step may error
because `main` is checked out elsewhere — the remote merge still succeeds).
Then verify every commit's content landed: `git fetch origin` and grep `origin/main` for a
marker from each commit, e.g.
`git show origin/main:packages/play/src/studio.ts | grep -c ImportOpts` and
`git show origin/main:packages/console/src/panels/Play/RemixConfirm.tsx | head -1` and
`git show origin/main:packages/contract/src/catalog.ts | grep -c CatalogRemixRef`.

---

## Self-Review Notes

- Spec §3.1's seven meta seams map to: Task 1 (#1 `MiniappMeta`, #2 `writeGameGem`+`GameArtifact`),
  Task 2 (#3 `PlaySaveRequestSchema`, #4 `PlayMiniappSchema`, #5 controller projection,
  #6 console mirrors, #7 Studio echo). Carry-forward covered in Task 1.
- Spec §3.6 (proxy) → Task 3; deep link/confirm → Task 4; contract → Task 5; docs → Task 5.
- Deliberately out of this PR (per spec §5/§6): Studio publish checkbox, sending manifest
  fields, aggregator acceptance/enforcement, marketplace UI, `game-remixes` counts,
  originGuard additions (ride O-PR2/E-PR1/E-PR2).
- Type-consistency check: `RemixRef { gemKey, version }` (model) / `CatalogRemixRef`
  (contract, structurally identical, no cross-package dep) / zod `RemixRefSchema` and
  console `PlayRemixRefSchema` all match; `ImportOpts { remixOf?, genre? }` matches the
  controller's call and `playImportRoute`'s body.
