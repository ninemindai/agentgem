# MCP Connectors PR-4b: Repo Pulse Demo Miniapp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the built-in **Repo Pulse** demo miniapp — a GitHub dashboard that exercises the MCP connectors stack (`agentgemApp.mcp`) end-to-end — plus the real-browser E2E proof against the fake connector first (D14), per `docs/superpowers/specs/2026-07-16-miniapp-mcp-connectors-design.md` §6–7.

**Architecture:** Repo Pulse follows the served-constant built-in pattern (`EMBER_HTML`/`EMBER_META` in `packages/play/src/ember.ts`): a module-level `REPO_PULSE_HTML` + `REPO_PULSE_META` pair, never written to the registry, listed in `/api/play/miniapps` and special-cased by name in the read route. It is the first built-in with `mcpNeeds`, which exposes a server-side gap: the `mcp/call` and `mcp/servers` routes resolve the manifest via `readMiniapp(name)`, which throws for built-ins — they gain a built-in manifest special-case. **No console changes**: the card-click path (Arcade → `onOpen` → Studio) loads the read route, which already returns `mcpNeeds`, and Studio already threads it into `<Runner>`; Arcade thumbnails deliberately get no `mcpNeeds` (no consent prompts from a grid — the no-connector fallback renders, matching public-artifact parity).

**Tech Stack:** TypeScript ESM monorepo (pnpm), vitest running compiled `dist/`, `@agentback` controllers with Zod wire schemas, `@modelcontextprotocol/sdk` (already a dep).

## Global Constraints

- **Tests are compiled first**: the root suite runs `tsc -b && vitest run` against `dist/`. A focused run is `npx vitest run dist/<path>.test.js` — always `tsc -b` after edits, and filter on the **dist** path, never `src/`.
- **CI-gated test home is the root tree**: new play tests go in `src/play/__tests__/` (engine-level) or `src/__tests__/` (route-level) — NOT `packages/play/src/__tests__/` (local-only).
- **The seal's word trap**: `gameGate`'s network-word regex scans the whole document — comments, strings, markup. The words `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `navigator.sendBeacon` must not appear ANYWHERE in `REPO_PULSE_HTML`. Write "load" / "request".
- **Template-literal trap**: `REPO_PULSE_HTML` is a JS template literal; the inner `<script>` must use NO backticks and NO `${...}` (only the `${mcpAppClient()}` interpolation in `<head>` is ours). String concatenation only.
- **Built-ins are never saved**: `__repo-pulse` must never be registered in `SCAFFOLDS` or `GENRES`, and carries the `__` prefix so Arcade renders no delete affordance.
- **Conformance checklist**: before the PR, run `docs/miniapps/spec.md` §10 (this feature widens nothing — it *uses* the existing capability surface — so no new tightening is owed; verify T-invariants untouched).
- **Repo integration rules apply** (CLAUDE.md): worktree `../agentgem-worktrees/connectors-pr4b`, branch off freshly-fetched `origin/main`, PR gated on `test (24)`, verify every commit's content on `origin/main` after merge.

---

### Task 1: `REPO_PULSE_META` + `REPO_PULSE_HTML` + gate test

**Files:**
- Create: `packages/play/src/repoPulse.ts`
- Modify: `packages/play/src/index.ts` (add one export line next to the EMBER export, line ~36)
- Test: `src/play/__tests__/repoPulse.gate.test.ts`

**Interfaces:**
- Consumes: `mcpAppClient()` from `./mcpAppClient.js`, `MiniappMeta` from `./miniapps.js`, `McpNeed` from `@agentgem/model`.
- Produces: `REPO_PULSE_META: { name: "__repo-pulse", title, genre, createdFrom, engineVersion, mcpNeeds }` and `REPO_PULSE_HTML: string`, exported from the `@agentgem/play` barrel. Task 2 imports both.

- [ ] **Step 1: Write the failing gate test**

Create `src/play/__tests__/repoPulse.gate.test.ts` (modeled on `inspector.gate.test.ts` in the same directory):

```ts
// src/play/__tests__/repoPulse.gate.test.ts
import { describe, it, expect } from "vitest";
import {
  REPO_PULSE_HTML, REPO_PULSE_META, gameGate, deriveNeeds, deriveMcpNeeds, mcpAppFor,
} from "@agentgem/play";

describe("repo pulse", () => {
  it("passes the seal", async () => {
    const r = await gameGate(REPO_PULSE_HTML);
    expect(r.ok, r.failures.join("; ")).toBe(true);
  });

  it("derives no classic capabilities (connector-only miniapp)", () => {
    expect(deriveNeeds(REPO_PULSE_HTML)).toEqual([]);
  });

  it("derived mcp usage matches the declared manifest exactly", () => {
    expect(deriveMcpNeeds(REPO_PULSE_HTML)).toEqual(REPO_PULSE_META.mcpNeeds);
  });

  it("declares the three read tools on the github server", () => {
    expect(REPO_PULSE_META.mcpNeeds).toEqual([
      { server: "github", tools: ["list_pull_requests", "search_pull_requests", "list_commits"] },
    ]);
  });

  it("mints as an MCP Apps resource", () => {
    const app = mcpAppFor({ name: REPO_PULSE_META.name, html: REPO_PULSE_HTML, meta: REPO_PULSE_META });
    expect(app.resource.uri).toBe("ui://agentgem/__repo-pulse");
  });

  it("renders a no-connector fallback state (marketplace parity)", () => {
    expect(REPO_PULSE_HTML).toContain("no-connector");
  });
});
```

Before writing, confirm `deriveMcpNeeds`'s exact return shape by reading `src/play/__tests__/mcpScan.test.ts` — if it returns `McpNeed[]` with sorted tools, mirror that ordering in the assertion (adjust the declared `tools` array order to match what the scanner derives, not vice versa).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ../agentgem-worktrees/connectors-pr4b && tsc -b 2>&1 | head -5`
Expected: compile error — `REPO_PULSE_HTML` not exported from `@agentgem/play`.

- [ ] **Step 3: Write `packages/play/src/repoPulse.ts`**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// REPO PULSE — a built-in miniapp: a GitHub dashboard (open PRs / recently merged / recent commits)
// that demos MCP connectors. Served as a CONSTANT (never written to the registry), like EMBER: listed
// in /api/play/miniapps so it shows as an Arcade card, special-cased by name in the read route AND in
// the mcp/call + mcp/servers manifest checks (packages/app/src/play.controller.ts) — a built-in has no
// registry entry for readMiniapp() to find, so its connector manifest comes from this META.
//
// It is the first mcpNeeds-only built-in: no classic `needs` at all. The host attaches the mcp router
// when mcpNeeds is non-empty (Runner), and every callTool is consent-gated + manifest-checked
// server-side. With no host, or no "github" connector installed, it renders its no-connector state —
// the spec's public-artifact parity (§5: the hosted player never installs agentgemApp.mcp).
//
// Author constraints (this is emitted verbatim as the miniapp document):
//   * The inner <script> uses NO backticks and NO ${...} — those would be captured by THIS template
//     literal. Only ${mcpAppClient()} in <head> is interpolated here. String concatenation only.
//   * gameGate's network-word regex scans the WHOLE document: the banned words must not appear
//     anywhere below — not in markup, comments, or strings. Say "load", never the f-word of HTTP.
import type { McpNeed } from "@agentgem/model";
import { mcpAppClient } from "./mcpAppClient.js";
import type { MiniappMeta } from "./miniapps.js";

export const REPO_PULSE_META = {
  name: "__repo-pulse",
  title: "Repo Pulse",
  genre: "project-fun",
  createdFrom: { kind: "blank", title: "Repo Pulse" },
  engineVersion: "1",
  mcpNeeds: [
    { server: "github", tools: ["list_pull_requests", "search_pull_requests", "list_commits"] },
  ] as McpNeed[],
} satisfies MiniappMeta & { name: string };

export const REPO_PULSE_HTML = `<!doctype html>
<html lang="en"><head>${mcpAppClient()}<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Repo Pulse — your repo's heartbeat</title>
<style>
  :root{--bg:#0b0d12;--panel:#12151d;--line:#222736;--ink:#e8eaf2;--dim:#8b93a7;
    --pr:#37e6a0;--merged:#b48cff;--commit:#5ab8ff;--warn:#ffb44d;
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden}
  body{background:var(--color-background-primary,var(--bg));color:var(--color-text-primary,var(--ink));
    font-family:var(--mono);display:flex;flex-direction:column}
  header{display:flex;gap:10px;align-items:center;padding:14px 18px;
    border-bottom:1px solid var(--color-border-primary,var(--line));flex-wrap:wrap}
  h1{font-size:14px;letter-spacing:.28em;margin:0;color:var(--pr)}
  #repo{flex:1;min-width:180px;background:var(--color-background-secondary,var(--panel));
    border:1px solid var(--color-border-primary,var(--line));border-radius:6px;color:inherit;
    font:inherit;padding:7px 10px}
  #go{background:var(--pr);border:0;border-radius:6px;color:#04281a;font:inherit;font-weight:700;
    padding:7px 16px;cursor:pointer}
  #go:disabled{opacity:.5;cursor:default}
  #status{padding:6px 18px;font-size:11px;color:var(--dim);min-height:24px}
  main{flex:1;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;
    padding:0 18px 18px;overflow:auto}
  section{background:var(--color-background-secondary,var(--panel));
    border:1px solid var(--color-border-primary,var(--line));border-radius:10px;padding:12px;min-height:120px}
  section h2{font-size:10px;letter-spacing:.2em;margin:0 0 10px;color:var(--dim)}
  section.open h2{color:var(--pr)} section.merged h2{color:var(--merged)} section.commits h2{color:var(--commit)}
  ul{list-style:none;margin:0;padding:0;font-size:12px}
  li{padding:6px 0;border-bottom:1px solid var(--color-border-primary,var(--line));
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  li:last-child{border-bottom:0}
  li b{color:var(--ink);font-weight:600} li span{color:var(--dim)}
  .empty{color:var(--dim);font-size:12px}
  #fallback{display:none;flex:1;align-items:center;justify-content:center;text-align:center;
    padding:24px;color:var(--dim);font-size:13px;line-height:1.7}
  #fallback b{color:var(--warn)}
</style></head>
<body>
<header>
  <h1>REPO PULSE</h1>
  <input id="repo" placeholder="owner/repo  (e.g. ninemindai/agentgem)" spellcheck="false" />
  <button id="go" type="button">LOAD</button>
</header>
<div id="status">Boots from your GitHub connector. Nothing here is stored or sent anywhere else.</div>
<main id="board">
  <section class="open"><h2>OPEN PULL REQUESTS</h2><ul id="open-list"><li class="empty">—</li></ul></section>
  <section class="merged"><h2>RECENTLY MERGED</h2><ul id="merged-list"><li class="empty">—</li></ul></section>
  <section class="commits"><h2>RECENT COMMITS</h2><ul id="commit-list"><li class="empty">—</li></ul></section>
</main>
<div id="fallback" class="no-connector">
  <div><b>No GitHub connector.</b><br />
  Repo Pulse reads open PRs, merges and commits through the host's
  <b>github</b> MCP server. Install one (any GitHub MCP server named
  "github"), then reopen this card.<br />
  On the public marketplace this state is expected: sealed games get no connectors.</div>
</div>
<script>
(function () {
  var el = function (id) { return document.getElementById(id); };
  var statusEl = el("status"), board = el("board"), fallback = el("fallback");
  var busy = false;

  function setStatus(t) { statusEl.textContent = t; }
  function row(main, sub) {
    var li = document.createElement("li");
    var b = document.createElement("b"); b.textContent = main;
    var s = document.createElement("span"); s.textContent = sub ? "  " + sub : "";
    li.appendChild(b); li.appendChild(s); return li;
  }
  function fill(id, rows, emptyMsg) {
    var ul = el(id); ul.textContent = "";
    if (!rows.length) {
      var li = document.createElement("li"); li.className = "empty"; li.textContent = emptyMsg;
      ul.appendChild(li); return;
    }
    for (var i = 0; i < Math.min(rows.length, 8); i++) ul.appendChild(rows[i]);
  }
  // The connector's reply: prefer the derived payload, fall back to parsing the first text content.
  function unwrap(res) {
    if (res && res.payload != null) return res.payload;
    try {
      var c = res && res.content && res.content[0];
      if (c && c.type === "text") return JSON.parse(c.text);
    } catch (e) { /* fall through */ }
    return null;
  }
  function asList(p) {
    if (Array.isArray(p)) return p;
    if (p && Array.isArray(p.items)) return p.items;
    return [];
  }
  function parseRepo(v) {
    var m = /^\\s*([\\w.-]+)\\/([\\w.-]+)\\s*$/.exec(v || "");
    return m ? { owner: m[1], repo: m[2] } : null;
  }

  function loadAll() {
    var target = parseRepo(el("repo").value);
    if (!target) { setStatus("Enter a repo as owner/repo."); return; }
    if (busy) return;
    busy = true; el("go").disabled = true; setStatus("Loading " + target.owner + "/" + target.repo + " …");
    var mcp = window.agentgemApp.mcp;
    var done = 0, failed = null;
    var settle = function () {
      done++;
      if (done === 3) {
        busy = false; el("go").disabled = false;
        setStatus(failed ? "Partial load: " + failed : "Live from your github connector. Reload any time.");
      }
    };
    mcp.callTool("github", "list_pull_requests", { owner: target.owner, repo: target.repo, state: "open" })
      .then(function (res) {
        fill("open-list", asList(unwrap(res)).map(function (p) {
          return row("#" + p.number + " " + (p.title || ""), p.user && p.user.login);
        }), "no open PRs");
      })
      .catch(function (e) { failed = String(e && e.message || e); fill("open-list", [], "unavailable"); })
      .then(settle);
    mcp.callTool("github", "search_pull_requests", {
      query: "repo:" + target.owner + "/" + target.repo + " is:pr is:merged", perPage: 8,
    })
      .then(function (res) {
        fill("merged-list", asList(unwrap(res)).map(function (p) {
          return row("#" + p.number + " " + (p.title || ""), p.user && p.user.login);
        }), "none found");
      })
      .catch(function (e) { failed = String(e && e.message || e); fill("merged-list", [], "unavailable"); })
      .then(settle);
    mcp.callTool("github", "list_commits", { owner: target.owner, repo: target.repo, perPage: 8 })
      .then(function (res) {
        fill("commit-list", asList(unwrap(res)).map(function (c) {
          var msg = (c.commit && c.commit.message || "").split("\\n")[0];
          var who = c.commit && c.commit.author && c.commit.author.name;
          return row((c.sha || "").slice(0, 7) + " " + msg, who);
        }), "none found");
      })
      .catch(function (e) { failed = String(e && e.message || e); fill("commit-list", [], "unavailable"); })
      .then(settle);
  }

  el("go").addEventListener("click", loadAll);
  el("repo").addEventListener("keydown", function (e) { if (e.key === "Enter") loadAll(); });

  // Boot: paint the idle dashboard immediately; never block first paint on a host. The shim retries
  // the handshake ~5x over ~4s, so poll briefly for the mcp member before declaring no-connector.
  var tries = 0;
  var probe = setInterval(function () {
    tries++;
    if (window.agentgemApp && window.agentgemApp.mcp) {
      clearInterval(probe);
      setStatus("Connected. Enter owner/repo and press LOAD.");
      el("repo").focus();
    } else if (tries > 25) {
      clearInterval(probe);
      board.style.display = "none";
      document.getElementById("status").style.display = "none";
      fallback.style.display = "flex";
    }
  }, 200);
})();
</script>
</body></html>
`;
```

Then add the barrel export in `packages/play/src/index.ts`, directly below the EMBER line (~36):

```ts
export { REPO_PULSE_HTML, REPO_PULSE_META } from "./repoPulse.js";
```

**Check before compiling:** grep the new file for every banned word — `grep -niE "fetch|xmlhttprequest|websocket|eventsource|importscripts|sendbeacon" packages/play/src/repoPulse.ts` must match **only** the header comment's allusion if any (rewrite so it matches nothing). Also `grep -c '\${' packages/play/src/repoPulse.ts` — every hit must be inside the outer template's own interpolation (`${mcpAppClient()}`) or the doubled-escape regex (`\\s`, `\\/`, `\\n` are fine; `${` inside the inner script is not).

- [ ] **Step 4: Compile and run the gate test**

Run: `tsc -b && npx vitest run dist/play/__tests__/repoPulse.gate.test.js`
Expected: PASS (6 tests). If `deriveMcpNeeds` ordering differs, fix the META/assertion per Step 1's note. If the seal fails, read the failure — it names the offending word/attr.

- [ ] **Step 5: Commit**

```bash
git add packages/play/src/repoPulse.ts packages/play/src/index.ts src/play/__tests__/repoPulse.gate.test.ts
git commit -m "feat(play): Repo Pulse — built-in mcpNeeds-only demo miniapp (constants + gate test)"
```

---

### Task 2: serve the built-in — list, read, and the built-in connector manifest

**Files:**
- Modify: `packages/app/src/play.controller.ts` (imports line ~8–9; `miniapps()` line ~109–117; `miniapp()` read special-cases line ~120–150; `mcpCall` line ~196–201; `mcpServers` line ~231–235 — line numbers drift, anchor on the quoted code)
- Test: `src/__tests__/playRepoPulse.test.ts`

**Interfaces:**
- Consumes: `REPO_PULSE_HTML`, `REPO_PULSE_META` from `@agentgem/play` (Task 1).
- Produces: `GET /api/play/miniapps` lists `__repo-pulse`; `GET /api/play/miniapp?name=__repo-pulse` returns the constant with `meta.mcpNeeds`; `POST /api/play/mcp/call` and `GET /api/play/mcp/servers` honor the built-in's manifest. Task 4's E2E relies on all three.

- [ ] **Step 1: Write the failing route test**

Create `src/__tests__/playRepoPulse.test.ts`. Copy the harness (imports, `FIXTURE`, `stdioGem`, `beforeEach`/`afterEach` with temp `AGENTGEM_HOME`, controller construction) **verbatim from `src/__tests__/playMcpCall.test.ts`** — read that file first and mirror how it instantiates `PlayController` and asserts the error envelope, then add:

```ts
describe("built-in repo pulse", () => {
  it("is listed with the built-ins, before registry entries", async () => {
    const r = await ctrl.miniapps();
    const names = r.miniapps.map((m: { name: string }) => m.name);
    expect(names).toContain("__repo-pulse");
    expect(names.indexOf("__repo-pulse")).toBeLessThan(names.length);   // present even with empty registry
  });

  it("read serves the constant with its connector manifest", async () => {
    const r = await ctrl.miniapp({ query: { name: "__repo-pulse" } });
    expect(r.html).toContain("REPO PULSE");
    expect(r.meta.mcpNeeds).toEqual([
      { server: "github", tools: ["list_pull_requests", "search_pull_requests", "list_commits"] },
    ]);
  });

  it("mcp/call honors the built-in manifest (declared tool brokered)", async () => {
    __setConnectorReaderForTest(() => stdioGem("github"));
    const res = await ctrl.mcpCall({
      body: { name: "__repo-pulse", server: "github", tool: "list_commits", input: { owner: "o", repo: "r" } },
    });
    // fakeStdioServer echoes arguments for any non-"boom" tool
    expect(res).toMatchObject({ ok: true });
  });

  it("mcp/call rejects an undeclared tool on the built-in (not_in_manifest)", async () => {
    __setConnectorReaderForTest(() => stdioGem("github"));
    const res = await ctrl.mcpCall({
      body: { name: "__repo-pulse", server: "github", tool: "create_pull_request", input: {} },
    });
    expect(res).toMatchObject({ ok: false, error: { code: "not_in_manifest" } });
  });

  it("mcp/servers resolves the built-in manifest", async () => {
    __setConnectorReaderForTest(() => stdioGem("github"));
    const r = await ctrl.mcpServers({ query: { name: "__repo-pulse" } });
    expect(JSON.stringify(r)).toContain("github");
  });
});
```

**Adjust the success/error assertion shapes to the real wire** — mirror exactly what `playMcpCall.test.ts` asserts for its happy path and its `not_in_manifest` case (the envelope may be `{ ok, payload }` / thrown `AgentError` — copy its pattern, don't invent one). Same for `mcpServers`'s response shape and its exact method signature.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `tsc -b && npx vitest run dist/__tests__/playRepoPulse.test.js`
Expected: FAIL — list lacks `__repo-pulse`; read throws 404; mcpCall errors with the readMiniapp failure, not the manifest check.

- [ ] **Step 3: Implement the controller changes**

In `packages/app/src/play.controller.ts`:

(a) extend the import from `@agentgem/play` (line ~8–9) with `REPO_PULSE_HTML, REPO_PULSE_META`.

(b) in `miniapps()`, extend the builtins array:

```ts
    const builtins = [
      { name: EMBER_META.name, title: EMBER_META.title, genre: EMBER_META.genre, needs: EMBER_META.needs },
      { name: REPO_PULSE_META.name, title: REPO_PULSE_META.title, genre: REPO_PULSE_META.genre },
    ];
```

(c) in `miniapp()`, add a special-case directly below the `__ember` one, mirroring its exact return shape and adding `mcpNeeds`:

```ts
    if (input.query.name === REPO_PULSE_META.name) {
      return { name: REPO_PULSE_META.name, html: REPO_PULSE_HTML, meta: {
        title: REPO_PULSE_META.title, genre: REPO_PULSE_META.genre, createdFrom: REPO_PULSE_META.createdFrom,
        engineVersion: REPO_PULSE_META.engineVersion, mcpNeeds: REPO_PULSE_META.mcpNeeds,
      } };
    }
```

(d) in **both** `mcpCall` and `mcpServers`, resolve the manifest through a shared helper placed above `mcpCall` — a built-in has no registry entry for `readMiniapp` to find:

```ts
  // A built-in's connector manifest lives in its served constant, not the registry (readMiniapp
  // throws for "__" names). Only Repo Pulse declares one; EMBER/Inspector have none, so falling
  // through to readMiniapp keeps their (correct) rejection behavior.
  private builtinMcpNeeds(name: string): McpNeed[] | undefined {
    return name === REPO_PULSE_META.name ? REPO_PULSE_META.mcpNeeds : undefined;
  }
```

and change the two `try { mcpNeeds = readMiniapp(...).meta.mcpNeeds ?? []; }` sites to:

```ts
    let mcpNeeds = this.builtinMcpNeeds(name);
    if (!mcpNeeds) {
      try { mcpNeeds = readMiniapp(name).meta.mcpNeeds ?? []; }
      catch { /* keep the existing catch behavior of this site verbatim */ }
    }
```

Preserve each site's existing catch/error path byte-for-byte (they differ — read them). Import the `McpNeed` type from `@agentgem/model` if not already imported.

- [ ] **Step 4: Compile, run the new tests plus the neighbors they must not break**

Run: `tsc -b && npx vitest run dist/__tests__/playRepoPulse.test.js dist/__tests__/playMcpCall.test.js dist/__tests__/playMcpRoute.test.js dist/__tests__/playRoutes.test.js`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/play.controller.ts src/__tests__/playRepoPulse.test.ts
git commit -m "feat(app): serve Repo Pulse — arcade listing, constant read, built-in mcp manifest"
```

---

### Task 3: docs — spec.md implementation-map corrections + built-in row

**Files:**
- Modify: `docs/miniapps/spec.md` (§9 implementation map)

The `@agentgem/app` extraction (`a76123c6`) moved the server files the day the spec shipped. Fix the rows:

- [ ] **Step 1: Apply the row edits**

In `docs/miniapps/spec.md` §9:
- `REST routes (\`/api/play/*\`) + wire schemas` row: `src/play.controller.ts`, `src/schemas.ts` → `packages/app/src/play.controller.ts`, `packages/app/src/schemas.ts`.
- `play-beacon origin-guard exemption` row: `src/originGuard.ts` → `packages/app/src/originGuard.ts`.
- `built-ins: Ember · Protocol Inspector` row → `built-ins: Ember · Protocol Inspector · Repo Pulse` with `packages/play/src/ember.ts`, `inspector.ts`, `repoPulse.ts`.

- [ ] **Step 2: Verify and commit**

Run: `grep -n "src/play.controller\|src/schemas\|src/originGuard" docs/miniapps/spec.md`
Expected: no hits without the `packages/app/` prefix.

```bash
git add docs/miniapps/spec.md
git commit -m "docs(miniapps): spec §9 tracks the @agentgem/app extraction; add Repo Pulse built-in"
```

---

### Task 4: E2E — real browser, fake connector first (D14), then Repo Pulse acceptance

This is the spec's §7 E2E: *save → Runner → consent Allow → live data in the sealed iframe*, proven against the **fake** connector before the GitHub demo. It is a **verify-skill session** (read `.claude/skills/verify/SKILL.md` first), not a vitest.

**Files:**
- None committed (throwaway home + a temporary user-config entry, restored after).

- [ ] **Step 1: Install the fake connector into the user config (with backup)**

The connector reader resolves servers via `introspectConfig({redact:false}).mcpServers`, which reads `~/.claude/.mcp.json` (user scope) — there is no env seam, so the fake entry goes into the real file, backed up first:

```bash
cp ~/.claude/.mcp.json ~/.claude/.mcp.json.pr4b-bak 2>/dev/null || echo '{"mcpServers":{}}' > ~/.claude/.mcp.json
node -e '
  const fs = require("fs"), p = process.env.HOME + "/.claude/.mcp.json";
  const j = JSON.parse(fs.readFileSync(p, "utf8")); j.mcpServers ??= {};
  j.mcpServers.fake = { command: process.execPath,
    args: [process.cwd() + "/src/play/__tests__/fixtures/fakeStdioServer.mjs"] };
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
' 
```

(Run from the worktree root so the fixture path is absolute into this worktree.)

- [ ] **Step 2: Build, launch on an owned port**

```bash
pnpm build
AGENTGEM_HOME=$(mktemp -d) PORT=4573 node dist/index.js
```

Confirm port ownership per the verify skill (another session may hold it): `lsof -p $(lsof -tnP -iTCP:4573 -sTCP:LISTEN) | grep cwd` → must point at THIS worktree.

- [ ] **Step 3: Save the fake-first proof miniapp via the API**

```bash
curl -s -X POST http://localhost:4573/api/play/save -H 'content-type: application/json' -d '{
  "name": "pr4b-proof",
  "html": "<!doctype html><body><h1 id=out>waiting for connector…</h1><script>var t=setInterval(function(){if(window.agentgemApp&&window.agentgemApp.mcp){clearInterval(t);window.agentgemApp.mcp.callTool(\"fake\",\"read_thing\",{q:42}).then(function(r){document.getElementById(\"out\").textContent=\"echo:\"+JSON.stringify(r.payload||r.content)}).catch(function(e){document.getElementById(\"out\").textContent=\"err:\"+e.message})}},200)</script></body>",
  "meta": { "title": "PR4b proof", "genre": "project-fun", "createdFrom": {"kind":"blank","title":"PR4b proof"},
            "engineVersion": "1", "mcpNeeds": [{"server":"fake","tools":["read_thing"]}] }
}'
```

Expected: a save success response (the exact body schema is `PlaySave*` in `packages/app/src/schemas.ts` — if it 422s, diff your body against the schema; a missing body field is a silent-422 trap in this stack).

- [ ] **Step 4: Drive the browser (browser-harness) — the platform proof**

```bash
browser-harness <<'PY'
new_tab("http://localhost:4573/#/play")
wait_for_load()
capture_screenshot()
PY
```

Then, reading each screenshot before the next click: open the **PR4b proof** card → Studio opens with the preview → the **connector consent card** must appear naming the `fake` server and its declared tool → click **Allow** → within ~2 s the sealed frame must render `echo:{"echo":{"q":42}}` (the fixture echoes its arguments). Screenshot each state. **Any deviation is a finding — stop and fix before proceeding.** Consent is per-origin `localStorage` (`agentgem:play:consent:*`) — clear those keys to re-test the prompt.

- [ ] **Step 5: Repo Pulse acceptance polish**

Back on `#/play`: the **Repo Pulse** card must be present, `__`-prefixed with no delete affordance, its thumbnail showing the **no-connector** state (thumbs get no mcpNeeds — expected). Open the card → in Studio, with no `github` server installed the fallback panel must render. If the user's real config has a `github` MCP server: enter `ninemindai/agentgem`, press LOAD, consent card → Allow → the three panels populate live. Screenshot both states.

- [ ] **Step 6: Restore the user config and stop the server**

```bash
mv ~/.claude/.mcp.json.pr4b-bak ~/.claude/.mcp.json 2>/dev/null || node -e '
  const fs=require("fs"),p=process.env.HOME+"/.claude/.mcp.json";
  const j=JSON.parse(fs.readFileSync(p,"utf8")); delete j.mcpServers.fake;
  fs.writeFileSync(p,JSON.stringify(j,null,2));'
```

Kill the dev server. Verify: `grep -c fake ~/.claude/.mcp.json` → 0.

---

### Task 5: deliver

- [ ] **Step 1: Full gate + conformance pass**

Run: `pnpm test` at the worktree root (full `tsc -b && vitest run`). Expected: green, or only the pre-existing flakes documented in memory (App.test Groups-nav race, coldBuildWorker) — anything new is yours.
Then walk `docs/miniapps/spec.md` §10 explicitly; this PR should check every applicable box (notably: notifications-by-method N/A, no new widening, SKILL.md untouched — the authoring contract didn't change, only a new built-in).

- [ ] **Step 2: PR per house rules**

```bash
git push -u origin connectors-pr4b
gh pr create --title "feat(play): Repo Pulse — MCP connectors demo built-in + E2E proof (PR-4b)" --body "…spec §6–7 refs, what the E2E proved (fake-first per D14), screenshots…

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh run watch <run-id> --exit-status
gh pr merge --rebase --delete-branch   # local delete errors (main in another worktree) — remote merge still lands
```

- [ ] **Step 3: Verify every commit landed**

```bash
git fetch origin
git show origin/main:packages/play/src/repoPulse.ts | grep -c "REPO PULSE"          # commit 1
git show origin/main:packages/app/src/play.controller.ts | grep -c "REPO_PULSE_META" # commit 2
git show origin/main:docs/miniapps/spec.md | grep -c "repoPulse.ts"                  # commit 3
```

All three > 0, or rescue per CLAUDE.md (rebase onto origin/main → fresh branch → new PR). Then remove the worktree.
