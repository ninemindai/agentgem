# OG-Unfurl Worker (PR 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pasted `app.agentgem.ai/games/<key>` link unfurls with the game's title + description (a `summary` card, no image) in Slack/iMessage/Twitter, while still serving the full SPA so the game plays.

**Architecture:** Put a thin Cloudflare Worker in front of the marketplace's Workers Static Assets (currently assets-only). For `GET /games/<key>` it fetches `game-meta` server-to-server and injects `og:*`/`twitter:card=summary` meta into the SPA shell's `<head>`; every other request — and any failure — passes straight through to `env.ASSETS.fetch`. Copies the `website/edge` `main`+`[assets]`+`run_worker_first` pattern.

**Tech Stack:** Cloudflare Workers (`export default { fetch }`), wrangler; Vitest (jsdom, marketplace suite).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md` — the `packages/marketplace/src/worker.ts` bullet in *Files*, and the `og:image` non-goal (summary card, NO image, no resvg).
- **Worktree:** `../agentgem-og-worker`, branch `feat/games-og-unfurl`, off `origin/main`. Do not commit to `main`.
- **THIS IS PR 3a — the Worker ONLY.** No route renames, no conformance test, no CI wiring (those are PR 3b). Touch only the worker, `wrangler.jsonc`, and the worker test.
- **`run_worker_first` runs the worker on EVERY request to `app.agentgem.ai`.** A bug takes down the whole marketplace, not just unfurls. So: the worker MUST fall through to `env.ASSETS.fetch(request)` for every non-`/games/` request, and MUST serve `env.ASSETS.fetch(request)` unmodified on ANY error in the games branch (no `AGGREGATOR_API`, non-2xx `game-meta`, fetch throw, missing title). Wrap the whole games branch in try/catch. Degradation is the top priority.
- **No `og:image`** — a `summary` card only (`og:title`, `og:description`, `og:type`, `og:url`, `twitter:card=summary`, `twitter:title`, `twitter:description`). Mirror `website/edge/src/share.js`'s `renderGemShareHtml` and its `esc()` — but inject into the SPA shell, do NOT replace the document.
- **`game-meta` returns `{ title, genre, version }`** and is public (`GET ${AGGREGATOR_API}/api/aggregator/game-meta?key=<key>`). The worker reads its own runtime `env.AGGREGATOR_API` (a wrangler `var`), NOT the build-time `VITE_API_BASE`.
- **Marketplace tests run via `pnpm --filter @agentgem/marketplace test`** (jsdom, `include: src/**/*.test.{ts,tsx}`). NOT in CI yet (that's 3b) — run locally. The suite is green at baseline (38 files / 256 tests).

---

### Task 1: `worker.ts` — the OG-injecting fetch handler

**Files:**
- Create: `packages/marketplace/src/worker.ts`
- Test: `packages/marketplace/src/worker.test.ts`

**Interfaces:**
- Produces: `export default { async fetch(request: Request, env: { ASSETS: { fetch(r: Request): Promise<Response> }; AGGREGATOR_API?: string }): Promise<Response> }`.
- Self-contained (no import from SPA modules): inline the games-path regex and the `esc`/inject helpers.

- [ ] **Step 1: Write the failing test**

Create `packages/marketplace/src/worker.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import worker from "./worker";

const SHELL = `<!doctype html><html><head><meta charset="UTF-8"/><title>AgentGem</title></head><body><div id="root"></div></body></html>`;

// env whose ASSETS always returns the SPA shell; fetch (for game-meta) is stubbed per test.
function env(over: Partial<{ AGGREGATOR_API: string }> = {}) {
  return { ASSETS: { fetch: vi.fn(async () => new Response(SHELL, { headers: { "content-type": "text/html" } })) }, AGGREGATOR_API: "https://api.test", ...over };
}
const req = (path: string, method = "GET") => new Request(`https://app.agentgem.ai${path}`, { method });

describe("marketplace OG worker", () => {
  it("injects og:title/description into the shell for a /games/<key> with a known game", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ title: "Tetris", genre: "project-fun", version: "1" }), { status: 200 })));
    const res = await worker.fetch(req("/games/@acme/tetris"), env());
    const html = await res.text();
    expect(html).toContain(`<meta property="og:title" content="Tetris">`);
    expect(html).toContain(`<meta name="twitter:card" content="summary">`);
    expect(html).toContain(`<meta property="og:url" content="https://app.agentgem.ai/games/@acme/tetris">`);
    expect(html).not.toContain("og:image");            // summary card, no image
    expect(html).toContain(`<div id="root"></div>`);   // full SPA body preserved
  });

  it("escapes a title containing \" and <", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ title: `A"B<C`, genre: "project-fun", version: "1" }), { status: 200 })));
    const html = await (await worker.fetch(req("/games/x"), env())).text();
    expect(html).toContain(`content="A&quot;B&lt;C"`);
    expect(html).not.toContain(`content="A"B<C"`);
  });

  it("serves the shell UNMODIFIED when game-meta 404s (unknown key)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const html = await (await worker.fetch(req("/games/nope"), env())).text();
    expect(html).toBe(SHELL);
  });

  it("serves the shell UNMODIFIED when game-meta fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const html = await (await worker.fetch(req("/games/x"), env())).text();
    expect(html).toBe(SHELL);
  });

  it("serves UNMODIFIED (no meta fetch attempted) when AGGREGATOR_API is unset", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const e = env({ AGGREGATOR_API: undefined });
    const html = await (await worker.fetch(req("/games/x"), e)).text();
    expect(html).toBe(SHELL);
    expect(f).not.toHaveBeenCalled();                  // no meta call without a base
  });

  it("passes every non-/games request straight to env.ASSETS", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const e = env();
    await worker.fetch(req("/gems/@acme/foo"), e);
    await worker.fetch(req("/"), e);
    expect(e.ASSETS.fetch).toHaveBeenCalledTimes(2);
    expect(f).not.toHaveBeenCalled();                  // no game-meta call for non-games paths
  });

  it("passes a non-GET /games request through untouched (no injection)", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const e = env();
    const html = await (await worker.fetch(req("/games/x", "POST"), e)).text();
    expect(html).toBe(SHELL);
    expect(f).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm --filter @agentgem/marketplace exec vitest run src/worker.test.ts
```

Expected: FAIL — `./worker` not found.

- [ ] **Step 3: Implement**

Create `packages/marketplace/src/worker.ts`:

```ts
// Cloudflare Worker in front of the marketplace's static assets. Its ONLY job is to give a
// /games/<key> link a title/description unfurl (a summary card, no image) by injecting og:* meta
// into the SPA shell's <head>; the full SPA body is preserved so React still hydrates and plays.
//
// run_worker_first (wrangler.jsonc) runs this on EVERY request to app.agentgem.ai, so the
// overriding rule is: fall through to env.ASSETS.fetch(request) for anything that isn't a
// GET /games/<key> we can enrich, and on ANY error. A worker bug must never take down the site.
//
// Mirrors website/edge/src/share.js's renderGemShareHtml + esc(), but injects into the shell
// rather than replacing the document.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  AGGREGATOR_API?: string;
}

const GAMES = /^\/games\/(.+)$/;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

function ogTags(title: string, url: string): string {
  const t = esc(title), u = esc(url);
  return (
    `<meta property="og:title" content="${t}">` +
    `<meta property="og:description" content="Play ${t} on AgentGem">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:url" content="${u}">` +
    `<meta name="twitter:card" content="summary">` +
    `<meta name="twitter:title" content="${t}">` +
    `<meta name="twitter:description" content="Play ${t} on AgentGem">`
  );
}

// Inject the tags just before </head>, and replace the static <title>AgentGem</title> so the tab +
// unfurl title match the game. String ops only (the shell is tiny and stable); no HTML parser.
function injectHead(html: string, title: string, url: string): string {
  return html
    .replace(/<title>[^<]*<\/title>/i, `<title>${esc(title)} — AgentGem</title>`)
    .replace(/<\/head>/i, `${ogTags(title, url)}</head>`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = request.method === "GET" ? url.pathname.match(GAMES) : null;
    if (!m || !env.AGGREGATOR_API) return env.ASSETS.fetch(request);

    try {
      const key = m[1];   // raw (matches Play.tsx's greedy parse); the API takes it as a query param
      const metaRes = await fetch(`${env.AGGREGATOR_API}/api/aggregator/game-meta?key=${encodeURIComponent(key)}`);
      if (!metaRes.ok) return env.ASSETS.fetch(request);
      const meta = (await metaRes.json()) as { title?: unknown };
      if (typeof meta.title !== "string") return env.ASSETS.fetch(request);

      const assetRes = await env.ASSETS.fetch(request);
      const html = await assetRes.text();
      const out = injectHead(html, meta.title, url.toString());
      // Preserve the asset response's headers/status, but DROP content-length: the injected body
      // is longer than the shell, and a stale content-length would truncate the response.
      const headers = new Headers(assetRes.headers);
      headers.delete("content-length");
      return new Response(out, { status: assetRes.status, headers });
    } catch {
      return env.ASSETS.fetch(request);   // any failure → the unmodified SPA
    }
  },
};
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm --filter @agentgem/marketplace exec vitest run src/worker.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/marketplace/src/worker.ts packages/marketplace/src/worker.test.ts
git commit -m "feat(marketplace): OG-unfurl worker — inject summary meta for /games/:key, else pass through"
```

---

### Task 2: wrangler.jsonc — front the assets with the worker

**Files:**
- Modify: `packages/marketplace/wrangler.jsonc`

- [ ] **Step 1: Edit the config**

In `packages/marketplace/wrangler.jsonc`, add `"main"`, add `"binding"` + `"run_worker_first"` to the `assets` block, and add `"vars"`. The result's runtime fields:

```jsonc
  "name": "agentgem-app",
  "main": "src/worker.ts",
  "compatibility_date": "2026-06-23",
  "account_id": "8c60d6f6b0408a55768ec315042db967",

  "workers_dev": false,
  "routes": [{ "pattern": "app.agentgem.ai", "custom_domain": true }],

  "vars": { "AGGREGATOR_API": "https://api.agentgem.ai" },

  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "run_worker_first": true,
    "not_found_handling": "single-page-application"
  }
```

Update the file's header comment: it currently says "assets-only, no worker script" — change it to describe the OG-injection worker (mirror `website/edge/wrangler.toml`'s `run_worker_first` rationale: without it Cloudflare serves the asset directly and never invokes the worker, so the injection branch would be dead code). Keep `not_found_handling` — the SPA fallback still applies to the `env.ASSETS.fetch` the worker delegates to.

- [ ] **Step 2: Validate the config + worker bundle without deploying**

```bash
pnpm --filter @agentgem/marketplace build
cd packages/marketplace && npx --yes wrangler@4.103.0 deploy --dry-run --outdir /tmp/og-worker-dry 2>&1 | tail -20; cd ../..
```

Expected: the dry-run bundles `src/worker.ts` and reports the `ASSETS` binding + the `AGGREGATOR_API` var with NO errors (a dry-run does not touch Cloudflare). If wrangler complains that `main` + `assets` need `run_worker_first` or the binding, fix per its message. If `wrangler@4.103.0` isn't the repo's pinned version, use the version `deploy-worker.yml` names.

- [ ] **Step 3: Commit**

```bash
git add packages/marketplace/wrangler.jsonc
git commit -m "feat(marketplace): run the OG worker in front of static assets (main + run_worker_first + AGGREGATOR_API)"
```

---

### Task 3: verify end-to-end, then open the PR

- [ ] **Step 1: Marketplace suite + typecheck + build (worker must not regress the SPA)**

```bash
pnpm --filter @agentgem/marketplace test
pnpm --filter @agentgem/marketplace exec tsc -p tsconfig.json --noEmit
pnpm --filter @agentgem/marketplace build
```

Expected: full suite green (256 baseline + 7 new), typecheck clean, build clean. The worker is not part of the Vite build — wrangler bundles it — but `tsc --noEmit` typechecks it.

- [ ] **Step 2: Drive the worker locally against the SPA + real API**

`wrangler dev` runs the worker + serves `dist/` locally. Confirm the injection AND the pass-through in a real worker runtime:

```bash
cd packages/marketplace && npx --yes wrangler@4.103.0 dev --port 8790 &
# wait for "Ready on http://localhost:8790"
```

Then (in another shell): `curl -s http://localhost:8790/games/<a-real-published-game-key> | grep -i 'og:title'` should show the game's title (game-meta on prod resolves it); `curl -s http://localhost:8790/ | grep -c 'og:title'` should be `0` (home page untouched); `curl -s http://localhost:8790/games/definitely-not-real | grep -c 'og:title'` should be `0` (unknown key → unmodified). Kill `wrangler dev` after. If `game-meta` isn't deployed on prod yet, the unknown-key/unmodified behavior still verifies the degradation path; note it in the PR.

- [ ] **Step 3: Confirm branch ahead of origin/main only, push, PR**

```bash
git fetch origin && git rev-list --left-right --count origin/main...HEAD
git push -u origin feat/games-og-unfurl
gh pr create --title "feat: OG-unfurl worker for /games links (PR 3a)" --body "$(cat <<'EOF'
PR 3a of the entity-address scheme (`docs/superpowers/specs/2026-07-09-entity-address-scheme-design.md`). Split out from the renames (3b) because it's deploy-affecting.

Puts a thin Cloudflare Worker in front of the marketplace's static assets. A pasted `app.agentgem.ai/games/<key>` link now unfurls with the game's **title + description** (a `summary` card — no image) while still serving the full SPA so the game plays.

- `worker.ts` — for `GET /games/<key>`, fetch `game-meta` server-to-server and inject `og:*`/`twitter:card=summary` into the SPA shell's `<head>`; **every other request, and any failure (no `AGGREGATOR_API`, non-2xx meta, fetch throw), passes straight through to `env.ASSETS.fetch` unmodified**
- `wrangler.jsonc` — `main` + `assets.binding` + `run_worker_first` + `vars.AGGREGATOR_API`, mirroring `website/edge`

## ⚠️ Deploy risk
`run_worker_first` runs the worker on EVERY request to `app.agentgem.ai`. The degradation path (fall through to `env.ASSETS` on anything unexpected) is load-bearing and is tested. Watch the deploy; roll back this Worker alone if anything regresses.

## Not in this PR
Plural route renames + router conformance test + wiring the marketplace into CI are **PR 3b**.

## Test plan
- 7 worker unit tests (inject / escape / 404-unmodified / throw-unmodified / no-API-unmodified / non-games passthrough / non-GET passthrough)
- Full marketplace suite green (256 + 7); typecheck + build clean
- `wrangler deploy --dry-run` bundles clean; drove `wrangler dev` locally (injection + passthrough + unknown-key degradation)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Watch CI, merge, verify, then WATCH THE DEPLOY**

```bash
gh run watch <run-id> --exit-status
gh pr merge --rebase --delete-branch
```

`--delete-branch` errors on the local delete (`main` checked out elsewhere) but the remote merge lands — verify `gh pr view <n> --json state` is `MERGED`, then grep `origin/main:packages/marketplace/wrangler.jsonc` for `run_worker_first` and `origin/main:packages/marketplace/src/worker.ts` for `og:title`.

**Then watch the marketplace deploy** (`deploy-worker.yml`'s `deploy-marketplace` job fires on the merge). After it completes, curl the LIVE site: `curl -s https://app.agentgem.ai/ | grep -c og:title` must be `0` (home unaffected — proves the worker didn't break normal serving), and a real `/games/<key>` should show `og:title`. If the live home page breaks, the worker's pass-through regressed — the rollback is reverting this one PR.
