# Gem Review Staging — Console Backend Seam (Plan 2a of 2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the LOCAL server routes (`@api /api/review`) that the console will call to drive the merged aggregator review-staging flow — each route loads the local producer identity, signs the correct review payload, and forwards to `/api/aggregator/review/*`. Fully testable without the console UI (Plan 2b).

**Architecture:** Repo-root `src/` is one AgentBack `RestApplication` mounting both `GemController` (`@api /api`, console-facing) and `AggregatorController` (`@api /api/aggregator`). The console calls local routes; the local route signs with `loadOrCreateIdentity()` and `fetch`-forwards to the aggregator (`AGENTGEM_AGGREGATOR_URL` / `https://api.agentgem.ai`), exactly like `GemController.publishSetup` → `postGemPublish`. This plan adds a new `ReviewController` + a `src/gem/reviewClient.ts` sign+forward module + reuse of `installHosted`'s install path.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), AgentBack (`@agentback/openapi`) controllers, Zod bodies, ed25519 signing (`@agentgem/model` `loadOrCreateIdentity`), Vitest v4.

**Scope:** Plan **2a of 2** — the local backend seam only. **Plan 2b** (console UI: Studio "Request review" button, Reviews inbox panel, group picker) depends on the routes this plan ships. Group *creation/management* is out of scope for all of Plan 2 (MVP requires the author to already be in ≥1 group).

## Global Constraints

- Node floor `>=24`. ESM only; every relative import uses a `.js` specifier.
- The local review routes authenticate to the aggregator by **ed25519 signature** (`loadOrCreateIdentity()` → `identity.sign(<payload>)`), NOT by session bearer — EXCEPT `/review/groups`, which uses the persisted session bearer (`readSession()`), mirroring `webHandoff`.
- Sign the CORRECT payload per route (from `@agentgem/aggregator`): `reviewSubmitPayload(manifest, groupId, pubkey, signedAt)` for submit, `reviewResubmitPayload(manifest, requestId, pubkey, signedAt)` for resubmit, `reviewActionPayload(action, requestId, pubkey, signedAt)` for the 8 action routes (`action` ∈ inbox/get/archive/message:<body>/approve/changes/withdraw/seen; `requestId` is `""` for inbox). NEVER sign `catalogSigningPayload` for a review route (that would be replayable to `/publish-gem`).
- Aggregator base resolves via `resolveBase(endpoint?)`: explicit `endpoint` → `process.env.AGENTGEM_AGGREGATOR_URL` → `"https://api.agentgem.ai"` (copy from `src/gem/catalogShareClient.ts:22-26`).
- Non-2xx forward responses throw `InvalidInputError` (surfaced as 400, not a redacted 500) — copy the error handling from `catalogShareClient`/`gemPublishClient`.
- Tests run against compiled `dist/` (`tsc -b` first). Local run: `pnpm test`. There is a pre-existing unrelated `consoleMount.test.js` failure in a worktree without the console built — ignore it.
- Ownership/attribution is ALWAYS server-derived from the signature (`resolveSignedAccount`) — the local route never sends a client-asserted login/account.

## File Structure

- **Create** `src/gem/reviewClient.ts` — sign+forward functions: `postReviewRequest`, `postReviewResubmit`, `postReviewAction`, `fetchReviewArchive`. One responsibility: build the signed body + POST the aggregator review route + map the result.
- **Create** `src/review.controller.ts` — `ReviewController` (`@api /api/review`): the ~11 local routes the console calls. Builds archive+manifest for submit/resubmit (like `publishSetup`); thin sign+forward for the action routes; install-to-test; groups list.
- **Modify** `src/index.ts` — `app.restController(ReviewController)`.
- **Create** `src/gem/__tests__/reviewClient.test.ts` — client-level (mock `http` + fake `identity`), per `catalogShareClient.test.ts`.
- **Create** `src/__tests__/reviewController.test.ts` — controller-level: `vi.mock` the reviewClient module + `loadOrCreateIdentity`, assert the controller signs/forwards/maps correctly and enforces the consent gate.

---

## Task 1: `reviewClient.ts` — the sign+forward functions

**Files:**
- Create: `src/gem/reviewClient.ts`
- Test: `src/gem/__tests__/reviewClient.test.ts`

**Interfaces:**
- Consumes: `reviewSubmitPayload`, `reviewResubmitPayload`, `reviewActionPayload`, `type CatalogManifest` (`@agentgem/aggregator`); `type Identity` (`@agentgem/model`); the `ShareHttp` type + `InvalidInputError` pattern from `src/gem/catalogShareClient.ts` (read it first).
- Produces:
  ```ts
  export type ReviewHttp = (url: string, init: { method: string; headers: Record<string,string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<any> }>;
  export async function postReviewRequest(args: { manifest: CatalogManifest; archiveBase64: string; groupId: string; description?: string; identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number }): Promise<{ ok: true; requestId: string } | { ok: false; rejected: string }>;
  export async function postReviewResubmit(args: { manifest: CatalogManifest; archiveBase64: string; requestId: string; description?: string; identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number }): Promise<{ ok: true } | { ok: false; rejected: string }>;
  // Generic signed action → returns the aggregator's JSON verbatim (caller shapes it).
  export async function postReviewAction(args: { action: string; requestId: string; path: string; extra?: Record<string, unknown>; identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number }): Promise<any>;
  export async function fetchReviewArchive(args: { requestId: string; identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number }): Promise<Buffer | null>;
  ```
- `postReviewAction` covers inbox (`action:"inbox", requestId:"", path:"/review/inbox"`, returns `{requests}`), get (`action:"get", path:"/review/get"`, `{request}`), message (`action:"message:"+body, path:"/review/message", extra:{body}`), approve/changes/withdraw/seen. The `action` string signed MUST match what the aggregator verifies (for message it is `"message:" + body`).

- [ ] **Step 1: Read the model, then write the failing test**

Read `src/gem/catalogShareClient.ts` fully (the exact `resolveBase`, `ShareHttp`, `InvalidInputError`, non-2xx handling to copy). Then create `src/gem/__tests__/reviewClient.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { postReviewRequest, postReviewAction, fetchReviewArchive } from "../reviewClient.js";

const identity = { publicKey: "ed25519:PUB", sign: (d: string) => "sig:" + d.length };
const manifest = { gemKey: "@team/bot", version: "1.0.0", gemDigest: "sha256:00" } as any;

describe("reviewClient", () => {
  it("postReviewRequest signs reviewSubmitPayload (binds groupId) and POSTs /review/request", async () => {
    const http = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, requestId: "req-1" }) }));
    const r = await postReviewRequest({ manifest, archiveBase64: "AAAA", groupId: "g-1", identity, endpoint: "https://agg.test", http, now: () => 1000 });
    expect(r).toEqual({ ok: true, requestId: "req-1" });
    const [url, init] = http.mock.calls[0];
    expect(url).toBe("https://agg.test/api/aggregator/review/request");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ manifest, archiveBase64: "AAAA", groupId: "g-1", pubkey: "ed25519:PUB", signedAt: 1000 });
    expect(typeof body.signature).toBe("string"); // signed reviewSubmitPayload, not catalogSigningPayload
  });

  it("postReviewAction binds action+requestId and returns the aggregator JSON", async () => {
    const http = vi.fn(async () => ({ status: 200, json: async () => ({ requests: [] }) }));
    const r = await postReviewAction({ action: "inbox", requestId: "", path: "/review/inbox", identity, endpoint: "https://agg.test", http, now: () => 5 });
    expect(r).toEqual({ requests: [] });
    expect(http.mock.calls[0][0]).toBe("https://agg.test/api/aggregator/review/inbox");
  });

  it("fetchReviewArchive decodes archiveBase64 to bytes, or null", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const http = vi.fn(async () => ({ status: 200, json: async () => ({ archiveBase64: bytes.toString("base64") }) }));
    const r = await fetchReviewArchive({ requestId: "req-1", identity, endpoint: "https://agg.test", http, now: () => 5 });
    expect(r && Array.from(r)).toEqual([1, 2, 3]);
    const http2 = vi.fn(async () => ({ status: 200, json: async () => ({ archiveBase64: null }) }));
    expect(await fetchReviewArchive({ requestId: "x", identity, endpoint: "https://agg.test", http: http2 })).toBeNull();
  });

  it("throws InvalidInputError on a non-2xx forward", async () => {
    const http = vi.fn(async () => ({ status: 500, json: async () => ({}) }));
    await expect(postReviewAction({ action: "approve", requestId: "r", path: "/review/approve", identity, endpoint: "https://agg.test", http })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w exec tsc -b && npx vitest run dist/gem/__tests__/reviewClient.test.js`
Expected: FAIL — `../reviewClient.js` does not exist.

- [ ] **Step 3: Implement reviewClient.ts**

Create `src/gem/reviewClient.ts` (copy `resolveBase`, the `http` default, and `InvalidInputError` handling verbatim from `catalogShareClient.ts`; `now` defaults to `Date.now`):

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Local sign+forward client for the aggregator review-staging routes. Mirrors gemPublishClient, but
// signs the review-specific payloads (never catalogSigningPayload) so a captured review request can't
// be replayed to /publish-gem.
import { reviewSubmitPayload, reviewResubmitPayload, reviewActionPayload, type CatalogManifest } from "@agentgem/aggregator";
import type { Identity } from "@agentgem/model";
import { InvalidInputError } from "@agentback/openapi"; // match whatever catalogShareClient imports for its 400

export type ReviewHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<any> }>;

const resolveBase = (endpoint?: string): string =>
  endpoint ?? process.env.AGENTGEM_AGGREGATOR_URL ?? "https://api.agentgem.ai";

const defaultHttp: ReviewHttp = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() };
};

async function forward(base: string, path: string, body: unknown, http: ReviewHttp): Promise<any> {
  const res = await http(`${base}/api/aggregator${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (res.status < 200 || res.status >= 300) throw new InvalidInputError(`review forward failed (${res.status})`);
  return res.json();
}

export async function postReviewRequest(args: { manifest: CatalogManifest; archiveBase64: string; groupId: string; description?: string; identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number }) {
  const now = (args.now ?? Date.now)();
  const signature = args.identity.sign(reviewSubmitPayload(args.manifest, args.groupId, args.identity.publicKey, now));
  const body = { manifest: args.manifest, archiveBase64: args.archiveBase64, groupId: args.groupId, description: args.description, pubkey: args.identity.publicKey, signedAt: now, signature };
  const r = await forward(resolveBase(args.endpoint), "/review/request", body, args.http ?? defaultHttp);
  return r.ok ? { ok: true as const, requestId: r.requestId as string } : { ok: false as const, rejected: r.rejected as string };
}

export async function postReviewResubmit(args: { manifest: CatalogManifest; archiveBase64: string; requestId: string; description?: string; identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number }) {
  const now = (args.now ?? Date.now)();
  const signature = args.identity.sign(reviewResubmitPayload(args.manifest, args.requestId, args.identity.publicKey, now));
  const body = { manifest: args.manifest, archiveBase64: args.archiveBase64, requestId: args.requestId, description: args.description, pubkey: args.identity.publicKey, signedAt: now, signature };
  const r = await forward(resolveBase(args.endpoint), "/review/resubmit", body, args.http ?? defaultHttp);
  return r.ok ? { ok: true as const } : { ok: false as const, rejected: r.rejected as string };
}

export async function postReviewAction(args: { action: string; requestId: string; path: string; extra?: Record<string, unknown>; identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number }): Promise<any> {
  const now = (args.now ?? Date.now)();
  const signature = args.identity.sign(reviewActionPayload(args.action, args.requestId, args.identity.publicKey, now));
  const body = { requestId: args.requestId, ...args.extra, pubkey: args.identity.publicKey, signedAt: now, signature };
  return forward(resolveBase(args.endpoint), args.path, body, args.http ?? defaultHttp);
}

export async function fetchReviewArchive(args: { requestId: string; identity: Identity; endpoint?: string; http?: ReviewHttp; now?: () => number }): Promise<Buffer | null> {
  const r = await postReviewAction({ action: "archive", requestId: args.requestId, path: "/review/archive", identity: args.identity, endpoint: args.endpoint, http: args.http, now: args.now });
  return r.archiveBase64 == null ? null : Buffer.from(r.archiveBase64, "base64");
}
```

> Implementer note: verify the exact `InvalidInputError` import + `http` shape against `src/gem/catalogShareClient.ts` and match it (the error class / import path may differ). If `catalogShareClient` uses a different non-2xx error, use the SAME one.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -w exec tsc -b && npx vitest run dist/gem/__tests__/reviewClient.test.js`
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
git add src/gem/reviewClient.ts src/gem/__tests__/reviewClient.test.ts
git commit -m "feat(review-console): sign+forward client for aggregator review routes"
```

---

## Task 2: `ReviewController` — submit + resubmit routes (build archive+manifest)

**Files:**
- Create: `src/review.controller.ts`
- Modify: `src/index.ts` (register the controller)
- Test: `src/__tests__/reviewController.test.ts`

**Interfaces:**
- Consumes: `readWorkspace` (`@agentgem/base` / wherever `publishSetup` imports it), `readGemArchive` (`@agentgem/archive`), `exportGem` + `importGem` (`@agentgem/distribute`), `loadOrCreateIdentity` (`@agentgem/model`), `postReviewRequest`/`postReviewResubmit` (Task 1). Read `GemController.publishSetup` (`src/gem.controller.ts:620-641`) and copy its archive+manifest build chain EXACTLY.
- Produces: `ReviewController` class with `@post("/request")` and `@post("/resubmit")` under `@api({ basePath: "/api/review" })`.
  ```ts
  const ReviewRequestBody = z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), groupId: z.string(), description: z.string().max(4000).optional() });
  const ReviewRequestResult = z.object({ ok: z.boolean(), requestId: z.string().optional(), rejected: z.string().optional() });
  const ReviewResubmitBody = z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), requestId: z.string(), description: z.string().max(4000).optional() });
  const ReviewActionResult = z.object({ ok: z.boolean(), rejected: z.string().optional() });
  ```
- The manifest built here is IDENTICAL in shape to `publishSetup`'s (gemKey `${scope}/${name ?? workspace}`, version, description, tags, grade, artifactKinds, artifacts, gemDigest) — but do NOT set `visibility` (a staged gem's visibility is decided at publish/approval; the aggregator defaults it).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/reviewController.test.ts`. Mock the reviewClient + identity + workspace-read so the test exercises the controller's build+forward+map logic without HTTP/FS:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentgem/model", async (orig) => ({ ...(await orig()), loadOrCreateIdentity: () => ({ publicKey: "ed25519:PUB", sign: (d: string) => "sig" }) }));
const postReviewRequest = vi.fn();
const postReviewResubmit = vi.fn();
vi.mock("../gem/reviewClient.js", () => ({ postReviewRequest, postReviewResubmit, postReviewAction: vi.fn(), fetchReviewArchive: vi.fn() }));
// Mock the workspace→gem build so no FS is touched; return a minimal gem + bytes.
vi.mock("@agentgem/base", async (orig) => ({ ...(await orig()), readWorkspace: () => ({ files: {} }) }));
vi.mock("@agentgem/archive", async (orig) => ({ ...(await orig()), readGemArchive: () => ({ name: "bot", artifacts: [{ name: "s", type: "skill" }], grade: 2, checks: [], requiredSecrets: [], createdFrom: "x" }) }));
vi.mock("@agentgem/distribute", async (orig) => ({ ...(await orig()), exportGem: () => ({ bytes: Buffer.from([9]) }), importGem: () => ({ meta: { gemDigest: "sha256:zz" }, gem: { artifacts: [], name: "bot", checks: [], requiredSecrets: [], createdFrom: "x" } }) }));

import { ReviewController } from "../review.controller.js";

beforeEach(() => { postReviewRequest.mockReset(); postReviewResubmit.mockReset(); });

describe("ReviewController submit/resubmit", () => {
  it("request builds a manifest (no visibility) and forwards via postReviewRequest, returning requestId", async () => {
    postReviewRequest.mockResolvedValue({ ok: true, requestId: "req-1" });
    const c = new ReviewController();
    const res = await c.request({ body: { workspace: "bot", scope: "team", version: "1.0.0", groupId: "g-1", description: "please" } });
    expect(res).toEqual({ ok: true, requestId: "req-1" });
    const arg = postReviewRequest.mock.calls[0][0];
    expect(arg.groupId).toBe("g-1");
    expect(arg.manifest).toMatchObject({ gemKey: "team/bot", version: "1.0.0", gemDigest: "sha256:zz" });
    expect(arg.manifest.visibility).toBeUndefined(); // staged gems don't carry visibility
    expect(arg.archiveBase64).toBe(Buffer.from([9]).toString("base64"));
  });

  it("request maps a rejection through", async () => {
    postReviewRequest.mockResolvedValue({ ok: false, rejected: "not-scope-owner" });
    const c = new ReviewController();
    expect(await c.request({ body: { workspace: "bot", scope: "team", version: "1.0.0", groupId: "g-1" } })).toEqual({ ok: false, rejected: "not-scope-owner" });
  });

  it("resubmit forwards via postReviewResubmit with the requestId", async () => {
    postReviewResubmit.mockResolvedValue({ ok: true });
    const c = new ReviewController();
    const res = await c.resubmit({ body: { workspace: "bot", scope: "team", version: "1.0.0", requestId: "req-1" } });
    expect(res).toEqual({ ok: true });
    expect(postReviewResubmit.mock.calls[0][0].requestId).toBe("req-1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -w exec tsc -b && npx vitest run dist/__tests__/reviewController.test.js`
Expected: FAIL — `../review.controller.js` does not exist.

- [ ] **Step 3: Implement ReviewController (submit+resubmit) + register**

Read `src/gem.controller.ts:620-641` (publishSetup) for the exact imports + build chain, then create `src/review.controller.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Local console-facing routes that drive the aggregator review-staging flow: build the archive+manifest
// (like publishSetup) or thin-sign+forward (action routes), always signing the review-specific payloads.
import { z } from "zod";
import { api, post, get, AgentError } from "@agentback/openapi";
import { readWorkspace } from "@agentgem/base";
import { readGemArchive } from "@agentgem/archive";
import { exportGem, importGem } from "@agentgem/distribute";
import { loadOrCreateIdentity } from "@agentgem/model";
import type { CatalogManifest } from "@agentgem/aggregator";
import { postReviewRequest, postReviewResubmit } from "./gem/reviewClient.js";

const ReviewRequestBody = z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), groupId: z.string(), description: z.string().max(4000).optional() });
const ReviewRequestResult = z.object({ ok: z.boolean(), requestId: z.string().optional(), rejected: z.string().optional() });
const ReviewResubmitBody = z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), requestId: z.string(), description: z.string().max(4000).optional() });
const ReviewActionResult = z.object({ ok: z.boolean(), rejected: z.string().optional() });

// Build the same manifest publishSetup builds, MINUS visibility (a staged gem's visibility is set at approval).
function buildManifest(b: { workspace: string; scope: string; name?: string; version: string; description?: string }): { manifest: CatalogManifest; archiveBase64: string } {
  const gem = readGemArchive(readWorkspace(b.workspace).files);
  const { bytes } = exportGem(gem, { version: b.version });
  const { meta } = importGem(bytes);
  const manifest = {
    gemKey: `${b.scope}/${b.name ?? b.workspace}`, version: b.version,
    description: b.description, tags: (gem as any).tags, grade: (gem as any).grade,
    artifactKinds: [...new Set(gem.artifacts.map((a) => a.type))],
    artifacts: gem.artifacts.map((a) => ({ name: a.name, type: a.type })),
    gemDigest: meta.gemDigest,
  } as CatalogManifest;
  return { manifest, archiveBase64: bytes.toString("base64") };
}

@api({ basePath: "/api/review" })
export class ReviewController {
  @post("/request", { body: ReviewRequestBody, response: ReviewRequestResult })
  async request(input: { body: z.infer<typeof ReviewRequestBody> }): Promise<z.infer<typeof ReviewRequestResult>> {
    const b = input.body;
    const { manifest, archiveBase64 } = buildManifest(b);
    const r = await postReviewRequest({ manifest, archiveBase64, groupId: b.groupId, description: b.description, identity: loadOrCreateIdentity() });
    return r.ok ? { ok: true, requestId: r.requestId } : { ok: false, rejected: r.rejected };
  }

  @post("/resubmit", { body: ReviewResubmitBody, response: ReviewActionResult })
  async resubmit(input: { body: z.infer<typeof ReviewResubmitBody> }): Promise<z.infer<typeof ReviewActionResult>> {
    const b = input.body;
    const { manifest, archiveBase64 } = buildManifest(b);
    const r = await postReviewResubmit({ manifest, archiveBase64, requestId: b.requestId, description: b.description, identity: loadOrCreateIdentity() });
    return r.ok ? { ok: true } : { ok: false, rejected: r.rejected };
  }
}
```

Register in `src/index.ts` next to the other `app.restController(...)` calls (read the file for the exact block):

```ts
import { ReviewController } from "./review.controller.js";
// ...
app.restController(ReviewController);
```

> Implementer note: verify the exact import specifiers for `readWorkspace`/`readGemArchive`/`exportGem`/`importGem`/`loadOrCreateIdentity` against what `src/gem.controller.ts` uses — match them exactly (package names may differ from the guesses above). If `gem.tags`/`gem.grade` are typed on `Gem`, drop the `as any`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -w exec tsc -b && npx vitest run dist/__tests__/reviewController.test.js`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/review.controller.ts src/index.ts src/__tests__/reviewController.test.ts
git commit -m "feat(review-console): ReviewController submit/resubmit + register"
```

---

## Task 3: Reviewer action routes (inbox/get/message/approve/changes/withdraw/seen)

**Files:**
- Modify: `src/review.controller.ts`
- Test: `src/__tests__/reviewController.test.ts`

**Interfaces:**
- Consumes: `postReviewAction` (Task 1), `loadOrCreateIdentity`.
- Produces these methods on `ReviewController` (all sign the matching `reviewActionPayload` action verb via `postReviewAction`, returning the aggregator JSON shaped to the response schema):
  | Method | Decorator | Body/Query | Signs action | Returns |
  |---|---|---|---|---|
  | `inbox` | `@get("/inbox")` | — | `"inbox"`, `requestId:""` | `{ requests: [...] }` |
  | `getOne` | `@get("/get")` | query `{ requestId }` | `"get"` | `{ request: {...} \| null }` |
  | `message` | `@post("/message")` | `{ requestId, body }` | `"message:"+body`, extra `{body}` | `{ ok, rejected? }` |
  | `approve` | `@post("/approve")` | `{ requestId }` | `"approve"` | `{ ok, gemKey?, version?, rejected? }` |
  | `changes` | `@post("/changes")` | `{ requestId }` | `"changes"` | `{ ok, rejected? }` |
  | `withdraw` | `@post("/withdraw")` | `{ requestId }` | `"withdraw"` | `{ ok, rejected? }` |
  | `seen` | `@post("/seen")` | `{ requestId }` | `"seen"` | `{ ok }` |
- The `inbox`/`get` responses pass the aggregator's `requests`/`request` array/object through (typed loosely as `z.array(z.any())` / `z.any().nullable()`, matching the aggregator's own `ReviewInboxResult`/`ReviewDetailResult`). `get` uses a query param (`requestId`), not a body, since it's a read — but it still signs, so it forwards via `postReviewAction` with `requestId` from the query.

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/reviewController.test.ts` (the `postReviewAction` mock is already in the `vi.mock` from Task 2 — capture it):

```ts
import { postReviewAction } from "../gem/reviewClient.js";
const action = postReviewAction as unknown as ReturnType<typeof vi.fn>;

describe("ReviewController action routes", () => {
  beforeEach(() => action.mockReset());
  it("inbox signs the inbox action and returns requests", async () => {
    action.mockResolvedValue({ requests: [{ id: "r1" }] });
    const res = await new ReviewController().inbox();
    expect(res).toEqual({ requests: [{ id: "r1" }] });
    expect(action.mock.calls[0][0]).toMatchObject({ action: "inbox", requestId: "", path: "/review/inbox" });
  });
  it("message binds the body into the signed action", async () => {
    action.mockResolvedValue({ ok: true });
    await new ReviewController().message({ body: { requestId: "r1", body: "looks good" } });
    expect(action.mock.calls[0][0]).toMatchObject({ action: "message:looks good", requestId: "r1", path: "/review/message", extra: { body: "looks good" } });
  });
  it("approve returns the aggregator result verbatim", async () => {
    action.mockResolvedValue({ ok: true, gemKey: "@team/bot", version: "1.0.0" });
    expect(await new ReviewController().approve({ body: { requestId: "r1" } })).toMatchObject({ ok: true, gemKey: "@team/bot" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -w exec tsc -b && npx vitest run dist/__tests__/reviewController.test.js -t "action routes"`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement the action routes**

Add to `ReviewController` (import `postReviewAction`, extend the reviewClient import). A tiny private helper keeps them DRY:

```ts
  private act(action: string, requestId: string, path: string, extra?: Record<string, unknown>) {
    return postReviewAction({ action, requestId, path, extra, identity: loadOrCreateIdentity() });
  }

  @get("/inbox", { response: z.object({ requests: z.array(z.any()) }) })
  async inbox(): Promise<{ requests: any[] }> { return await this.act("inbox", "", "/review/inbox"); }

  @get("/get", { query: z.object({ requestId: z.string() }), response: z.object({ request: z.any().nullable() }) })
  async getOne(input: { query: { requestId: string } }): Promise<{ request: any }> { return await this.act("get", input.query.requestId, "/review/get"); }

  @post("/message", { body: z.object({ requestId: z.string(), body: z.string().min(1).max(4000) }), response: ReviewActionResult })
  async message(input: { body: { requestId: string; body: string } }): Promise<z.infer<typeof ReviewActionResult>> {
    return await this.act("message:" + input.body.body, input.body.requestId, "/review/message", { body: input.body.body });
  }

  @post("/approve", { body: z.object({ requestId: z.string() }), response: z.object({ ok: z.boolean(), gemKey: z.string().optional(), version: z.string().optional(), rejected: z.string().optional() }) })
  async approve(input: { body: { requestId: string } }) { return await this.act("approve", input.body.requestId, "/review/approve"); }

  @post("/changes", { body: z.object({ requestId: z.string() }), response: ReviewActionResult })
  async changes(input: { body: { requestId: string } }) { return await this.act("changes", input.body.requestId, "/review/changes"); }

  @post("/withdraw", { body: z.object({ requestId: z.string() }), response: ReviewActionResult })
  async withdraw(input: { body: { requestId: string } }) { return await this.act("withdraw", input.body.requestId, "/review/withdraw"); }

  @post("/seen", { body: z.object({ requestId: z.string() }), response: z.object({ ok: z.boolean() }) })
  async seen(input: { body: { requestId: string } }) { return await this.act("seen", input.body.requestId, "/review/seen"); }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -w exec tsc -b && npx vitest run dist/__tests__/reviewController.test.js -t "action routes"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.controller.ts src/__tests__/reviewController.test.ts
git commit -m "feat(review-console): reviewer action routes (inbox/get/message/approve/changes/withdraw/seen)"
```

---

## Task 4: `/review/install` — install-to-test

**Files:**
- Modify: `src/review.controller.ts`
- Test: `src/__tests__/reviewController.test.ts`

**Interfaces:**
- Consumes: `fetchReviewArchive` (Task 1), `importGem` (`@agentgem/distribute`), `executableArtifacts` + `hasExecutable` (`src/gem/hostedInstall.ts`), `createWorkspace` (`@agentgem/base`), `loadOrCreateIdentity`. Read `GemController.installHosted` (`src/gem.controller.ts:652-666`) and mirror its consent gate + `createWorkspace` call.
- Produces:
  ```ts
  const ReviewInstallBody = z.object({ requestId: z.string(), name: z.string().optional(), consent: z.boolean().optional() });
  const ReviewInstallResult = z.object({ workspace: z.string(), executables: z.object({ mcp: z.array(z.string()), hooks: z.array(z.string()) }) });
  @post("/install") async install(...): the staged archive is fetched (signed), importGem-verified, executable-consent-gated (409 consent_required), and materialized via createWorkspace.
  ```

- [ ] **Step 1: Write the failing test**

Append (extend the reviewClient mock to include `fetchReviewArchive`, and mock `hostedInstall` + `createWorkspace`):

```ts
import { fetchReviewArchive } from "../gem/reviewClient.js";
const fetchArch = fetchReviewArchive as unknown as ReturnType<typeof vi.fn>;
vi.mock("../gem/hostedInstall.js", () => ({ executableArtifacts: () => ({ mcp: [], hooks: [] }), hasExecutable: () => false }));
const createWorkspace = vi.fn(() => ({ name: "review-req-1" }));
vi.mock("@agentgem/base", async (orig) => ({ ...(await orig()), readWorkspace: () => ({ files: {} }), createWorkspace }));

describe("ReviewController install-to-test", () => {
  beforeEach(() => { fetchArch.mockReset(); createWorkspace.mockReset(); createWorkspace.mockReturnValue({ name: "review-req-1" }); });
  it("fetches the signed archive, verifies, and creates a workspace when no executables", async () => {
    fetchArch.mockResolvedValue(Buffer.from([9]));
    const res = await new ReviewController().install({ body: { requestId: "req-1" } });
    expect(res).toMatchObject({ workspace: "review-req-1", executables: { mcp: [], hooks: [] } });
    expect(fetchArch.mock.calls[0][0].requestId).toBe("req-1");
  });
  it("returns 404-ish when the archive is gone (null)", async () => {
    fetchArch.mockResolvedValue(null);
    await expect(new ReviewController().install({ body: { requestId: "gone" } })).rejects.toThrow();
  });
});
```
(The executable-consent 409 path is covered by `installHosted`'s own tests; the review install reuses the identical gate, so one no-executable happy-path + the archive-gone case are the task-specific coverage. Add a `hasExecutable: () => true` + `consent` omitted → 409 case too if the implementer can vary the mock per-test.)

- [ ] **Step 2: Run to verify it fails** — `... -t "install-to-test"` → FAIL (method missing).

- [ ] **Step 3: Implement `/review/install`**

```ts
import { fetchReviewArchive } from "./gem/reviewClient.js";
import { executableArtifacts, hasExecutable } from "./gem/hostedInstall.js";
import { createWorkspace } from "@agentgem/base";
import { importGem } from "@agentgem/distribute";

const ReviewInstallBody = z.object({ requestId: z.string(), name: z.string().optional(), consent: z.boolean().optional() });
const ReviewInstallResult = z.object({ workspace: z.string(), executables: z.object({ mcp: z.array(z.string()), hooks: z.array(z.string()) }) });

  @post("/install", { body: ReviewInstallBody, response: ReviewInstallResult })
  async install(input: { body: z.infer<typeof ReviewInstallBody> }): Promise<z.infer<typeof ReviewInstallResult>> {
    const b = input.body;
    const bytes = await fetchReviewArchive({ requestId: b.requestId, identity: loadOrCreateIdentity() });
    if (bytes == null) throw new AgentError("staging archive not available", { status: 404, code: "review_archive_gone", retryable: false });
    const { gem } = importGem(bytes); // verifies gem.lock; throws on tamper
    const executables = executableArtifacts(gem);
    if (hasExecutable(gem) && b.consent !== true) {
      throw new AgentError("this gem runs executable artifacts; install requires consent", { status: 409, code: "consent_required", retryable: false });
    }
    const name = (b.name ?? `review-${b.requestId}`).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "review-gem";
    const ws = createWorkspace(name, gem);
    return { workspace: (ws as any).name ?? name, executables };
  }
```

> Implementer note: match `installHosted`'s exact `createWorkspace` signature + return field (`workspace` vs `.name`) and the consent error code/shape.

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.controller.ts src/__tests__/reviewController.test.ts
git commit -m "feat(review-console): /review/install install-to-test (reuses hostedInstall gate)"
```

---

## Task 5: `/review/groups` — list the author's groups (session-bearer)

**Files:**
- Modify: `src/review.controller.ts`
- Test: `src/__tests__/reviewController.test.ts`

**Interfaces:**
- Consumes: `readSession` + `bindConfig` (`src/bind/bindCore.ts`), and the aggregator route `GET /api/catalog/groups` (session-authed; read `src/groups/install.ts` for its exact response shape). Mirror `webHandoff` (`src/gem.controller.ts:1362-1388`): `readSession()` → Bearer-fetch → on 401 `clearSession()`.
- Produces:
  ```ts
  const ReviewGroupsResult = z.object({ authenticated: z.boolean(), groups: z.array(z.object({ id: z.string(), name: z.string(), role: z.string() })) });
  @get("/groups") async groups(): Promise<...> // { authenticated:false, groups:[] } when no session; else the account's groups
  ```
- This is the ONLY review route using the session bearer (not the signature), because group membership is a session-authed aggregator read. The console uses it to populate the Request-review group picker.

- [ ] **Step 1: Write the failing test**

Append (mock `bindCore` + `fetch`):

```ts
const readSession = vi.fn();
vi.mock("../bind/bindCore.js", () => ({ readSession, clearSession: vi.fn(), bindConfig: () => ({ base: "https://agg.test" }) }));

describe("ReviewController groups", () => {
  beforeEach(() => { readSession.mockReset(); vi.restoreAllMocks(); });
  it("returns authenticated:false with no session", async () => {
    readSession.mockReturnValue(null);
    expect(await new ReviewController().groups()).toEqual({ authenticated: false, groups: [] });
  });
  it("bearer-fetches the aggregator groups list", async () => {
    readSession.mockReturnValue({ sessionToken: "tok" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, json: async () => ({ groups: [{ id: "g1", name: "Team", role: "admin" }] }) })));
    const res = await new ReviewController().groups();
    expect(res).toEqual({ authenticated: true, groups: [{ id: "g1", name: "Team", role: "admin" }] });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (method missing).

- [ ] **Step 3: Implement `/review/groups`**

Read `src/groups/install.ts` for the exact `/api/catalog/groups` response shape (adapt the mapping below to match it), then:

```ts
import { readSession, clearSession, bindConfig } from "./bind/bindCore.js";

const ReviewGroupsResult = z.object({ authenticated: z.boolean(), groups: z.array(z.object({ id: z.string(), name: z.string(), role: z.string() })) });

  @get("/groups", { response: ReviewGroupsResult })
  async groups(): Promise<z.infer<typeof ReviewGroupsResult>> {
    const session = readSession();
    const cfg = bindConfig();
    if (!session || !cfg.base) return { authenticated: false, groups: [] };
    const res = await fetch(new URL("/api/catalog/groups", cfg.base), { headers: { Authorization: `Bearer ${session.sessionToken}` } });
    if (res.status === 401) { clearSession(); return { authenticated: false, groups: [] }; }
    if (res.status < 200 || res.status >= 300) return { authenticated: true, groups: [] };
    const data = await res.json() as { groups?: { id: string; name: string; role: string }[] };
    return { authenticated: true, groups: (data.groups ?? []).map((g) => ({ id: g.id, name: g.name, role: g.role })) };
  }
```

> Implementer note: `/api/catalog/groups`'s real field names may differ (e.g. it might return `{ id, name, kind, role }` or a bare array) — read `src/groups/install.ts` and map to `{ id, name, role }` exactly.

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.controller.ts src/__tests__/reviewController.test.ts
git commit -m "feat(review-console): /review/groups list (session-bearer -> aggregator)"
```

---

## Task 6: Full-suite regression + PR

- [ ] **Step 1:** `pnpm test` — full suite green except the known unrelated `consoleMount.test.js`. `tsc -b` clean.
- [ ] **Step 2:** Push `feat/review-console`, open a PR against `main` titled "feat: gem review staging — console backend seam (Plan 2a)". Body: summarize the local ReviewController + sign+forward client; note it depends on the merged aggregator `/review/*` routes; note Plan 2b (console UI) follows. End with the Co-Authored-By line.
- [ ] **Step 3:** Watch CI (`gh run watch <id> --exit-status`), merge `--rebase --delete-branch` once green (verify each commit landed on `origin/main`, per the repo's dropped-commit trap).

## Self-Review

- **Spec coverage:** the local seam for every aggregator review route is present — submit (T2), resubmit (T2), the 7 action routes (T3), install-to-test (T4), groups (T5). Each signs the correct review payload (never `catalogSigningPayload`). ✓
- **Placeholder scan:** no TBD/TODO; every step has real code. The "implementer note" callouts flag exact-signature verifications against existing files (`publishSetup`, `installHosted`, `webHandoff`, `groups/install.ts`) — deliberate, since those signatures must be matched to the real code, not guessed. ✓
- **Type consistency:** `reviewClient` fn names (`postReviewRequest`/`postReviewResubmit`/`postReviewAction`/`fetchReviewArchive`) are used verbatim by `ReviewController`; `buildManifest` shared by request/resubmit; the `act()` helper by all action routes. ✓
- **Auth correctness:** signature path for all routes except `/review/groups` (session bearer) — the one deliberate exception, matching how the aggregator gates group reads. ✓

## Follow-on: Plan 2b (console UI)

Not in this plan. Plan 2b adds: `api/routes.ts` client routes (`reviewRequestRoute`, `reviewInboxRoute`, `reviewGetRoute`, `reviewApproveRoute`, …, `reviewGroupsRoute`) calling these local endpoints; a Studio "Request review" button (in the `.play-studio-head` row) with a group picker fed by `/review/groups` (disabled with a hint when the author has 0 groups); a `panels/Reviews/` inbox panel (fetch-list + a polling unread badge); registration via the 3-edit pages.tsx pattern. It depends on the routes this plan ships.
