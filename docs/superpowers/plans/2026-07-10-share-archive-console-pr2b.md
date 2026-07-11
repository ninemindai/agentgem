# Share-Archive Console (PR 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the console's Play/Studio panel, a user can mint a copyable unlisted share link for a locally-authored miniapp, and revoke it later (across restarts), with a connect prompt when their identity isn't bound.

**Architecture:** A sidecar `share.json` per miniapp persists its shareId durably. A `shareArchiveClient` signs and calls PR 2a's `/api/aggregator/share-archive` (mint) and `/share-archive/revoke`. Two loopback routes on `PlayController` (`/api/play/share`, `/api/play/revoke`) build the miniapp's archive bytes (reusing `publishSetup`'s pattern), call the client, and read/write the sidecar; the miniapp read surfaces the persisted share state. Studio gains a light "Copy share link" / "Revoke link" affordance beside the existing publish button, reusing its `pendingPublish`/`ConnectGitHub` bind-resume.

**Tech Stack:** TypeScript; AgentBack REST controllers + Zod; React 19 console (jsdom/Vitest); ed25519 via `@agentgem/model`; gem archive via `@agentgem/distribute`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md` — *Minting*, *Revocation* (esp. the "Durable revoke (PR 2b)" paragraph).
- **Worktree:** `../agentgem-share-console`, branch `feat/miniapp-share-console`, off `origin/main`. Do not commit to `main`.
- **Server (PR 2a) is already on the base branch:** `POST /api/aggregator/share-archive` (body `{ manifest, archiveBase64, pubkey, signedAt, signature }`, response `{ key, url }`; `manifest.gemDigest` is REQUIRED) and `POST /api/aggregator/share-archive/revoke` (body `{ key, pubkey, signedAt, signature }`, response `{ revoked }`). Mint signs `catalogSigningPayload(manifest, pubkey, now)`; revoke signs the plain string `revoke:<key>:<signedAt>`.
- **Light-share requires a connected identity.** An unbound console → show the connect prompt (reuse Studio's `pendingPublish` + `ConnectGitHub`), exactly as the existing publish button does. `identity.bound && identity.login`.
- **Persist the shareId in a sidecar `share.json`**, NOT in `MiniappMeta`.
- **Server tests run compiled `dist/`** — `pnpm build` then `pnpm exec vitest run dist/…`. **Console tests are NOT in CI** — run `pnpm -C packages/console exec vitest run …` locally. `packages/*/src/__tests__` are NOT in CI either; test package logic through a `src/__tests__` loopback test (which IS in CI) where it matters.
- **`AgentError` uses `.statusCode`.** Run tests single-threaded (`--no-file-parallelism`) if the machine has competing worktree vitest processes.
- Reuse `postGemPublish`'s injectable `{ http?, endpoint?, now? }` seams so the client is testable without a network.

---

### Task 1: sidecar share-state helpers in `@agentgem/play`

Persist/read/clear a miniapp's shareId. These live in `@agentgem/play` because they know the registry dir layout.

**Files:**
- Create: `packages/play/src/miniappShare.ts`
- Modify: `packages/play/src/index.ts` (export the new helpers)
- Test: `src/__tests__/miniappShare.test.ts` (create — a `src/`-level test so CI runs it; imports from `@agentgem/play`)

**Interfaces:**
- Consumes: `miniappDir(name)` / the registry-dir resolver in `packages/play/src/miniapps.ts` (read it to find the exact helper that maps a name → its dir; the sidecar sits beside `meta.json`).
- Produces:
  - `interface MiniappShare { shareId: string; url: string; sharedAtMs: number }`
  - `readMiniappShare(name: string): MiniappShare | null`
  - `writeMiniappShare(name: string, share: MiniappShare): void`
  - `clearMiniappShare(name: string): void`

- [ ] **Step 1: Read the registry layout**

Open `packages/play/src/miniapps.ts` and find how a miniapp `name` maps to its directory (e.g. `miniappDir(name)` or `join(miniappsRoot(), safePathSegment(name))`) and how `meta.json` is written there. Your sidecar `share.json` sits in that same dir. Note whether writes are git-committed (`commitWithLock`) — the sidecar does NOT need a commit for durability (a plain file write persists across restarts); keep it simple with `writeFileSync`, matching how a non-content file would be handled.

- [ ] **Step 2: Write the failing test**

Create `src/__tests__/miniappShare.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankStudio, readMiniappShare, writeMiniappShare, clearMiniappShare } from "@agentgem/play";

beforeEach(() => { process.env.AGENTGEM_HOME = mkdtempSync(join(tmpdir(), "share-")); });

describe("miniapp share sidecar", () => {
  it("round-trips a share record and clears it", async () => {
    const { name } = await blankStudio("My Game", "build me a game");
    expect(readMiniappShare(name)).toBeNull();
    writeMiniappShare(name, { shareId: "xK3f9a2Bq1", url: "https://app.agentgem.ai/games/xK3f9a2Bq1", sharedAtMs: 1 });
    expect(readMiniappShare(name)).toEqual({ shareId: "xK3f9a2Bq1", url: "https://app.agentgem.ai/games/xK3f9a2Bq1", sharedAtMs: 1 });
    clearMiniappShare(name);
    expect(readMiniappShare(name)).toBeNull();
  });

  it("returns null for a miniapp that was never shared", async () => {
    const { name } = await blankStudio("Other", "x");
    expect(readMiniappShare(name)).toBeNull();
  });
});
```

(Confirm `blankStudio` is the right way to create a miniapp for the test by reading `miniapps.ts`; if it needs different args, match the existing `src/__tests__` usage of the play registry. `AGENTGEM_HOME` isolates the registry to a temp dir — this is the established isolation used by `gem.controller.test.ts`.)

- [ ] **Step 3: Run to verify it fails**

```bash
pnpm build && pnpm exec vitest run dist/__tests__/miniappShare.test.js
```

Expected: FAIL at build — the three helpers are not exported.

- [ ] **Step 4: Implement**

Create `packages/play/src/miniappShare.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Durable per-miniapp share state: the aggregator shareId minted for a miniapp, so the console can
// show + revoke a link across restarts. A sidecar `share.json` beside meta.json — deliberately NOT in
// MiniappMeta, which writeGameGem bakes into the shared gem and saveMiniapp reconstructs field-by-field.
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { miniappDir } from "./miniapps.js";   // adjust to the actual name→dir resolver in miniapps.ts

export interface MiniappShare { shareId: string; url: string; sharedAtMs: number }

const sharePath = (name: string): string => join(miniappDir(name), "share.json");

export function readMiniappShare(name: string): MiniappShare | null {
  const p = sharePath(name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as MiniappShare; } catch { return null; }
}

export function writeMiniappShare(name: string, share: MiniappShare): void {
  writeFileSync(sharePath(name), JSON.stringify(share, null, 2));
}

export function clearMiniappShare(name: string): void {
  rmSync(sharePath(name), { force: true });
}
```

If `miniappDir` is not exported from `miniapps.ts`, export it there (it's a pure `join(miniappsRoot(), safePathSegment(name))` helper) or use the exact resolver the file already has. Add the three functions + the type to `packages/play/src/index.ts`'s exports.

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm build && pnpm exec vitest run dist/__tests__/miniappShare.test.js
```

Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/play/src/miniappShare.ts packages/play/src/index.ts packages/play/src/miniapps.ts src/__tests__/miniappShare.test.ts
git commit -m "feat(play): durable per-miniapp share sidecar (share.json)"
```

---

### Task 2: `shareArchiveClient` — sign + call the mint/revoke API

**Files:**
- Create: `src/gem/shareArchiveClient.ts`
- Test: `src/__tests__/shareArchiveClient.test.ts` (create)

**Interfaces:**
- Consumes: `Identity` (`@agentgem/model`), `catalogSigningPayload` + `CatalogManifest` (`@agentgem/aggregator`), `ShareHttp` (`./catalogShareClient.js`). Model on `src/gem/gemPublishClient.ts` (read it — same base-URL resolution, same injectable `http`/`endpoint`/`now`).
- Produces:
  - `postShareArchive(args: { manifest: CatalogManifest; archiveBase64: string; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number }): Promise<{ ok: true; key: string; url: string } | { ok: false; rejected: string }>`
  - `postShareArchiveRevoke(args: { key: string; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number }): Promise<{ ok: true } | { ok: false; rejected: string }>`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/shareArchiveClient.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { postShareArchive, postShareArchiveRevoke } from "../gem/shareArchiveClient.js";

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { publicKey: pub, sign: (d: string) => edSign(null, Buffer.from(d, "utf8"), privateKey).toString("base64") };
}

describe("shareArchiveClient", () => {
  it("mint: POSTs a signed body to /share-archive and returns key+url", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const http = async (url: string, init: { body: string }) => { calls.push({ url, body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ key: "xK3f9a2Bq1", url: "https://app.agentgem.ai/games/xK3f9a2Bq1" }) }; };
    const res = await postShareArchive({ manifest: { gemKey: "_", version: "1", gemDigest: "sha256:abc" }, archiveBase64: "AA==", identity: identity(), endpoint: "https://api.test", http, now: () => 1000 });
    expect(res).toEqual({ ok: true, key: "xK3f9a2Bq1", url: "https://app.agentgem.ai/games/xK3f9a2Bq1" });
    expect(calls[0].url).toBe("https://api.test/api/aggregator/share-archive");
    expect(calls[0].body).toMatchObject({ pubkey: expect.stringMatching(/^ed25519:/), signedAt: 1000 });
  });

  it("revoke: signs revoke:<key>:<signedAt> and POSTs to /share-archive/revoke", async () => {
    const id = identity();
    let sent: { key: string; pubkey: string; signedAt: number; signature: string } | null = null;
    const http = async (_url: string, init: { body: string }) => { sent = JSON.parse(init.body); return { status: 200, json: async () => ({ revoked: true }) }; };
    const res = await postShareArchiveRevoke({ key: "xK3f9a2Bq1", identity: id, endpoint: "https://api.test", http, now: () => 2000 });
    expect(res).toEqual({ ok: true });
    // the signature must verify over exactly revoke:<key>:<signedAt>
    const spki = Buffer.from(id.publicKey.slice("ed25519:".length), "base64");
    const key = { key: spki, format: "der" as const, type: "spki" as const };
    expect(edVerify(null, Buffer.from(`revoke:xK3f9a2Bq1:2000`), { key: spki, format: "der", type: "spki" } as never, Buffer.from(sent!.signature, "base64"))).toBe(true);
  });

  it("surfaces a non-2xx as { ok: false }", async () => {
    const http = async () => ({ status: 401, json: async () => ({ code: "not-connected" }) });
    const res = await postShareArchive({ manifest: { gemKey: "_", version: "1", gemDigest: "x" }, archiveBase64: "AA==", identity: identity(), endpoint: "https://api.test", http, now: () => 1 });
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm build && pnpm exec vitest run dist/__tests__/shareArchiveClient.test.js
```

Expected: FAIL at build — module not found.

- [ ] **Step 3: Implement**

Read `src/gem/gemPublishClient.ts` first and mirror its structure exactly (base URL resolution via `AGENTGEM_AGGREGATOR_URL`, `defaultHttp` with a 30s timeout, the `ShareHttp` type). Create `src/gem/shareArchiveClient.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Signs and calls PR 2a's unlisted share endpoints with the local producer key. Mirrors
// gemPublishClient.ts, but hits /share-archive (mint → {key,url}) and /share-archive/revoke.
import type { Identity } from "@agentgem/model";
import { catalogSigningPayload, type CatalogManifest } from "@agentgem/aggregator";
import type { ShareHttp } from "./catalogShareClient.js";

const defaultHttp: ShareHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: () => res.json() };
};

const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";
function resolveBase(endpoint: string | undefined): string {
  if (endpoint !== undefined) return endpoint;
  return process.env.AGENTGEM_AGGREGATOR_URL ?? DEFAULT_AGGREGATOR_URL;
}

export async function postShareArchive(args: {
  manifest: CatalogManifest; archiveBase64: string; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number;
}): Promise<{ ok: true; key: string; url: string } | { ok: false; rejected: string }> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(catalogSigningPayload(args.manifest, args.identity.publicKey, now));
  const res = await http(`${base}/api/aggregator/share-archive`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest: args.manifest, archiveBase64: args.archiveBase64, pubkey: args.identity.publicKey, signedAt: now, signature }),
  });
  if (res.status < 200 || res.status >= 300) return { ok: false, rejected: `HTTP ${res.status}` };
  const b = (await res.json()) as { key?: string; url?: string };
  return b.key && b.url ? { ok: true, key: b.key, url: b.url } : { ok: false, rejected: "unexpected response" };
}

export async function postShareArchiveRevoke(args: {
  key: string; identity: Identity; endpoint?: string; http?: ShareHttp; now?: () => number;
}): Promise<{ ok: true } | { ok: false; rejected: string }> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const now = (args.now ?? (() => Date.now()))();
  const signature = args.identity.sign(`revoke:${args.key}:${now}`);
  const res = await http(`${base}/api/aggregator/share-archive/revoke`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: args.key, pubkey: args.identity.publicKey, signedAt: now, signature }),
  });
  if (res.status < 200 || res.status >= 300) return { ok: false, rejected: `HTTP ${res.status}` };
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm build && pnpm exec vitest run dist/__tests__/shareArchiveClient.test.js
```

Expected: PASS, 3 tests. (If the revoke `edVerify` call's key form errors, use `createPublicKey({ key: spki, format: "der", type: "spki" })` and pass that — match how other tests in `src/__tests__` verify an ed25519 signature; read one if unsure.)

- [ ] **Step 5: Commit**

```bash
git add src/gem/shareArchiveClient.ts src/__tests__/shareArchiveClient.test.ts
git commit -m "feat(gem): shareArchiveClient — signed mint + revoke to the share-archive API"
```

---

### Task 3: loopback routes `/api/play/share` + `/api/play/revoke`, and surface share state on the miniapp read

**Files:**
- Modify: `src/play.controller.ts` (two `@post` routes; enrich the `miniapp` GET)
- Modify: `src/schemas.ts` (`PlayShareRequest/Response`, `PlayRevokeRequest/Response`; add `share` to `PlayMiniappSchema`)
- Test: `src/__tests__/playShare.controller.test.ts` (create — a real end-to-end loopback test with a stubbed aggregator)

**Interfaces:**
- Consumes: `postShareArchive`, `postShareArchiveRevoke` (Task 2); `readMiniappShare`, `writeMiniappShare`, `clearMiniappShare` (Task 1); `loadOrCreateIdentity` (`@agentgem/model`); `exportGem`/`importGem` (`@agentgem/distribute`); the workspace→bytes helpers `publishSetup` uses (`readWorkspace`, `readGemArchive` — read `src/gem.controller.ts:614-632` for the exact pattern).
- Produces: `POST /api/play/share` `{ name }` → `{ url }`; `POST /api/play/revoke` `{ name }` → `{ revoked }`; `GET /api/play/miniapp` response gains optional `share?: { shareId, url, sharedAtMs }`.

Read `src/gem.controller.ts` `publishSetup` (lines ~614-632) for the exact byte-building: a miniapp `name` is a valid workspace, so `readGemArchive(readWorkspace(name).files)` → `exportGem(gem, { version })` → `importGem(bytes).meta.gemDigest`. The share route builds the SAME manifest but with `gemKey: "_"` (unused for shares — the server mints a `genShareId`) and calls `postShareArchive`, then persists the sidecar.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/playShare.controller.test.ts`. Isolate `AGENTGEM_HOME` to a temp dir, stub the aggregator with a local `createServer` (the pattern in `gem.controller.test.ts` ~lines 702-704), point `AGENTGEM_AGGREGATOR_URL` at it, create a miniapp, then drive share → assert the sidecar persists and the miniapp read surfaces it → revoke → assert cleared. (Read `gem.controller.test.ts` for the exact app-bootstrap + stub-server idiom, and use a bound-identity setup if the mint requires one — the STUB decides what to return, so the console-side test just needs the stub to return `{ key, url }` regardless of signature.)

```ts
// Skeleton — fill bootstrap from gem.controller.test.ts's idiom.
// 1. AGENTGEM_HOME = tmp; start a stub http server that returns {key:"s1",url:"https://app.agentgem.ai/games/s1"}
//    for POST /api/aggregator/share-archive and {revoked:true} for /revoke; set AGENTGEM_AGGREGATOR_URL to it.
// 2. blankStudio("G","x") -> name; save it so the workspace/gem exists.
// 3. POST /api/play/share {name} -> expect { url: "https://app.agentgem.ai/games/s1" }
// 4. GET /api/play/miniapp?name -> expect body.share.shareId === "s1"
// 5. POST /api/play/revoke {name} -> expect { revoked: true }
// 6. GET /api/play/miniapp?name -> expect body.share === undefined
```

Write it as real `supertest` calls following `gem.controller.test.ts`. Do NOT leave the skeleton comments in the committed test — they are a guide; replace with actual code.

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm build && pnpm exec vitest run dist/__tests__/playShare.controller.test.js
```

Expected: FAIL — routes not defined.

- [ ] **Step 3: Add schemas**

In `src/schemas.ts`, add:

```ts
export const PlayShareRequestSchema = z.object({ name: z.string() });
export const PlayShareResponseSchema = z.object({ url: z.string() });
export const PlayRevokeRequestSchema = z.object({ name: z.string() });
export const PlayRevokeResponseSchema = z.object({ revoked: z.boolean() });
```

and extend `PlayMiniappSchema` with an optional `share`:

```ts
  share: z.object({ shareId: z.string(), url: z.string(), sharedAtMs: z.number() }).optional(),
```

- [ ] **Step 4: Implement the routes**

In `src/play.controller.ts`, import the new deps (`loadOrCreateIdentity`, `exportGem`/`importGem`, `readWorkspace`/`readGemArchive`, `postShareArchive`/`postShareArchiveRevoke`, `readMiniappShare`/`writeMiniappShare`/`clearMiniappShare`, the new schemas) and add:

```ts
  // Light unlisted share: build the miniapp's portable archive (a miniapp name IS a workspace, same as
  // publishSetup), mint an unlisted /games/<id> link owned by the local identity's account, and persist
  // the shareId so revoke works across restarts. Requires a connected identity server-side (the aggregator
  // rejects an unbound key); the console shows a connect prompt before calling this.
  @post("/play/share", { body: PlayShareRequestSchema, response: PlayShareResponseSchema })
  async share(input: { body: z.infer<typeof PlayShareRequestSchema> }): Promise<z.infer<typeof PlayShareResponseSchema>> {
    const { name } = input.body;
    let bytes: Buffer, digest: string;
    try {
      const gem = readGemArchive(readWorkspace(name).files);
      bytes = exportGem(gem, { version: "1" }).bytes;
      digest = importGem(bytes).meta.gemDigest;
    } catch (e) { throw new AgentError(`could not read miniapp: ${(e as Error).message}`, { status: 404 }); }
    const manifest = { gemKey: "_", version: "1", gemDigest: digest };
    const r = await postShareArchive({ manifest, archiveBase64: bytes.toString("base64"), identity: loadOrCreateIdentity() });
    if (!r.ok) throw new AgentError(`share failed: ${r.rejected}`, { status: 400 });
    writeMiniappShare(name, { shareId: r.key, url: r.url, sharedAtMs: Date.now() });
    return { url: r.url };
  }

  @post("/play/revoke", { body: PlayRevokeRequestSchema, response: PlayRevokeResponseSchema })
  async revoke(input: { body: z.infer<typeof PlayRevokeRequestSchema> }): Promise<z.infer<typeof PlayRevokeResponseSchema>> {
    const cur = readMiniappShare(input.body.name);
    if (!cur) throw new AgentError("miniapp is not shared", { status: 404 });
    const r = await postShareArchiveRevoke({ key: cur.shareId, identity: loadOrCreateIdentity() });
    if (!r.ok) throw new AgentError(`revoke failed: ${r.rejected}`, { status: 400 });
    clearMiniappShare(input.body.name);
    return { revoked: true };
  }
```

Then enrich the existing `miniapp` GET (line ~93) to include the sidecar:

```ts
      const share = readMiniappShare(input.query.name);
      return { name: r.name, html: r.html, meta: { ... }, ...(share ? { share } : {}) };
```

(`readWorkspace`/`readGemArchive` are what `publishSetup` uses — confirm the exact import source in `gem.controller.ts` and match it. If a miniapp's workspace read differs from a setup-gem's, use the miniapp-specific reader; the goal is the same portable `.gem` bytes.)

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm build && pnpm exec vitest run dist/__tests__/playShare.controller.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/play.controller.ts src/schemas.ts src/__tests__/playShare.controller.test.ts
git commit -m "feat(play): /api/play/share + /revoke loopback routes; surface share state on miniapp read"
```

---

### Task 4: console routes + Studio "Copy share link" / "Revoke link" UI

**Files:**
- Modify: `packages/console/src/api/routes.ts` (`shareMiniappRoute`, `revokeMiniappRoute`; add `share` to `playMiniappRoute`'s response)
- Modify: `packages/console/src/panels/Play/Studio.tsx` (the light-share affordance)
- Test: `packages/console/src/panels/Play/__tests__/StudioShareLink.test.tsx` (create)

**Interfaces:**
- Consumes: the Task 3 routes; Studio's existing `pendingPublish`/`ConnectGitHub`/`useGitHubBind` machinery and `useIdentity`.
- Produces: a "Copy share link" button (mint-if-unshared / copy-if-shared) + "Revoke link", persistent from the miniapp read's `share`.

- [ ] **Step 1: Add the console routes**

In `packages/console/src/api/routes.ts`:

```ts
export const shareMiniappRoute = defineRoute("POST", "/api/play/share", {
  body: z.object({ name: z.string() }), response: z.object({ url: z.string() }),
});
export const revokeMiniappRoute = defineRoute("POST", "/api/play/revoke", {
  body: z.object({ name: z.string() }), response: z.object({ revoked: z.boolean() }),
});
```

and extend `playMiniappRoute`'s `response` to include the optional `share` (match the server `PlayMiniappSchema`): add `share: z.object({ shareId: z.string(), url: z.string(), sharedAtMs: z.number() }).optional()` to that route's response object.

- [ ] **Step 2: Write the failing component test**

Create `packages/console/src/panels/Play/__tests__/StudioShareLink.test.tsx`, modeled on the existing `StudioShare.test.tsx` (read it for the `IdentityProvider` mount + route-mock idiom). Cover:
- **Bound + unshared:** clicking "Copy share link" calls `shareMiniappRoute` and shows the returned `/games/<id>` URL with Copy + Revoke.
- **Already shared (from the miniapp read's `share`):** the URL + Revoke render on load without a mint call.
- **Revoke:** clicking "Revoke link" calls `revokeMiniappRoute` and the shared banner disappears.
- **Unbound:** clicking "Copy share link" shows the connect prompt (does NOT call `shareMiniappRoute`).

```tsx
// Model exactly on StudioShare.test.tsx: mount <Studio> in <IdentityProvider apiBase="">, mock
// bindStatusRoute (bound:true/false), playMiniappRoute (return { ..., share? }), playSaveRoute,
// shareMiniappRoute, revokeMiniappRoute. Drive with fireEvent, assert on button roles + banner text +
// mock.calls. afterEach(cleanup + restoreAllMocks). Fill in from that file's concrete idiom.
```

Write real assertions, not the comment. Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/StudioShareLink.test.tsx`.

- [ ] **Step 3: Implement the Studio UI**

Add state + handlers near the existing share machinery (read Studio.tsx lines 46-234 for exact placement). Sketch (adapt to the file's real style):

```tsx
// state: a shared URL, from the miniapp read on load OR after a mint.
const [shareLink, setShareLink] = useState<string | null>(null);
const [pendingShare, setPendingShare] = useState(false);   // Copy-share clicked while unbound

// In refresh()/load, adopt the persisted share: on the playMiniappRoute result, setShareLink(cur.share?.url ?? null).

async function copyShareLink() {
  if (shareLink) { navigator.clipboard?.writeText(shareLink); setStatus("link copied ✓"); return; }
  setStatus("minting link…");
  if (!(await save())) return;
  if (!(identity?.bound && identity.login)) { setStatus(""); setPendingShare(true); return; }
  await mintShare();
}
async function mintShare() {
  try {
    const r = await shareMiniappRoute.call(makeClient(apiBase), { body: { name } });
    setShareLink(r.url); navigator.clipboard?.writeText(r.url); setStatus("link copied ✓");
  } catch (e) { setStatus(`share failed: ${(e as Error).message}`); }
}
async function revokeShareLink() {
  setStatus("revoking…");
  try { await revokeMiniappRoute.call(makeClient(apiBase), { body: { name } }); setShareLink(null); setStatus("link revoked ✓"); }
  catch (e) { setStatus(`revoke failed: ${(e as Error).message}`); }
}
```

Wire `pendingShare` into the bind-resume (extend the existing `useGitHubBind` `onBound` to also resume a pending SHARE, mirroring `pendingPublish`), add a "Copy share link" button in the head beside "Share to app.agentgem.ai", and render a shared-link banner (URL + Copy + Revoke) when `shareLink`, plus a connect banner when `pendingShare` (reuse the `ConnectGitHub` block). Keep the light-share visually distinct from the heavy publish (it's a `play-btn`, not `play-btn--primary`).

- [ ] **Step 4: Run to verify green + typecheck**

```bash
pnpm -C packages/console exec vitest run src/panels/Play/__tests__/StudioShareLink.test.tsx
pnpm -C packages/console exec tsc -p tsconfig.json --noEmit
```

Expected: PASS + clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/__tests__/StudioShareLink.test.tsx
git commit -m "feat(console): Copy share link / Revoke link in Studio, persistent across restarts"
```

---

### Task 5: verify end-to-end, then open the PR

- [ ] **Step 1: Full server suite + console suite + builds**

```bash
pnpm test
pnpm -C packages/console exec vitest run
pnpm -C packages/console exec tsc -p tsconfig.json --noEmit
pnpm build
```

Expected: server + console green, typecheck + build clean. (Run single-threaded if the machine has competing worktree vitest processes; a timeout is contention, not a failure.)

- [ ] **Step 2: Drive the real console**

Launch the console, open Play → a miniapp → Studio, and confirm: "Copy share link" (bound) mints a `/games/<id>` link and copies it; the banner shows Copy + Revoke; reload the panel and the shared state persists; "Revoke link" clears it; while unbound, "Copy share link" shows the connect prompt. This is the flow tests can't fully prove.

- [ ] **Step 3: Confirm branch ahead of origin/main only, push, PR**

```bash
git fetch origin && git rev-list --left-right --count origin/main...HEAD
git push -u origin feat/miniapp-share-console
gh pr create --title "feat: share-archive console — Copy/Revoke miniapp links (PR 2b)" --body "$(cat <<'EOF'
Console leg of PR 2 from `docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md`. Consumes the PR 2a server routes.

From Play → Studio, a miniapp gets a light **Copy share link** (unlisted `app.agentgem.ai/games/<id>`) and a **Revoke link**, durable across restarts.

- sidecar `share.json` per miniapp persists the shareId (not `MiniappMeta`)
- `shareArchiveClient` signs + calls `/api/aggregator/share-archive` (mint) and `/share-archive/revoke`
- loopback `/api/play/share` + `/api/play/revoke`; the miniapp read surfaces persisted share state
- Studio "Copy share link" / "Revoke link" reusing the existing connect-when-unbound bind-resume

Light-share requires a connected identity (an unconnected device owns nothing) — the console shows the connect prompt. Console tests are local-only (not CI); run and green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch CI, merge, verify each commit landed**

```bash
gh run watch <run-id> --exit-status
gh pr merge --rebase --delete-branch
```

`--delete-branch` errors on the local delete (`main` checked out elsewhere) but the remote merge lands — verify `gh pr view <n> --json state` is `MERGED`, then grep `origin/main` for a marker from each commit (`miniappShare`, `shareArchiveClient`, `/api/play/share`, `shareMiniappRoute`). Note: CI does NOT run the console tests — the Studio UI is guarded only by local runs, so Step 2's manual drive is load-bearing.
