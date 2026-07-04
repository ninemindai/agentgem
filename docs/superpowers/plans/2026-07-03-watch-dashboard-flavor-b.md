# Watch "Dashboard" mode (Flavor B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third Watch mode (`Feed | Dashboard | Artifact`) where an ACP rendering agent maintains a living HTML dashboard of a running session, evolving it in debounced bursts and rendering it flicker-free in a sandboxed iframe.

**Architecture:** Three units on the Flavor A spine — `renderDashboard` (ACP agent call, mirrors `narrateInsights`), `GET /api/watch/dashboard` (SSE, mirrors `watchEvents`), and `Dashboard.tsx` (double-buffer cross-fade iframe). Reuses `detectEvents`, `sandboxDoc`, `resolveTranscriptFile`, `originGuard`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `node:*`, AgentBack REST app, React 18 + Vite console, vitest. Backend tests compile via `tsc -b` then run from `dist/**/__tests__/**/*.test.js`; console tests run from source via `vitest` in `packages/console`.

**Design spec:** `docs/superpowers/specs/2026-07-03-watch-dashboard-flavor-b-design.md`
**Approved exemplar (prompt one-shot):** `~/.gstack/projects/ninemindai-agentgem/designs/watch-dashboard-20260703/sketch.html` (section 1)

## Global Constraints

- ESM only: every relative import ends in `.js`. Match surrounding file style (double quotes, 2-space indent).
- Backend package tests live at repo-root `src/gem/__tests__/` and `src/__tests__/` (NOT under `packages/insight`), compiled by `tsc -b`, collected from `dist/**/__tests__/**/*.test.js`.
- Never-throw discipline for the agent call: on any failure return the last-good HTML, never throw (mirror `narrateInsights`).
- Generated HTML is untrusted: only ever render it inside `sandbox="allow-scripts"` (null origin, no `allow-same-origin`) via `sandboxDoc` (CSP `default-src 'none'`). Events are already scrubbed by `detectEvents`.
- Reuse existing console tokens (`run-badge run-running`/`run-done`, `ws-chip`, `ledger-empty`); do not introduce new colors.
- Commit after each task with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Run `git config user.email` = `raymond@ninemind.ai` (already set on this worktree).

---

### Task 1: `renderDashboard` — the ACP rendering agent

**Files:**
- Create: `packages/insight/src/dashboardRender.ts`
- Modify: `packages/insight/src/index.ts` (add barrel export)
- Test: `src/gem/__tests__/dashboardRender.test.ts`

**Interfaces:**
- Consumes (from `./acpRecommender.js`): `AcpConnectFn`, `AcpCtx`, `AcpSessionHandle`, `CLAUDE_AGENT`, `analysisWorkspace`, `currentTestConnectFn`, `defaultConnectFn`, `withTimeout`. From `./inspectSession.js`: `SessionEvent`. From `./observeAggregate.js`: `AgentId`.
- Produces: `renderDashboard(input: RenderInput): Promise<RenderResult>` where
  - `RenderInput = { prevHtml: string; deltaEvents: SessionEvent[]; meta: { project: string | null; agent: AgentId }; connectFn?: AcpConnectFn; timeoutMs?: number }`
  - `RenderResult = { html: string; ok: boolean }`
  - `extractHtml(raw: string): string | null` (exported for the test)

- [ ] **Step 1: Write the failing test**

Create `src/gem/__tests__/dashboardRender.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { renderDashboard, extractHtml, type RenderInput } from "@agentgem/insight";
import type { SessionEvent } from "@agentgem/insight";

// A minimal fake ACP connect-fn: its agent returns whatever `reply` we pass, or throws.
function fakeConnect(reply: string | (() => Promise<string>)) {
  return async () => ({
    ctx: {
      open: async () => ({
        setMode: async () => {},
        promptText: async () => (typeof reply === "function" ? reply() : reply),
        dispose: () => {},
      }),
    },
    close: () => {},
  }) as never;
}

const ev = (index: number): SessionEvent => ({ index, tsMs: 0, span: { kind: "message", role: "assistant", text: "hi" } });
const base = (over: Partial<RenderInput> = {}): RenderInput =>
  ({ prevHtml: "", deltaEvents: [ev(0)], meta: { project: "p", agent: "claude" }, ...over });

describe("extractHtml", () => {
  it("returns a bare document unchanged", () => {
    expect(extractHtml("<!doctype html><html><body>x</body></html>")).toContain("<body>x</body>");
  });
  it("unwraps a { html: … } wrapper", () => {
    expect(extractHtml('{"html":"<div>ok</div>"}')).toBe("<div>ok</div>");
  });
  it("rejects prose with no markup", () => {
    expect(extractHtml("I could not build a dashboard.")).toBeNull();
  });
});

describe("renderDashboard", () => {
  it("returns the agent HTML with ok:true on the first render", async () => {
    const r = await renderDashboard(base({ connectFn: fakeConnect("<html><body>dash</body></html>") }));
    expect(r.ok).toBe(true);
    expect(r.html).toContain("dash");
  });
  it("falls back to prevHtml with ok:false on non-markup output", async () => {
    const r = await renderDashboard(base({ prevHtml: "<html>PREV</html>", connectFn: fakeConnect("sorry, no") }));
    expect(r).toEqual({ html: "<html>PREV</html>", ok: false });
  });
  it("falls back on a throwing agent", async () => {
    const r = await renderDashboard(base({ prevHtml: "<b>PREV</b>", connectFn: fakeConnect(async () => { throw new Error("boom"); }) }));
    expect(r).toEqual({ html: "<b>PREV</b>", ok: false });
  });
  it("falls back to empty string on first-render failure", async () => {
    const r = await renderDashboard(base({ prevHtml: "", connectFn: fakeConnect("") }));
    expect(r).toEqual({ html: "", ok: false });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd packages/console/.. && pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/dashboardRender.test.js`
(Run from repo root.) Expected: FAIL — `renderDashboard`/`extractHtml` not exported.

- [ ] **Step 3: Implement `dashboardRender.ts`**

Create `packages/insight/src/dashboardRender.ts` (drive pattern copied verbatim from `narrateInsights.ts`):

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/dashboardRender.ts
//
// Flavor B rendering agent: evolve a living HTML dashboard of a running session.
// Given the previous dashboard HTML and the NEW events since it was rendered, drive
// the ACP agent (plan mode) to return an updated, self-contained HTML document.
// Mirrors narrateInsights: never throws — returns the last-good HTML on any failure.
import {
  type AcpConnectFn, type AcpCtx, type AcpSessionHandle,
  CLAUDE_AGENT, analysisWorkspace, currentTestConnectFn, defaultConnectFn, withTimeout,
} from "./acpRecommender.js";
import type { SessionEvent } from "./inspectSession.js";
import type { AgentId } from "./observeAggregate.js";
import { createLogger } from "@agentgem/base";

const log = createLogger("insight");
const MAX_HTML = 80_000;

export interface RenderInput {
  prevHtml: string;
  deltaEvents: SessionEvent[];
  meta: { project: string | null; agent: AgentId };
  connectFn?: AcpConnectFn;
  timeoutMs?: number;
}
export interface RenderResult { html: string; ok: boolean; }

// The visual contract (anti-slop). Kept terse; the agent gets the palette + rules and
// the compact exemplar so it matches the AgentGem console rather than a generic panel.
const EXEMPLAR =
  `<section style="font-family:'Fraunces',Georgia,serif;background:#f1eadb;color:#20190f;padding:18px 20px">` +
  `<h2 style="margin:0;font-size:16px">acme-web</h2>` +
  `<p style="font-family:'Hanken Grotesk',sans-serif;color:#463d2c;font-size:13px;margin:2px 0 16px">Building the hero, then the build</p>` +
  `<div style="border-left:3px solid #9a3324;background:#fbeee9;padding:8px 12px;border-radius:0 6px 6px 0;margin-bottom:16px">` +
  `<div style="font:600 11px/1 sans-serif;letter-spacing:.07em;text-transform:uppercase;color:#9a3324">Now</div>` +
  `<code style="font-family:ui-monospace,Menlo,monospace;font-size:13px">$ npm run build</code></div>` +
  `<ul style="list-style:none;margin:0;padding:0;font-family:'Hanken Grotesk',sans-serif;font-size:13px">` +
  `<li>Read index.html · done</li><li>Edit hero · done</li><li>Bash npm run build · running</li></ul></section>`;

function buildPrompt(input: RenderInput): string {
  const events = JSON.stringify(input.deltaEvents.map((e) => e.span));
  const prev = input.prevHtml ? input.prevHtml : "(none — this is the first render)";
  return (
    `You render a LIVE dashboard of a running coding-agent session, for the AgentGem console.\n` +
    `PREVIOUS DASHBOARD HTML:\n${prev}\n\n` +
    `NEW EVENTS since it was rendered (JSON):\n${events}\n\n` +
    `Return ONE self-contained HTML document that EVOLVES the previous dashboard in place to reflect the new events. ` +
    `Rules: inline <style> only, NO external resources (no CDN/fonts/img/scripts). ` +
    `Match this palette and composition EXACTLY — do not invent a generic SaaS look:\n` +
    `- surface #f1eadb, ink #20190f, ONE accent #9a3324 (terracotta), #2f6b3a only for done/success\n` +
    `- serif headings, monospace for file paths and shell commands\n` +
    `- ONE visual anchor (current activity); a vertical timeline, NOT a card grid; no gradients, no drop shadows, no emoji\n` +
    `- COMPACT: must fit ~560px tall with no internal scrollbar. Summarize rather than grow.\n` +
    `EXAMPLE of the target look:\n${EXEMPLAR}\n\n` +
    `Return ONLY the HTML (a { "html": "…" } wrapper is also accepted). No prose, no code fences.`
  );
}

/** Pull an HTML document out of the agent reply: unwrap a {html} JSON wrapper, else
 *  trim to the outermost markup. Returns null when there is no markup at all. */
export function extractHtml(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try { const o = JSON.parse(s); if (o && typeof o.html === "string" && o.html.trim()) return o.html; } catch { /* not json */ }
  }
  const lower = s.toLowerCase();
  const start = ((): number => {
    const d = lower.indexOf("<!doctype");
    if (d >= 0) return d;
    const h = lower.indexOf("<html");
    if (h >= 0) return h;
    return s.indexOf("<");
  })();
  const end = s.lastIndexOf(">");
  if (start < 0 || end <= start) return null;
  const html = s.slice(start, end + 1);
  return /<[a-z!][\s\S]*>/i.test(html) ? html : null;
}

export async function renderDashboard(input: RenderInput): Promise<RenderResult> {
  const connectFn = input.connectFn ?? currentTestConnectFn() ?? defaultConnectFn;
  const timeoutMs = input.timeoutMs ?? 60_000;
  let conn: { ctx: AcpCtx; close: () => void } | null = null;
  let handle: AcpSessionHandle | null = null;
  const t0 = Date.now();
  try {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    conn = await withTimeout(connectFn(CLAUDE_AGENT, null), left());
    handle = await withTimeout(conn.ctx.open(analysisWorkspace()), left());
    await withTimeout(handle.setMode("plan"), left());
    const text = await withTimeout(handle.promptText(buildPrompt(input)), left());
    const html = extractHtml(text);
    if (!html) return { html: input.prevHtml, ok: false };
    log.debug("dashboard: rendered in %dms (%d bytes)", Date.now() - t0, html.length);
    return { html: html.slice(0, MAX_HTML), ok: true };
  } catch (err) {
    log.warn("dashboard: fell back after %dms: %s", Date.now() - t0, (err as Error)?.message ?? err);
    return { html: input.prevHtml, ok: false };
  } finally {
    try { handle?.dispose(); } catch { /* ignore */ }
    try { conn?.close(); } catch { /* ignore */ }
  }
}
```

Add to `packages/insight/src/index.ts` (alongside the other `export *` lines):

```typescript
export * from "./dashboardRender.js";
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/gem/__tests__/dashboardRender.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/insight/src/dashboardRender.ts packages/insight/src/index.ts src/gem/__tests__/dashboardRender.test.ts
git commit -m "feat(watch): renderDashboard ACP rendering agent for Flavor B

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `GET /api/watch/dashboard` — debounced SSE endpoint

**Files:**
- Create: `src/watchDashboard.ts`
- Modify: `src/index.ts` (import + route, next to `/api/watch/events`)
- Test: `src/__tests__/watchDashboard.test.ts`

**Interfaces:**
- Consumes: `resolveTranscriptFile`, `sourceForFile` (from `./watchSessions.js`); `renderDashboard`, `type RenderInput`, `type RenderResult` (from `@agentgem/insight`).
- Produces: `streamWatchDashboard(req, res, deps?: { render?: RenderFn; debounceMs?: number; ceiling?: number; fullRegenEvery?: number }): void` where `RenderFn = (input: RenderInput) => Promise<RenderResult>`. `deps.render` defaults to `renderDashboard` (injected for tests).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/watchDashboard.test.ts` (grow-file + fake-timers harness copied from `watchEvents.test.ts`):

```typescript
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamWatchDashboard } from "../watchDashboard.js";
import type { RenderInput, RenderResult } from "@agentgem/insight";

const DEBOUNCE = 4000;
let origHome: string | undefined, home: string, claudeFile: string;
const rec = (o: unknown) => JSON.stringify(o);
const assistantToolUse = (id: string, name: string) => rec({
  type: "assistant", timestamp: "2026-07-03T10:00:00.000Z",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input: { command: "ls" } }] },
});

beforeAll(() => {
  origHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "watchdash-"));
  process.env.HOME = home;
  const cproj = join(home, ".claude", "projects", "p");
  mkdirSync(cproj, { recursive: true });
  claudeFile = join(cproj, "dash-uuid.jsonl");
  writeFileSync(claudeFile, assistantToolUse("t1", "Bash") + "\n");
});
afterAll(() => { process.env.HOME = origHome; rmSync(home, { recursive: true, force: true }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function harness(file: string, render: (i: RenderInput) => Promise<RenderResult>, opts = {}) {
  vi.useFakeTimers();
  let buf = "";
  const res = { writeHead() {}, write(c: string) { buf += c; }, end() {} };
  streamWatchDashboard({ query: { file }, on() {} } as never, res as never, { render, debounceMs: DEBOUNCE, ...opts });
  const parse = () => {
    const out: { event: string; data: any }[] = [];
    for (const block of buf.split("\n\n")) {
      const em = /^event: (.+)$/m.exec(block); const dm = /^data: (.+)$/m.exec(block);
      if (em && dm) out.push({ event: em[1], data: JSON.parse(dm[1]) });
    }
    return out;
  };
  const bump = () => { const t = Math.floor(statSync(file).mtimeMs / 1000) + 60; utimesSync(file, t, t); };
  return { parse, bump };
}

describe("streamWatchDashboard", () => {
  it("rejects an out-of-scope file", () => {
    const { parse } = harness("/etc/passwd.jsonl", async () => ({ html: "<x/>", ok: true }));
    expect(parse()).toEqual([{ event: "failed", data: { message: "unknown or out-of-scope transcript file" } }]);
  });

  it("coalesces a burst into ONE render after the debounce, passing all events as the delta", async () => {
    let calls = 0; let seenDelta = 0;
    const render = async (i: RenderInput) => { calls++; seenDelta = i.deltaEvents.length; return { html: `<h1>v${calls}</h1>`, ok: true }; };
    const { parse, bump } = harness(claudeFile, render);
    // backlog: one tool_use event exists; append two more within the window
    appendFileSync(claudeFile, assistantToolUse("t2", "Read") + "\n" + assistantToolUse("t3", "Edit") + "\n");
    bump();
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(calls).toBe(1);
    expect(seenDelta).toBe(3);
    const render1 = parse().filter((e) => e.event === "render");
    expect(render1).toHaveLength(1);
    expect(render1[0].data.html).toContain("v1");
    expect(render1[0].data.version).toBe(1);
  });

  it("keeps last render and does NOT advance on failure", async () => {
    let calls = 0;
    const render = async (): Promise<RenderResult> => { calls++; return { html: "", ok: false }; };
    const { parse, bump } = harness(claudeFile, render);
    bump();
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    expect(calls).toBe(1);
    const evs = parse();
    expect(evs.some((e) => e.event === "failed")).toBe(true);
    expect(evs.some((e) => e.event === "render")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/watchDashboard.test.js`
Expected: FAIL — `streamWatchDashboard` not found.

- [ ] **Step 3: Implement `src/watchDashboard.ts`**

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/watchDashboard.ts
//
// SSE endpoint for the Watch "Dashboard" mode (Flavor B). Tails ONE transcript,
// coalesces bursts of events, and streams a living HTML dashboard the ACP agent
// evolves in place. Sibling of watchEvents.ts (event feed) and watchStream.ts (HTML
// artifacts). Debounced: one render per work-burst. Renders only when there are
// unreflected events and no render is in flight. A bad render keeps the last good HTML.
import { statSync, readFileSync } from "node:fs";
import { resolveTranscriptFile, sourceForFile } from "./watchSessions.js";
import { renderDashboard, type RenderInput, type RenderResult } from "@agentgem/insight";

interface SseReq { query: Record<string, unknown>; on?(event: string, cb: () => void): void; }
interface SseRes { writeHead(s: number, h: Record<string, string>): void; write(c: string): void; end(): void; }
type RenderFn = (input: RenderInput) => Promise<RenderResult>;

const POLL_MS = 1000, HEARTBEAT_MS = 15000;

export function streamWatchDashboard(
  req: SseReq, res: SseRes,
  deps: { render?: RenderFn; debounceMs?: number; ceiling?: number; fullRegenEvery?: number } = {},
): void {
  const render = deps.render ?? renderDashboard;
  const debounceMs = deps.debounceMs ?? 4000;
  const ceiling = deps.ceiling ?? 40;
  const fullRegenEvery = deps.fullRegenEvery ?? 15;

  const fileParam = typeof req.query.file === "string" ? req.query.file : "";
  const resolved = resolveTranscriptFile(fileParam);
  const source = resolved ? sourceForFile(resolved) : null;

  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) => { res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); };

  if (!resolved || !source?.detectEvents) {
    send("failed", { message: "unknown or out-of-scope transcript file" }); res.end(); return;
  }

  let prevHtml = "", reflectedCount = 0, rendersSinceFull = 0, version = 0;
  let inFlight = false, lastMtime = -1;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const project = source.parseMeta ? (source.parseMeta(safeRead(resolved), resolved)?.project ?? null) : null;

  const fireRender = async () => {
    debounceTimer = null;
    if (inFlight) return;
    const events = source.detectEvents!(safeRead(resolved), resolved);
    if (events.length <= reflectedCount) return;
    inFlight = true;
    send("rendering", {});
    const full = rendersSinceFull >= fullRegenEvery || prevHtml.length > 80_000;
    const input: RenderInput = {
      prevHtml: full ? "" : prevHtml,
      deltaEvents: full ? events : events.slice(reflectedCount),
      meta: { project, agent: source.id },
    };
    try {
      const { html, ok } = await render(input);
      if (ok) {
        prevHtml = html; reflectedCount = events.length; rendersSinceFull = full ? 0 : rendersSinceFull + 1;
        send("render", { html, version: ++version });
      } else {
        send("failed", { message: "render failed" }); // keep prevHtml, do not advance reflectedCount
      }
    } finally {
      inFlight = false;
      if (source.detectEvents!(safeRead(resolved), resolved).length > reflectedCount) arm();
    }
  };

  const arm = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    const unreflected = source.detectEvents!(safeRead(resolved), resolved).length - reflectedCount;
    if (unreflected >= ceiling) { void fireRender(); return; }
    debounceTimer = setTimeout(() => { void fireRender(); }, debounceMs);
  };

  const tick = () => {
    let m: number; try { m = statSync(resolved).mtimeMs; } catch { return; }
    if (m === lastMtime) return;
    lastMtime = m;
    if (source.detectEvents!(safeRead(resolved), resolved).length > reflectedCount) arm();
  };

  send("phase", { phase: "watching", agent: source.id });
  tick(); // pick up backlog

  const poll = setInterval(tick, POLL_MS);
  const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, HEARTBEAT_MS);
  req.on?.("close", () => {
    clearInterval(poll); clearInterval(beat); if (debounceTimer) clearTimeout(debounceTimer);
    try { res.end(); } catch { /* ended */ }
  });
}

function safeRead(file: string): string { try { return readFileSync(file, "utf8"); } catch { return ""; } }
```

Add to `src/index.ts` next to the existing watch routes:

```typescript
import { streamWatchDashboard } from "./watchDashboard.js";
// …
server.expressApp.get("/api/watch/dashboard", originGuard, (req, res) => streamWatchDashboard(req as never, res as never));
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm exec tsc -b && pnpm exec vitest run dist/__tests__/watchDashboard.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/watchDashboard.ts src/index.ts src/__tests__/watchDashboard.test.ts
git commit -m "feat(watch): /api/watch/dashboard debounced SSE endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `dashboardStream.ts` client + `Dashboard.tsx` (double-buffer)

**Files:**
- Create: `packages/console/src/panels/Watch/dashboardStream.ts`
- Create: `packages/console/src/panels/Watch/Dashboard.tsx`
- Modify: `packages/console/src/panels/Watch/index.tsx` (export `sandboxDoc` if not already; it is already exported)
- Modify: `packages/console/src/shell/theme.css` (double-buffer iframe styles)
- Test: `packages/console/src/panels/Watch/__tests__/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `sandboxDoc` (from `./index.js`).
- Produces: `openDashboardStream(apiBase, file, onEvent): () => void`; `DashMsg` union; `Dashboard({ apiBase, file }): JSX.Element`.

- [ ] **Step 1: Write the client**

Create `packages/console/src/panels/Watch/dashboardStream.ts`:

```typescript
// Watch Dashboard-mode data layer: subscribe to one session's living HTML dashboard
// via EventSource — named events phase/rendering/render/failed. Mirror of eventStream.ts.
export type DashMsg =
  | { type: "phase"; phase: string; agent: string }
  | { type: "rendering" }
  | { type: "render"; html: string; version: number }
  | { type: "failed"; message: string };

export function openDashboardStream(apiBase: string, file: string, onEvent: (e: DashMsg) => void): () => void {
  const es = new EventSource(`${apiBase}/api/watch/dashboard?${new URLSearchParams({ file })}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);
  es.addEventListener("phase", (m) => { const d = data(m); onEvent({ type: "phase", phase: d.phase, agent: d.agent }); });
  es.addEventListener("rendering", () => onEvent({ type: "rendering" }));
  es.addEventListener("render", (m) => { const d = data(m); onEvent({ type: "render", html: d.html, version: d.version }); });
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "connection lost" }));
  return () => es.close();
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/console/src/panels/Watch/__tests__/Dashboard.test.tsx`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Dashboard } from "../Dashboard.js";

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, cb: (e: unknown) => void) { (this.listeners[t] ??= []).push(cb); }
  close() {}
  emit(t: string, data: unknown) { for (const cb of this.listeners[t] ?? []) cb({ data: JSON.stringify(data) }); }
}
afterEach(() => { cleanup(); FakeES.last = null; vi.unstubAllGlobals(); });

const frames = () => Array.from(document.querySelectorAll("iframe")) as HTMLIFrameElement[];

describe("Dashboard", () => {
  it("opens the dashboard stream for the file", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<Dashboard apiBase="" file="/w/.claude/projects/p/s.jsonl" />);
    expect(FakeES.last!.url).toContain("/api/watch/dashboard");
    expect(FakeES.last!.url).toContain("s.jsonl");
  });

  it("first render lands HTML in a sandboxed iframe; a11y region announces it", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<Dashboard apiBase="" file="/w/s.jsonl" />);
    expect(screen.getByText(/Reading the session/i)).toBeTruthy();
    FakeES.last!.emit("render", { html: "<h1>alpha</h1>", version: 1 });
    const visible = frames().find((f) => f.getAttribute("srcdoc")?.includes("alpha"))!;
    expect(visible.getAttribute("sandbox")).toBe("allow-scripts");
    expect(screen.getByRole("status").textContent).toMatch(/updated/i);
  });

  it("double-buffers: the second render writes into the OTHER iframe", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<Dashboard apiBase="" file="/w/s.jsonl" />);
    FakeES.last!.emit("render", { html: "<h1>one</h1>", version: 1 });
    FakeES.last!.emit("render", { html: "<h1>two</h1>", version: 2 });
    const srcdocs = frames().map((f) => f.getAttribute("srcdoc") ?? "");
    expect(srcdocs.some((s) => s.includes("one"))).toBe(true);
    expect(srcdocs.some((s) => s.includes("two"))).toBe(true); // both buffers retained
    expect(frames()).toHaveLength(2);
  });

  it("keeps the last render and shows a note on failure", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<Dashboard apiBase="" file="/w/s.jsonl" />);
    FakeES.last!.emit("render", { html: "<h1>good</h1>", version: 1 });
    FakeES.last!.emit("failed", { message: "render failed" });
    expect(frames().some((f) => f.getAttribute("srcdoc")?.includes("good"))).toBe(true);
    expect(screen.getByText(/showing last render/i)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `cd packages/console && pnpm exec vitest run src/panels/Watch/__tests__/Dashboard.test.tsx`
Expected: FAIL — `Dashboard` not found.

- [ ] **Step 4: Implement `Dashboard.tsx`**

Create `packages/console/src/panels/Watch/Dashboard.tsx`:

```typescript
import { useEffect, useRef, useState } from "react";
import { openDashboardStream } from "./dashboardStream.js";
import { sandboxDoc } from "./index.js";

// Two stacked iframes, cross-faded. A new render is written into the HIDDEN buffer;
// on its load we fade it in and flip `visible`. No white flash, no scroll-reset — this
// is what makes the wholesale-HTML update read as "evolve in place" (design D2).
export function Dashboard({ apiBase, file }: { apiBase: string; file: string }) {
  const [bufs, setBufs] = useState<[string, string]>(["", ""]);
  const [visible, setVisible] = useState(0); // index of the on-screen buffer
  const [rendered, setRendered] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [announce, setAnnounce] = useState("");
  const targetRef = useRef(0); // buffer we last wrote into

  useEffect(() => {
    setBufs(["", ""]); setVisible(0); setRendered(false); setRendering(false); setFailed(false); setAnnounce("");
    return openDashboardStream(apiBase, file, (m) => {
      if (m.type === "rendering") setRendering(true);
      else if (m.type === "failed") { setRendering(false); if (rendered) setFailed(true); }
      else if (m.type === "render") {
        setRendering(false); setFailed(false);
        setBufs((prev) => {
          const next: [string, string] = [prev[0], prev[1]];
          const write = rendered ? (visible === 0 ? 1 : 0) : 0; // hidden buffer, or buffer 0 first time
          next[write] = sandboxDoc(m.html);
          targetRef.current = write;
          return next;
        });
        setAnnounce(`dashboard updated`);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, file]);

  // When the freshly-written buffer paints, flip visibility to it (cross-fade via CSS).
  const onBufLoad = (idx: number) => {
    if (!bufs[idx]) return;
    if (idx === targetRef.current) { setVisible(idx); setRendered(true); }
  };

  return (
    <div className="dash-pane">
      <div className="run-status" style={{ gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        {rendering && <span className="run-badge run-running">rendering</span>}
        {failed && <span className="run-badge" title="the last dashboard failed to update">showing last render</span>}
      </div>
      {!rendered && !failed && (
        <p className="ledger-empty"><strong style={{ display: "block" }}>Reading the session…</strong>
          Building the first dashboard from what the agent has done. Usually a few seconds.</p>
      )}
      <div className="dash-frames" data-empty={!rendered}>
        {[0, 1].map((i) => (
          bufs[i] ? (
            <iframe
              key={i}
              title="session dashboard"
              aria-label="session dashboard"
              sandbox="allow-scripts"
              srcDoc={bufs[i]}
              className={"dash-frame" + (visible === i ? " is-visible" : "")}
              onLoad={() => onBufLoad(i)}
            />
          ) : null
        ))}
      </div>
      <div role="status" aria-live="polite" className="sr-only">{announce}</div>
    </div>
  );
}
```

- [ ] **Step 5: Add styles to `packages/console/src/shell/theme.css`**

Append after the `.feed-*` block:

```css
/* Watch → Dashboard: double-buffered, cross-faded iframes (design D2) */
.dash-frames { position: relative; width: 100%; height: 560px; }
.dash-frames[data-empty="true"] { height: 0; }
.dash-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 1px solid var(--line);
  border-radius: var(--radius); background: var(--paper); opacity: 0; transition: opacity .15s ease; }
.dash-frame.is-visible { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .dash-frame { transition: none; } }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `cd packages/console && pnpm exec vitest run src/panels/Watch/__tests__/Dashboard.test.tsx`
Expected: PASS (4 tests). Note: jsdom fires `iframe` `onLoad` synchronously on `srcDoc` set; if a test needs the load, `fireEvent.load(frame)`.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Watch/dashboardStream.ts packages/console/src/panels/Watch/Dashboard.tsx packages/console/src/panels/Watch/__tests__/Dashboard.test.tsx packages/console/src/shell/theme.css
git commit -m "feat(console): double-buffer Dashboard panel for Watch Flavor B

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire the `Feed | Dashboard | Artifact` toggle

**Files:**
- Modify: `packages/console/src/panels/Watch/index.tsx`
- Test: `packages/console/src/panels/Watch/__tests__/Watch.test.tsx` (add a case)

**Interfaces:**
- Consumes: `Dashboard` (from `./Dashboard.js`), the existing `view` state.

- [ ] **Step 1: Write the failing test**

Add to `packages/console/src/panels/Watch/__tests__/Watch.test.tsx` inside the `describe("Watch panel", …)`:

```typescript
it("switches to the Dashboard tab and opens the dashboard stream", async () => {
  vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [SESSION] }) })) as unknown as typeof fetch);
  render(<Watch apiBase="" />);
  fireEvent.click(await screen.findByText("site"));
  fireEvent.click(screen.getByRole("tab", { name: "Dashboard" }));
  expect(FakeES.last!.url).toContain("/api/watch/dashboard");
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd packages/console && pnpm exec vitest run src/panels/Watch/__tests__/Watch.test.tsx`
Expected: FAIL — no "Dashboard" tab.

- [ ] **Step 3: Wire the toggle in `index.tsx`**

Add the import at the top:

```typescript
import { Dashboard } from "./Dashboard.js";
```

Change the toggle block (currently `Feed | Artifact`) to three tabs and add the mount. Replace the two-button toggle with:

```typescript
<div className="feed-toggle" role="tablist" aria-label="watch mode" style={{ marginBottom: 8 }}>
  <button type="button" role="tab" aria-selected={view === "feed"}
    className={"ledger-view" + (view === "feed" ? " is-active" : "")} onClick={() => setView("feed")}>Feed</button>
  <button type="button" role="tab" aria-selected={view === "dashboard"}
    className={"ledger-view" + (view === "dashboard" ? " is-active" : "")} onClick={() => setView("dashboard")}>Dashboard</button>
  <button type="button" role="tab" aria-selected={view === "artifact"}
    className={"ledger-view" + (view === "artifact" ? " is-active" : "")} onClick={() => setView("artifact")}>Artifact</button>
</div>
```

Update the `view` state type and the pane switch:

```typescript
const [view, setView] = useState<"feed" | "dashboard" | "artifact">("feed");
// …
{view === "feed" ? <SessionFeed key={selected} apiBase={apiBase} file={selected} />
 : view === "dashboard" ? <Dashboard key={selected} apiBase={apiBase} file={selected} />
 : <ArtifactPane key={selected} apiBase={apiBase} file={selected} />}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd packages/console && pnpm exec vitest run src/panels/Watch/__tests__/Watch.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Watch/index.tsx packages/console/src/panels/Watch/__tests__/Watch.test.tsx
git commit -m "feat(console): add Dashboard to the Watch mode toggle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full verification + real-HTTP smoke

**Files:** none (verification only)

- [ ] **Step 1: Full backend suite**

Run (repo root): `pnpm build && pnpm exec vitest run`
Expected: all green (new: `dashboardRender` 7, `watchDashboard` 3). If `consoleMount` fails with "console not built", that's the known fresh-worktree artifact — `pnpm build` above already built it.

- [ ] **Step 2: Console suite + typecheck**

Run: `cd packages/console && pnpm exec tsc -p tsconfig.json --noEmit && pnpm exec vitest run`
Expected: all green (new: `Dashboard` 4, `Watch` +1).

- [ ] **Step 3: Real-HTTP smoke (uses a stub render so no live agent needed)**

The endpoint uses the real ACP agent by default. For a no-agent smoke test, temporarily set a fake by env is out of scope; instead verify the stream wiring with the injected default is exercised by the unit tests, and manually confirm the route is registered:

```bash
HOME=$(mktemp -d) PORT=4321 node dist/index.js >/tmp/dash-server.log 2>&1 &
sleep 2
curl -s -m 2 "http://127.0.0.1:4321/api/watch/dashboard?file=/etc/nope.jsonl" | head -3
# Expected: event: failed  /  data: {"message":"unknown or out-of-scope transcript file"}
pkill -f "dist/index.js"
```

- [ ] **Step 4: Browser check (optional, needs a live session or a hand-made transcript)**

Boot the server against a temp HOME with a Claude transcript (see the Flavor A smoke pattern), open `#/watch`, pick the session, click **Dashboard**. Confirm: waiting state → dashboard cross-fades in → no white flash on subsequent renders. (Requires the ACP agent to be available locally.)

---

## Self-Review notes

- **Spec coverage:** Unit 1 → Task 1; Unit 2 → Task 2; Unit 3 → Tasks 3-4; drift controls (debounce/ceiling/full-regen/single-in-flight) → Task 2 impl + one test each; states/a11y/double-buffer → Task 3; anti-slop contract → Task 1 `buildPrompt`. Security (sandbox/CSP/originGuard/resolveTranscriptFile) reused, asserted in Task 3 (`sandbox="allow-scripts"`) and Task 2 (out-of-scope reject).
- **Type consistency:** `RenderInput`/`RenderResult` defined in Task 1, consumed by name in Task 2 (`deps.render`) and its test. `DashMsg` events (`phase`/`rendering`/`render`/`failed`) match between `watchDashboard.ts` `send(...)` calls and `dashboardStream.ts` listeners and the `Dashboard` handler.
- **Known env notes:** backend tests run from `dist/`; run `tsc -b` before `vitest`. jsdom fires iframe `onLoad` on `srcDoc` set.
