# EMBER Live-Session Miniapp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship EMBER — the `mockups/ember-session-game.html` prototype — as a built-in miniapp that appears as an Arcade card and drives its flame gauge from the real current-session context-hygiene stream.

**Architecture:** A new served-constant module `packages/play/src/ember.ts` (`EMBER_META` + `EMBER_HTML`), mirroring the Protocol Inspector, but *listed* in `/play/miniapps` so it surfaces as an Arcade card. EMBER declares one new capability, `context-hygiene`, which the console host brokers by opening the existing `/api/watch/hygiene` SSE stream for the most-recent (live) session and forwarding each `{ verdict, cap, curveTail }` event into the sealed iframe. The mockup's `stress()` model maps verbatim onto `curveTail.at(-1).ctxTokens / cap`.

**Tech Stack:** TypeScript, Zod (wire schemas), Vitest + jsdom, @agentgem/model (capability union), @agentgem/play (miniapp registry + served constants), console MCP-Apps host router (`mcpUiHost`/`mcpHostTools`), the `window.agentgemApp` sealed-iframe shim (`mcpAppClient`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-14-ember-live-session-miniapp-design.md`.
- `context-hygiene` is a **ToolCapability** (read-only brokered data feed), **consent-gated** (NOT in `AUTO_CAPS`), host tool name **`agentgem_subscribe_hygiene`**.
- The cap↔tool map exists in TWO places kept in lockstep by `capTool.drift.test.ts`: canonical `packages/model/src/capabilities.ts` (`CAP_TOOL`) and the browser mirror `packages/console/src/panels/Play/consent.ts` (`CAP_TOOL`). Update BOTH identically.
- The wire enum `GameCapabilityEnum` (`src/schemas.ts`) and the client mirror `PlayNeedsSchema` (`packages/console/src/api/routes.ts`) must both gain `"context-hygiene"`.
- EMBER's registry name is **`__ember`** (double-underscore = built-in, never written to the registry — same convention as `__inspector`).
- Genre must be an existing `GameGenreEnum` value: use **`session-heatmap`**.
- Every `git commit` message ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- UI rule: any `ex-*`/new className needs a matching CSS rule; verify styled UI in a real browser, not just jsdom.
- Build/verify: root `tsc -b` (NOT `pnpm -r build`). Tests: `pnpm --filter <pkg> test` per package; console tests are not in CI so run locally.

---

### Task 1: Add the `context-hygiene` capability

**Files:**
- Modify: `packages/model/src/types.ts` (`ToolCapability` union, ~line 59)
- Modify: `packages/model/src/capabilities.ts` (`CAP_TOOL`)
- Modify: `src/schemas.ts` (`GameCapabilityEnum`, ~line 101)
- Modify: `packages/console/src/api/routes.ts` (`PlayNeedsSchema`, ~line 1013)
- Modify: `packages/console/src/panels/Play/consent.ts` (`CAP_TOOL` mirror, `CAP_LABEL`, `CONSENT_CAPS`)
- Test: `packages/console/src/panels/Play/__tests__/capTool.drift.test.ts` (existing — must stay green)

**Interfaces:**
- Produces: capability string `"context-hygiene"`; host tool name `"agentgem_subscribe_hygiene"`. Consumed by Tasks 2, 3, 4.

- [ ] **Step 1: Extend the canonical union + map (compile guards fire here).**

`packages/model/src/types.ts` — add the member to `ToolCapability`:
```ts
export type ToolCapability =
  | "session-data"
  | "live-session-events"
  | "local-project-access"
  | "invoke-agent"
  | "context-hygiene";       // read-only: streamed context-hygiene of the viewer's live session
```

`packages/model/src/capabilities.ts` — add to `CAP_TOOL` (keyed by `ToolCapability`, so this is required to compile):
```ts
export const CAP_TOOL: Record<ToolCapability, string> = {
  "session-data": "agentgem_get_session_data",
  "live-session-events": "agentgem_subscribe_sessions",
  "local-project-access": "agentgem_get_inventory",
  "invoke-agent": "agentgem_invoke_agent",
  "context-hygiene": "agentgem_subscribe_hygiene",
};
```

- [ ] **Step 2: Extend the wire enum + client mirror.**

`src/schemas.ts` `GameCapabilityEnum`:
```ts
export const GameCapabilityEnum = z.enum([
  "session-data", "live-session-events", "local-project-access", "invoke-agent",
  "context-hygiene",
  "open-link", "send-message", "update-model-context",
]);
```

`packages/console/src/api/routes.ts` `PlayNeedsSchema`:
```ts
const PlayNeedsSchema = z.array(z.enum([
  "session-data", "live-session-events", "local-project-access", "invoke-agent",
  "context-hygiene",
  "open-link", "send-message", "update-model-context",
])).optional();
```

- [ ] **Step 3: Update the console browser mirror + consent copy.**

`packages/console/src/panels/Play/consent.ts`:
```ts
export const CAP_LABEL: Record<string, string> = {
  "local-project-access": "read your local setup — skills, MCP servers, and projects",
  "live-session-events": "watch your live coding sessions in real time",
  "context-hygiene": "read your live session's context-health signal",
  "invoke-agent": "run a local AI agent on your machine",
  "open-link": "open an external link in your browser",
  "send-message": "send a message into your conversation as you",
  "update-model-context": "push structured state into the model's context",
};

export const CONSENT_CAPS = [
  "local-project-access", "live-session-events", "context-hygiene", "invoke-agent",
  "open-link", "send-message", "update-model-context",
] as const;

export const CAP_TOOL: Record<string, string> = {
  "session-data": "agentgem_get_session_data",
  "local-project-access": "agentgem_get_inventory",
  "live-session-events": "agentgem_subscribe_sessions",
  "invoke-agent": "agentgem_invoke_agent",
  "context-hygiene": "agentgem_subscribe_hygiene",
};
```

- [ ] **Step 4: Run the drift + model guards.**

Run: `pnpm --filter @agentgem/console test -- capTool.drift`
Expected: PASS (`CAP_TOOL` mirror `.toEqual` canonical; `context-hygiene` NOT required in the ActionCapability assertion since it is a ToolCapability).
Run: root `tsc -b`
Expected: clean — the `Record<ToolCapability, string>` guard is satisfied.

- [ ] **Step 5: Commit.**
```bash
git add packages/model/src/types.ts packages/model/src/capabilities.ts src/schemas.ts \
        packages/console/src/api/routes.ts packages/console/src/panels/Play/consent.ts
git commit -m "feat(play): add context-hygiene capability (model + wire enum + console mirror)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Broker the hygiene stream into the sealed iframe

**Files:**
- Modify: `packages/console/src/panels/Play/mcpHostTools.ts` (`DESCRIPTIONS`, new `subscribeHygiene`)
- Modify: `packages/console/src/panels/Play/mcpUiHost.ts` (import, `hygieneOpen` guard, `execute` branch)
- Test: `packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts` (add a case)

**Interfaces:**
- Consumes: `openHygieneStream(apiBase, file, onEvent)` from `../Watch/hygieneStream.js`; `fetchSessions` from `../Watch/watchStream.js`; `CAP_TOOL["context-hygiene"] === "agentgem_subscribe_hygiene"` (Task 1).
- Produces: `subscribeHygiene(apiBase, onEvent): Promise<{status:"subscribed";handle:StreamHandle}|{status:"idle"}>`.

- [ ] **Step 1: Write the failing broker test** (mirror the `live-session-events` streaming case).

Add to `mcpUiHost.test.ts`:
```ts
import * as hygieneStream from "../../Watch/hygieneStream.js";

it("context-hygiene subscribe pushes hygiene events as tool-result chunks", async () => {
  vi.spyOn(watchStream, "fetchSessions").mockResolvedValue([sess("/f.jsonl")]);
  let emit!: (e: unknown) => void;
  vi.spyOn(hygieneStream, "openHygieneStream").mockImplementation((_a, _f, cb) => { emit = cb as (e: unknown) => void; return () => {}; });
  const { host, target } = mkHost({ needs: ["context-hygiene"] });
  host.handleMessage(msg(target, { method: "tools/call", id: 21, params: { name: "agentgem_subscribe_hygiene", arguments: {} } }));
  await tick();
  expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({ id: 21, result: { status: "subscribed" } }), "*");
  emit({ type: "hygiene", verdict: "bounded", score: 5, cap: 200000, curveTail: [{ turn: 3, msgIndex: 6, ctxTokens: 42000, cacheCreation: 0, outTokens: 0 }], factors: [] });
  expect(posted(target)).toHaveBeenCalledWith(expect.objectContaining({
    method: "ui/notifications/tool-result",
    params: expect.objectContaining({ _meta: { "ai.agentgem/stream": { toolName: "agentgem_subscribe_hygiene" } } }),
  }), "*");
});
```

- [ ] **Step 2: Run it, verify it fails.**
Run: `pnpm --filter @agentgem/console test -- mcpUiHost`
Expected: FAIL — `capability not permitted: agentgem_subscribe_hygiene` (broker branch absent).

- [ ] **Step 3: Add `subscribeHygiene` + its description in `mcpHostTools.ts`.**

Add import: `import { openHygieneStream } from "../Watch/hygieneStream.js";`
Add to `DESCRIPTIONS`: `"context-hygiene": "Subscribe to the viewer's live session context-health (bloat) signal.",`
Add executor (after `subscribeSessions`):
```ts
// subscribeHygiene: "context-hygiene" cap — the most-recent session is "live"; opens the same
// server-computed hygiene SSE the Watch tab consumes. Idle when no session exists yet.
export async function subscribeHygiene(
  apiBase: string,
  onEvent: (e: unknown) => void,
): Promise<{ status: "subscribed"; handle: StreamHandle } | { status: "idle" }> {
  const sessions = await fetchSessions(apiBase);
  const file = sessions[0]?.file;
  if (!file) return { status: "idle" };
  const close = openHygieneStream(apiBase, file, onEvent as (e: import("../Watch/hygieneStream.js").HygieneMsg) => void);
  return { status: "subscribed", handle: { close } };
}
```

- [ ] **Step 4: Add the broker branch in `mcpUiHost.ts`.**

Import: add `subscribeHygiene` to the `mcpHostTools.js` import list.
Add guard beside `liveOpen`: `let hygieneOpen = false;   // one context-hygiene stream`
Add branch in `execute()` after the `live-session-events` branch (identical shape, own guard):
```ts
if (cap === "context-hygiene") {
  if (hygieneOpen) { reply(id, { status: "already-subscribed" }); return; }
  hygieneOpen = true;
  try {
    const r = await subscribeHygiene(deps.apiBase, (ev) => { if (!stale(gen)) notify(tool, ev); });
    if (stale(gen)) { if (r.status === "subscribed") { try { r.handle.close(); } catch { /* ignore */ } } hygieneOpen = false; return; }
    if (r.status === "idle") { hygieneOpen = false; reply(id, { status: "idle" }); return; }
    register(gen, r.handle);
    reply(id, { status: "subscribed" });
  } catch (e) { hygieneOpen = false; throw e; }
  return;
}
```

- [ ] **Step 5: Run tests, verify pass.**
Run: `pnpm --filter @agentgem/console test -- mcpUiHost`
Expected: PASS (new case + existing cases).

- [ ] **Step 6: Commit.**
```bash
git add packages/console/src/panels/Play/mcpHostTools.ts packages/console/src/panels/Play/mcpUiHost.ts \
        packages/console/src/panels/Play/__tests__/mcpUiHost.test.ts
git commit -m "feat(play): broker context-hygiene stream into sealed miniapps

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: EMBER served constant + list injection + name resolution

**Files:**
- Create: `packages/play/src/ember.ts`
- Modify: `packages/play/src/index.ts` (barrel export)
- Modify: `src/play.controller.ts` (`miniapps()` inject, `miniapp()` special-case, imports)
- Test: `packages/play/src/__tests__/ember.test.ts` (new)

**Interfaces:**
- Consumes: `"context-hygiene"` (Task 1); `MiniappMeta` type; `INSPECTOR_*` special-case pattern in the controller.
- Produces: `EMBER_META` (`{ name: "__ember", title: "Ember", genre: "session-heatmap", createdFrom, engineVersion: "1", needs: ["context-hygiene"] }`), `EMBER_HTML` string (body filled in Task 4).

- [ ] **Step 1: Write the failing test.**
`packages/play/src/__tests__/ember.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { EMBER_META, EMBER_HTML } from "../ember.js";

describe("EMBER built-in miniapp", () => {
  it("declares the context-hygiene need and the built-in name", () => {
    expect(EMBER_META.name).toBe("__ember");
    expect(EMBER_META.genre).toBe("session-heatmap");
    expect(EMBER_META.needs).toContain("context-hygiene");
  });
  it("HTML calls the hygiene tool literally (deriveNeeds/host wiring)", () => {
    expect(EMBER_HTML).toContain("agentgem_subscribe_hygiene");
    // Word-list trap: served constants skip gameGate, but keep it clean anyway.
    expect(EMBER_HTML).not.toMatch(/EventSource|XMLHttpRequest|WebSocket/);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** (module missing).
Run: `pnpm --filter @agentgem/play test -- ember`
Expected: FAIL — cannot find `../ember.js`.

- [ ] **Step 3: Create `packages/play/src/ember.ts`** (META now; HTML is a minimal stub carrying the literal tool name — Task 4 fills the real game).
```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// EMBER — a built-in miniapp: a flame that grows as the live session's context window fills. Served as a
// CONSTANT (never written to the registry), like the Protocol Inspector, but LISTED so it shows as an
// Arcade card. Drives its gauge from the context-hygiene stream (needs: ["context-hygiene"]).
import type { GameCapability } from "@agentgem/model";
import { mcpAppClient } from "./mcpAppClient.js";
import type { MiniappMeta } from "./miniapps.js";

export const EMBER_META = {
  name: "__ember",
  title: "Ember",
  genre: "session-heatmap",
  createdFrom: { kind: "blank", title: "Ember" },
  engineVersion: "1",
  needs: ["context-hygiene"] as GameCapability[],
} satisfies MiniappMeta & { name: string };

export const EMBER_HTML = `<!doctype html>
<html lang="en"><head>${mcpAppClient()}<meta charset="utf-8" />
<title>EMBER — bank the session before it burns out</title>
</head><body>
<script>/* Task 4 fills the game. Literal tool name kept for wiring + tests: */
var TOOL = "agentgem_subscribe_hygiene";
</script>
</body></html>`;
```

- [ ] **Step 4: Export from the barrel** — `packages/play/src/index.ts`, beside the INSPECTOR export:
```ts
export { EMBER_HTML, EMBER_META } from "./ember.js";
```

- [ ] **Step 5: Inject into the list + special-case by name** in `src/play.controller.ts`.

Add to the `@agentgem/play` import: `EMBER_HTML, EMBER_META`.

`miniapps()` handler — prepend the built-in so it is the first Arcade card:
```ts
async miniapps(): Promise<z.infer<typeof MiniappListSchema>> {
  const builtins = [{ name: EMBER_META.name, title: EMBER_META.title, genre: EMBER_META.genre, needs: EMBER_META.needs }];
  const registry = listMiniapps().map((m) => ({ name: m.name, title: m.meta.title, genre: m.meta.genre, ...(m.meta.needs ? { needs: m.meta.needs } : {}) }));
  return { miniapps: [...builtins, ...registry] };
}
```

`miniapp()` handler — special-case `__ember` BEFORE `readMiniapp` (which would 404):
```ts
async miniapp(input: { query: z.infer<typeof PlayMiniappQuerySchema> }): Promise<z.infer<typeof PlayMiniappSchema>> {
  if (input.query.name === EMBER_META.name) {
    return { name: EMBER_META.name, html: EMBER_HTML, meta: {
      title: EMBER_META.title, genre: EMBER_META.genre, createdFrom: EMBER_META.createdFrom,
      engineVersion: EMBER_META.engineVersion, needs: EMBER_META.needs,
    } };
  }
  // ...existing readMiniapp body unchanged...
}
```

- [ ] **Step 6: Run play + controller tests.**
Run: `pnpm --filter @agentgem/play test -- ember`
Expected: PASS.
Run: root `tsc -b`
Expected: clean.

- [ ] **Step 7: Commit.**
```bash
git add packages/play/src/ember.ts packages/play/src/index.ts src/play.controller.ts \
        packages/play/src/__tests__/ember.test.ts
git commit -m "feat(play): built-in EMBER served constant, listed in Arcade + resolved by name

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Port the mockup into a live EMBER_HTML

**Files:**
- Modify: `packages/play/src/ember.ts` (`EMBER_HTML` — the real game)
- Reference (verbatim source): `mockups/ember-session-game.html`
- Test: `packages/play/src/__tests__/ember.test.ts` (extend with a jsdom behavioral test)

**Interfaces:**
- Consumes: shim `window.agentgemApp.callTool("agentgem_subscribe_hygiene")` + `.onNotification("agentgem_subscribe_hygiene", cb)`; hygiene event `{ type:"hygiene", verdict, cap, curveTail:CurvePoint[] }` and `{ type:"nudge", verdict, advice }`; `CurvePoint = { turn, msgIndex, ctxTokens, cacheCreation, outTokens }`.

**Port rules — copy the mockup's `<style>`, HUD/arena/controls markup, and the canvas `render()`/`puff()` functions VERBATIM. Replace only the state/loop/action layer with the deltas below.**

- [ ] **Step 1: Write the failing behavioral test.**
```ts
import { JSDOM } from "jsdom";
it("a pushed hygiene event drives the gauge fill from ctxTokens/cap", async () => {
  const dom = new JSDOM(EMBER_HTML, { runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window as unknown as { agentgemApp?: unknown; __emberFeed?: (e: unknown) => void };
  // EMBER exposes a test seam __emberFeed when no host shim is present (see delta).
  await new Promise((r) => dom.window.setTimeout(r, 0));
  w.__emberFeed?.({ type: "hygiene", verdict: "bloated", cap: 200000, curveTail: [{ turn: 9, msgIndex: 18, ctxTokens: 160000, cacheCreation: 0, outTokens: 0 }] });
  const fill = dom.window.document.getElementById("fill") as HTMLElement;
  expect(parseFloat(fill.style.width)).toBeGreaterThan(75); // 160000/200000 = 80%
});
```
(If `runScripts` + canvas proves flaky under jsdom, assert on a pure `applyHygiene(state, evt)` function exported via a `<script type="module">`-free seam instead; keep the DOM assertion as the primary.)

- [ ] **Step 2: Run it, verify it fails.**
Run: `pnpm --filter @agentgem/play test -- ember`
Expected: FAIL — stub HTML has no `#fill`.

- [ ] **Step 3: Assemble `EMBER_HTML`.** Head = `${mcpAppClient()}` + the mockup's `<title>` + the mockup's entire `<style>…</style>`. Body = the mockup's `.stage` markup verbatim, plus a `<div class="demo-badge" id="demoBadge">DEMO</div>` (styled in the copied `<style>` with a new rule). Then this script layer **replacing** the mockup's state/loop/actions (canvas `render()`/`puff()` stay verbatim):

```js
// ---- mode + host wiring ----
var app = window.agentgemApp;
var live = false;                 // flips true on the first real hygiene event
var CAP = 1000000;                // replaced by the streamed cap in live mode
var SWEET_LO = 0.14, SWEET_HI = 0.32, NUDGE_MID = 0.52, NUDGE_HOT = 0.78; // fractions of CAP
function SWEET(){ return [SWEET_LO*CAP, SWEET_HI*CAP]; }

// applyHygiene: map one hygiene event onto game state. The latest curve point is the current window.
function applyHygiene(evt){
  if(!evt || evt.type==='nudge'){ if(evt&&evt.advice) toast(String(evt.advice).slice(0,140)); return; }
  var tail = evt.curveTail || [];
  var last = tail[tail.length-1];
  if(!last) return;
  if(typeof evt.cap==='number' && evt.cap>0) CAP=evt.cap;
  if(!live){ live=true; g=fresh(); document.getElementById('demoBadge').style.display='none'; }
  g.context = last.ctxTokens;
  g.turn = last.turn;
  g.freshness = Math.max(0, Math.round(100*(1 - Math.min(1, g.context/CAP))));
  g.work = Math.max(g.work, 12);  // real progress exists; enough to make BANK live
  layoutSweet(); syncHUD();
}
window.__emberFeed = applyHygiene;  // test + no-host seam

if(app){
  app.onNotification('agentgem_subscribe_hygiene', applyHygiene);
  app.callTool('agentgem_subscribe_hygiene').catch(function(){ /* idle/denied -> stays demo */ });
}
// Demo mode: the mockup's TICK self-simulation, but ONLY while not live.
var last=performance.now(),acc=0;const TICK=1200;
function loop(now){requestAnimationFrame(loop);const dt=now-last;last=now;render(dt);
  if(live||g.burned)return; acc+=dt; while(acc>=TICK){acc-=TICK;turn();}}
requestAnimationFrame(loop);
```

Then in `bankIt()`, branch on `live`:
```js
if(live){
  // Honest live gauge: BANK scores the DECISION and nudges /compact, but does NOT reset — the flame
  // only cools when the user actually compacts and the next hygiene event shows fewer ctxTokens.
  var clean=inSweet();
  if(clean){ state.streak++; state.score+=Math.max(1,Math.round(g.freshness*(1+state.streak*0.12))); }
  combo(clean?'CLEAN CUT — /compact':'bank early',clean?'var(--fresh)':'var(--ash)');
  toast(clean?'🟢 <b>clean cut.</b> run <b>/compact</b> now to bank this work.':'run <b>/compact</b> to bank and reset the window.');
  state.best=Math.max(state.best,state.score); syncHUD(); return;
}
// ...demo path: the mockup's original reset-on-bank body unchanged...
```

`layoutSweet()`, `mood()`, `syncHUD()` use `SWEET()`/`CAP` (now variables) instead of the mockup's `CAP`/`SWEET` constants — replace those constant refs with the variables. `best` persists via `localStorage` (`try{}catch{}`), keyed `agentgem:ember:best`.

- [ ] **Step 4: Run behavioral test, verify pass.**
Run: `pnpm --filter @agentgem/play test -- ember`
Expected: PASS (gauge width > 75%).

- [ ] **Step 5: Real-browser verify (per UI rule — jsdom never asserts appearance).**
Launch the console against a live session; open Build → Play (or Observe → Arcade); open the **Ember** card; Allow the "read your live session's context-health signal" consent; confirm: the flame color/gauge track the real window, mood text follows verdict, BANK toasts `/compact` in the sweet spot, and with no live session the card shows the DEMO badge + self-running sim. Capture a screenshot.

- [ ] **Step 6: Commit.**
```bash
git add packages/play/src/ember.ts packages/play/src/__tests__/ember.test.ts
git commit -m "feat(play): EMBER live game — hygiene-driven gauge, fractional thresholds, honest BANK

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Suppress delete affordance for built-in Arcade cards

**Files:**
- Modify: `packages/console/src/panels/Play/Arcade.tsx`
- Test: `packages/console/src/panels/Play/__tests__/Arcade.test.tsx` (add a case)

**Interfaces:**
- Consumes: the `Item.name` convention that built-ins are `__`-prefixed (Task 3).

- [ ] **Step 1: Write the failing test** — a `__`-prefixed card renders no delete control.
```ts
it("built-in (__-prefixed) cards have no delete affordance", async () => {
  // Arrange the grid with a mocked list containing { name: "__ember", title: "Ember", genre: "session-heatmap" }
  // (mirror the existing Arcade.test.tsx mock of playMiniappsRoute.call), render <Arcade/>, and assert:
  expect(screen.queryByLabelText(/delete ember/i)).toBeNull();
});
```

- [ ] **Step 2: Run it, verify it fails.**
Run: `pnpm --filter @agentgem/console test -- Arcade`
Expected: FAIL — delete control present for all cards.

- [ ] **Step 3: Guard the delete affordance.** In the card render, gate the delete button/overlay trigger on `!item.name.startsWith("__")`. Built-ins are constants — not registry entries — so deletion is meaningless (and would 404).

- [ ] **Step 4: Run tests, verify pass.**
Run: `pnpm --filter @agentgem/console test -- Arcade`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add packages/console/src/panels/Play/Arcade.tsx packages/console/src/panels/Play/__tests__/Arcade.test.tsx
git commit -m "fix(play): no delete affordance on built-in (__) Arcade cards

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (all tasks)

- [ ] Root `tsc -b` clean.
- [ ] `pnpm --filter @agentgem/model test`, `--filter @agentgem/play test`, `--filter @agentgem/console test` green.
- [ ] Real-browser Arcade check (Task 4 Step 5) captured.
- [ ] Push branch, open PR, watch `test (24)`, merge on green; verify each commit's marker on `origin/main`.

## Self-review notes

- **Spec coverage:** built-in served constant (T3) ✓; Arcade surfacing (T3 list-inject + T5 delete guard) ✓; `context-hygiene` cap across all guard surfaces (T1) ✓; broker via hygiene stream (T2) ✓; gauge = ctxTokens/cap, fractional thresholds, event-driven, real nudge advice, honest live BANK, demo fallback (T4) ✓; phase-2 real BANK explicitly out of scope ✓.
- **Type consistency:** tool name `agentgem_subscribe_hygiene` and cap `context-hygiene` identical across T1–T4; `subscribeHygiene` signature matches `subscribeSessions`.
- **Known jsdom risk:** canvas under jsdom — Task 4 Step 1 provides a `__emberFeed`/`applyHygiene` seam so the behavioral assertion doesn't depend on canvas rendering.
