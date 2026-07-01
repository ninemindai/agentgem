# Marketplace Gem-Upload Publish (#5-publish, marketplace half) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in user uploads a `.gem` on app.agentgem.ai → a session-authed endpoint publishes it with `publishedBy` attribution + a `scope === login` safety rail.

**Architecture:** A raw-express `installRegistryUploadPublish` (session → 401/403 rail → `importGem` → `publishGem` with `publishedBy`), originGuard-exempt + index-wired (M2-A pattern). A marketplace `makeUpload` client (FileReader→base64, credentialed POST) + a `Publish` page + nav threading.

**Tech Stack:** TypeScript ESM, raw express, `@agentgem/aggregator` (sessions/test-db), `@agentgem/distribute` (`importGem`/`publishGem`/`githubRegistry*`), Vite/React marketplace, vitest. Spec: `docs/superpowers/specs/2026-06-30-marketplace-upload-publish-design.md`.

## Global Constraints

- **Base branch:** `feat/upload-publish`, already cut from `origin/main`. Do not re-cut.
- **Git identity:** `Raymond Feng <raymond@ninemind.ai>`; commit messages end `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Stage explicitly; verify `git show --stat HEAD`.
- **ESM:** server `.js` relative imports; marketplace **extensionless**; package imports extensionless.
- **Security rail (non-negotiable):** no session → **401**; `scope !== who.login` → **403**; checks run **before** `importGem` (don't process untrusted bytes until authorized). `publishedBy = who.login` (verified, never from the body). `importGem` rejects tampering (→ 400).
- **Server tests** run from compiled dist (`pnpm exec tsc -b` first). Marketplace: `pnpm --filter @agentgem/marketplace test|typecheck|build`.
- **No real GitHub in tests** — inject a fake `source` (getIndex) + a `capturingPublisher` (the `registryPublish.test.ts` helper).
- **Surgical/hot files** — `originGuard.ts`, `index.ts`, marketplace `Router.tsx`/`App.tsx`: additive diffs.

---

### Task 1: the upload-publish endpoint (`src/registry/uploadPublish.ts`)

**Files:**
- Create: `src/registry/uploadPublish.ts`
- Test: `src/registry/__tests__/uploadPublish.test.ts`

**Interfaces:**
- Consumes: `resolveSession`, `type AppDb`, `makeTestDb`/`upsertAccount`/`createSession`/`generateSessionToken` (`@agentgem/aggregator`, tests); `parseCookies`, `SESSION_COOKIE` (`../auth/cookie.js`); `importGem`, `publishGem`, `type RegistrySource`, `type RegistryPublisher`, `type RegistryIndex` (`@agentgem/distribute`); `resolvePublishType`, `defaultGemTypeRegistry`, `type GemTypeRegistry` (`../gem/gemTypeRegistry.js`).
- Produces: `installRegistryUploadPublish(expressApp, deps)` + `uploadPublishHandler(deps)`; `interface UploadPublishDeps { db: AppDb; webOrigins: string[]; source: RegistrySource; publisher: RegistryPublisher; gemTypes: GemTypeRegistry }`.

- [ ] **Step 1: Write the failing test**

Create `src/registry/__tests__/uploadPublish.test.ts` (mirror `authInstall.test.ts`'s mockReq/mockRes + `registryPublish.test.ts`'s capturingPublisher; build real `.gem` bytes via `exportGem`):
```ts
import { describe, it, expect } from "vitest";
import { makeTestDb, upsertAccount, createSession, generateSessionToken } from "@agentgem/aggregator";
import { exportGem, type RegistryPublisher, type RegistrySource, type RegistryIndex } from "@agentgem/distribute";
import { uploadPublishHandler } from "../uploadPublish.js";
import { SESSION_COOKIE } from "../auth/cookie.js";
import { defaultGemTypeRegistry } from "../../gem/gemTypeRegistry.js";
import type { Gem } from "@agentgem/model";

const gem: Gem = { name: "test-gem", createdFrom: "/d", checks: [], requiredSecrets: [],
  artifacts: [{ type: "skill", name: "t", source: "standalone", content: "# T" }] };
const gemBase64 = () => exportGem(gem, { version: "1.0.0" }).bytes.toString("base64");

function capturing(): { publisher: RegistryPublisher; commits: { files: unknown; message: string }[] } {
  const commits: { files: unknown; message: string }[] = [];
  return { commits, publisher: { async putCommit(files, message) { commits.push({ files, message }); return { commit: "abc" }; } } };
}
const emptySource = (): RegistrySource => ({ id:"t", label:"t", ready:()=>true, async getIndex(){ return { formatVersion:1, items:{} } as RegistryIndex; }, async fetchItem(){ return {}; } });
const mkRes = () => { const r: any = { _s: 200, _h: {}, _b: undefined };
  r.status=(c:number)=>{r._s=c;return r;}; r.set=(k:string,v:string)=>{r._h[k.toLowerCase()]=v;return r;};
  r.json=(b:unknown)=>{r._b=b;return r;}; r.send=(b:unknown)=>{r._b=b;return r;}; return r; };
const mkReq = (over: any = {}) => ({ method:"POST", path:"/api/registry/upload-publish", headers:{}, body:{}, ...over });
const deps = (db: any, publisher: RegistryPublisher) => ({ db, webOrigins:["https://app.agentgem.ai"], source: emptySource(), publisher, gemTypes: defaultGemTypeRegistry });
async function session(db: any, login: string) { const a = await upsertAccount(db, { provider:"github", accountId:"1", login }); const { token } = generateSessionToken(); await createSession(db, a.id, token, 60_000); return token; }

describe("upload-publish", () => {
  it("401s without a session", async () => {
    const db = await makeTestDb(); const { publisher } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ body: { scope:"x", version:"1.0.0", bytesBase64: gemBase64() } }) as any, res as any);
    expect(res._s).toBe(401);
  });
  it("403s when scope !== login (the safety rail)", async () => {
    const db = await makeTestDb(); const token = await session(db, "alice"); const { publisher } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ headers:{ cookie:`${SESSION_COOKIE}=${token}`, origin:"https://app.agentgem.ai" }, body:{ scope:"bob", version:"1.0.0", bytesBase64: gemBase64() } }) as any, res as any);
    expect(res._s).toBe(403);
  });
  it("publishes + stamps publishedBy when scope === login", async () => {
    const db = await makeTestDb(); const token = await session(db, "alice"); const { publisher, commits } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ headers:{ cookie:`${SESSION_COOKIE}=${token}`, origin:"https://app.agentgem.ai" }, body:{ scope:"alice", version:"1.0.0", tags:["x"], bytesBase64: gemBase64() } }) as any, res as any);
    expect(res._s).toBe(200);
    expect((res._b as any).ref).toBe("@alice/test-gem");
    const idx = JSON.parse((commits[0].files as any)["registry.json"]);
    expect(idx.items["@alice/test-gem"].discovery.publishedBy).toBe("alice"); // VERIFIED attribution
    expect(res._h["access-control-allow-origin"]).toBe("https://app.agentgem.ai");
    expect(res._h["access-control-allow-credentials"]).toBe("true");
  });
  it("400s on tampered bytes (gem.lock fails)", async () => {
    const db = await makeTestDb(); const token = await session(db, "alice"); const { publisher } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ headers:{ cookie:`${SESSION_COOKIE}=${token}` }, body:{ scope:"alice", version:"1.0.0", bytesBase64: Buffer.from("not a gem").toString("base64") } }) as any, res as any);
    expect(res._s).toBe(400);
  });
  it("OPTIONS preflight → 204 with credentialed CORS", async () => {
    const db = await makeTestDb(); const { publisher } = capturing(); const res = mkRes();
    await uploadPublishHandler(deps(db, publisher))(mkReq({ method:"OPTIONS", headers:{ origin:"https://app.agentgem.ai" } }) as any, res as any);
    expect(res._s).toBe(204);
    expect(res._h["access-control-allow-origin"]).toBe("https://app.agentgem.ai");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/registry/__tests__/uploadPublish.test.js`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `uploadPublish.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/registry/uploadPublish.ts
//
// Signed-in .gem upload → publish, with #4a attribution (publishedBy = the verified
// session login) and a scope===login safety rail (you may only publish under your own
// handle). Raw-express + credentialed CORS + originGuard-exempt, mirroring auth/stars.
// The richer scope-ownership model (org/claimed) is #4b. importGem rejects tampering.
import type { AppDb } from "@agentgem/aggregator";
import { resolveSession } from "@agentgem/aggregator";
import { importGem, publishGem, type RegistrySource, type RegistryPublisher } from "@agentgem/distribute";
import { parseCookies, SESSION_COOKIE } from "../auth/cookie.js";
import { resolvePublishType, type GemTypeRegistry } from "../gem/gemTypeRegistry.js";

export interface UploadPublishDeps { db: AppDb; webOrigins: string[]; source: RegistrySource; publisher: RegistryPublisher; gemTypes: GemTypeRegistry }
type Req = { method?: string; headers: Record<string, string | undefined>; body?: Record<string, unknown> };
type Res = { status(c: number): Res; set(k: string, v: string): Res; json(b: unknown): Res; send(b: unknown): Res };

function cors(req: Req, res: Res, origins: string[]): void {
  const origin = req.headers["origin"];
  if (origin && origins.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Vary", "Origin");
  }
}

export function uploadPublishHandler(deps: UploadPublishDeps) {
  return async (req: Req, res: Res): Promise<void> => {
    cors(req, res, deps.webOrigins);
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS").set("Access-Control-Allow-Headers", "content-type").status(204).send("");
      return;
    }
    const token = parseCookies(req.headers["cookie"])[SESSION_COOKIE];
    const who = token ? await resolveSession(deps.db, token) : null;
    if (!who) { res.status(401).json({ error: "sign in required" }); return; }

    const body = (req.body ?? {}) as { scope?: unknown; version?: unknown; name?: unknown; tags?: unknown; description?: unknown; type?: unknown; bytesBase64?: unknown };
    const scope = typeof body.scope === "string" ? body.scope.trim() : "";
    const version = typeof body.version === "string" ? body.version.trim() : "";
    if (!scope || !version) { res.status(400).json({ error: "scope and version are required" }); return; }
    // SAFETY RAIL: you may only publish under your own login (the #4b model is deferred).
    if (scope !== who.login) { res.status(403).json({ error: `you can only publish under your own login (@${who.login})` }); return; }
    if (typeof body.bytesBase64 !== "string") { res.status(400).json({ error: "bytesBase64 is required" }); return; }

    try {
      const { gem } = importGem(Buffer.from(body.bytesBase64, "base64")); // throws on tamper/parse
      const type = resolvePublishType(deps.gemTypes, typeof body.type === "string" ? body.type : undefined, gem);
      const index = await deps.source.getIndex();                         // fresh per request
      const result = await publishGem({
        gem, scope, version,
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
        tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        index, publisher: deps.publisher, type,
        publishedBy: who.login,                                            // VERIFIED attribution (#4a)
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  };
}

export function installRegistryUploadPublish(expressApp: { post(p: string, h: unknown): void; options(p: string, h: unknown): void }, deps: UploadPublishDeps): void {
  const h = uploadPublishHandler(deps);
  expressApp.post("/api/registry/upload-publish", h as never);
  expressApp.options("/api/registry/upload-publish", h as never);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/registry/__tests__/uploadPublish.test.js`
Expected: PASS (401 / 403-rail / 200+publishedBy / 400-tamper / OPTIONS).

- [ ] **Step 5: Commit**

```bash
git add src/registry/uploadPublish.ts src/registry/__tests__/uploadPublish.test.ts
git commit -m "feat(registry): session-authed .gem upload-publish (publishedBy + scope===login rail)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: originGuard exemption + index wiring

**Files:**
- Modify: `src/originGuard.ts` (exempt the upload-publish path)
- Modify: `src/index.ts` (mount `installRegistryUploadPublish`)
- Test: `src/__tests__/originGuard.test.ts` (extend)

**Interfaces:** Consumes `installRegistryUploadPublish` (Task 1), `registryConfigFromEnv`, `githubRegistrySource`, `githubRegistryPublisher` (`@agentgem/distribute`), `defaultGemTypeRegistry` (`./gem/gemTypeRegistry.js`).

- [ ] **Step 1: Write the failing test**

In `src/__tests__/originGuard.test.ts`, add (mirror the existing `/api/stars` cross-site exemption test):
```ts
  it("exempts a cross-site POST /api/registry/upload-publish (credentialed publish)", () => {
    // drive the guard with Sec-Fetch-Site: cross-site on the upload-publish path → next() called (not blocked)
    // (mirror the file's existing stars cross-site test exactly)
  });
```
(Match the file's real guard-driving harness; assert `next` is called and the response is NOT the cross-site-blocked error.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/originGuard.test.js`
Expected: FAIL — the path is still blocked cross-site.

- [ ] **Step 3: Implement**

`src/originGuard.ts` — extend the exemption branch (line ~55):
```ts
if (req.path.startsWith("/api/auth/") || req.path.startsWith("/api/stars") || req.path.startsWith("/api/registry/upload-publish")) { next(); return; }
```

`src/index.ts` — after the `installStars` block, add (import `installRegistryUploadPublish` from `./registry/uploadPublish.js`, `registryConfigFromEnv`/`githubRegistrySource`/`githubRegistryPublisher` from `@agentgem/distribute`, `defaultGemTypeRegistry` from `./gem/gemTypeRegistry.js`):
```ts
  const regCfg = registryConfigFromEnv();
  if (aggDb && webOrigins.length > 0 && regCfg) {
    installRegistryUploadPublish(server.expressApp as never, {
      db: aggDb, webOrigins,
      source: githubRegistrySource(regCfg), publisher: githubRegistryPublisher(regCfg),
      gemTypes: defaultGemTypeRegistry,
    });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/originGuard.test.js`
Expected: PASS (the upload-publish path is exempt; non-exempt cross-site still blocks).

- [ ] **Step 5: Commit**

```bash
git add src/originGuard.ts src/index.ts src/__tests__/originGuard.test.ts
git commit -m "feat(registry): mount upload-publish + originGuard exemption

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: marketplace upload client + Publish page + nav

**Files:**
- Create: `packages/marketplace/src/upload.ts`, `packages/marketplace/src/pages/Publish.tsx`
- Modify: `packages/marketplace/src/Router.tsx` (add `me` prop + `/publish` route), `packages/marketplace/src/App.tsx` (thread `me` + header "Publish" link)
- Test: `packages/marketplace/src/upload.test.ts`, `packages/marketplace/src/pages/Publish.test.tsx`

**Interfaces:** Consumes `Me` (`../auth`), `makeApi`/`defaultApiBase` (existing). Produces `makeUpload(base)` + `Publish` page.

- [ ] **Step 1: Write the failing tests**

`packages/marketplace/src/upload.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeUpload, NotSignedIn } from "./upload";

afterEach(() => vi.unstubAllGlobals());
const res = (body: unknown, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(body) }) as Response;
// a fake File whose base64 we control via a stubbed FileReader
class FakeReader { result = ""; onload: (() => void) | null = null;
  readAsDataURL() { this.result = "data:application/octet-stream;base64,QUJD"; this.onload?.(); } }

describe("makeUpload", () => {
  it("base64s the file + credentialed POST, returns the ref", async () => {
    vi.stubGlobal("FileReader", FakeReader as never);
    let opts: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => { opts = o; return res({ ref: "@alice/g", version: "1.0.0", path: "p" }); }));
    const r = await makeUpload("https://api").publish({ file: { name: "g.gem" } as File, scope: "alice", version: "1.0.0" });
    expect(r.ref).toBe("@alice/g");
    expect(opts?.credentials).toBe("include");
    expect(JSON.parse(String(opts?.body)).bytesBase64).toBe("QUJD");
  });
  it("throws NotSignedIn on 401", async () => {
    vi.stubGlobal("FileReader", FakeReader as never);
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "sign in required" }, false, 401)));
    await expect(makeUpload("https://api").publish({ file: { name: "g.gem" } as File, scope: "a", version: "1.0.0" })).rejects.toBeInstanceOf(NotSignedIn);
  });
});
```

`packages/marketplace/src/pages/Publish.test.tsx`:
```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Publish } from "./Publish";

afterEach(() => cleanup());
describe("Publish", () => {
  it("prompts sign-in when signed out", () => {
    render(<Publish api={{} as never} me={null} base="" />);
    expect(screen.getByText(/sign in to publish/i)).toBeTruthy();
  });
  it("shows the publish form (scope defaults to the login) when signed in", () => {
    render(<Publish api={{} as never} me={{ login: "alice", avatarUrl: null }} base="" />);
    expect((screen.getByLabelText(/scope/i) as HTMLInputElement).value).toBe("alice");
    expect(screen.getByLabelText(/\.gem/i)).toBeTruthy(); // the file input
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @agentgem/marketplace test -- upload Publish`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement**

`packages/marketplace/src/upload.ts`:
```ts
export class NotSignedIn extends Error { constructor() { super("not signed in"); this.name = "NotSignedIn"; } }

// FileReader.readAsDataURL is the browser-safe way to base64 a File (no Buffer / no
// String.fromCharCode spread overflow). Strip the "data:...;base64," prefix.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("could not read the file"));
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(",") + 1)); };
    r.readAsDataURL(file);
  });
}

export function makeUpload(base: string) {
  return {
    async publish(args: { file: File; scope: string; version: string; name?: string; tags?: string[] }): Promise<{ ref: string; version: string; path: string }> {
      const bytesBase64 = await fileToBase64(args.file);
      const r = await fetch(base + "/api/registry/upload-publish", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: args.scope, version: args.version, name: args.name, tags: args.tags, bytesBase64 }),
      });
      if (r.status === 401) throw new NotSignedIn();
      if (!r.ok) throw new Error(await r.text());
      return (await r.json()) as { ref: string; version: string; path: string };
    },
  };
}
```

`packages/marketplace/src/pages/Publish.tsx` — a signed-in-gated form (file input with `aria-label` containing ".gem"; `scope` input defaulting to `me.login` with `aria-label` "scope"; `version`; `tags`); on submit `makeUpload(base).publish(...)` → success line with the ref + a link to `/gems/<ref>`, or error. Signed-out → "Sign in to publish your gems." + the sign-in link. (Reuse the `ex-*` CSS; mirror the `Gems`/`StarButton` style.)

`packages/marketplace/src/Router.tsx` — add `me: Me | null` to the props (import `type { Me } from "./auth"`); add `if (path === "/publish") return <Publish api={api} me={me} base={defaultApiBase()} />;` (import `Publish` + `defaultApiBase`).

`packages/marketplace/src/App.tsx` — pass `me={me}` into `<Router ... />`; add a header link `{me && <a href="/publish" className="ex-navlink">Publish</a>}` near the sign-in/out control.

- [ ] **Step 4: Run to verify they pass + gates**

Run: `pnpm --filter @agentgem/marketplace test && pnpm --filter @agentgem/marketplace typecheck && pnpm --filter @agentgem/marketplace build`
Expected: whole marketplace suite PASS + typecheck + build clean.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/upload.ts packages/marketplace/src/upload.test.ts packages/marketplace/src/pages/Publish.tsx packages/marketplace/src/pages/Publish.test.tsx packages/marketplace/src/Router.tsx packages/marketplace/src/App.tsx
git commit -m "feat(marketplace): gem-upload Publish page + credentialed upload client

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- Server: `pnpm exec tsc -b` clean; `pnpm exec vitest run dist/registry/__tests__/uploadPublish.test.js dist/__tests__/originGuard.test.js` pass; full `pnpm test` green (build console first; known real-FS flakes aside).
- Marketplace: `pnpm --filter @agentgem/marketplace test|typecheck|build` clean.

## The result this delivers

A signed-in user uploads a `.gem` on app.agentgem.ai and publishes it to the registry — stamped with verified `publishedBy` (the live consumer of #4a) and gated by the `scope === login` safety rail. The hosted complement to the console publish panel (A). Org/claimed-scope ownership stays #4b.
