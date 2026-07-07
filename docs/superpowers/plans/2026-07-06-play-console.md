# Play — Console Surface (Plan 3 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Play visible and clickable — a `Play` console panel with an **Arcade** (grid of your miniapps, playable in a sealed iframe), a **Composer** (pick a source → seed a studio), and a **Studio** (chat with the agent that builds the miniapp, with a live preview + Save/Publish). Turns the landed backend (Plans 1/2/2b) into a usable feature.

**Architecture:** A new `packages/console/src/panels/Play/` panel. It talks to the existing `/api/play/*` routes via typed `defineRoute` declarations added to `api/routes.ts` (the reviewer-expected pattern), plus one new backend endpoint — `GET /api/play/miniapp` — that returns a single miniapp's HTML (the list route only returns metadata). The Arcade/Runner reuse `Watch/sandboxDoc.ts` (null-origin sandboxed iframe, strict CSP); the Studio drives a chat session with the `miniapp` field (Plan 2b) and re-fetches the HTML into a double-buffered preview iframe after each agent turn. Permission chips are display-only; the consent/broker *runtime* is deferred (all v1 genres are Offline).

**Tech Stack:** React 19 + `@testing-library/react` + vitest (jsdom), `@agentback/client` (`makeClient`/`defineRoute`), the console's global `theme.css` utility classes + inline styles.

## Global Constraints

- **Node >= 24;** CI runs `pnpm build` before `pnpm test`.
- **Backend logic tested in root `src/**/__tests__/`** (CI-gated). **Console component tests** live at `packages/console/src/**/*.test.tsx` and run via `pnpm --filter @agentgem/console test` (jsdom) — they are NOT in root CI, but the console CODE IS typechecked by `tsc -b` in CI, so it MUST compile. Run BOTH `pnpm test` (root, for backend + build) and `pnpm --filter @agentgem/console test` (for the panel tests) before committing UI tasks.
- **`tsc -b` is the source of truth for type breakage** (it compiles the console too).
- **Reuse, don't reinvent:** `sandboxDoc` from `packages/console/src/panels/Watch/sandboxDoc.ts`; the double-buffered preview pattern from `panels/Watch/Dashboard.tsx`; the picker layout from `panels/Curate/Analyze.tsx` and `panels/Watch/index.tsx` (session list); the `analyze`/`ledger-*`/`run-*` theme classes; `makeClient`/`defineRoute` for HTTP.
- **`ConsolePage` requires BOTH `phase` and `category`** (`registry.ts` `assertPlacement` throws otherwise) — Play uses `phase: "build", category: "setup"`, unique `id: "play"`.
- **Sealed preview only:** always render miniapp HTML via `<iframe sandbox="allow-scripts" srcDoc={sandboxDoc(html)} />` — never `allow-same-origin`, never raw `srcDoc`.
- **Permission chips are display-only in v1;** do NOT build the consent gate or the postMessage broker (dormant — no v1 genre declares `needs`). Leave a clear TODO comment pointing at the spec's Permissions Model.
- **Commits:** author `Raymond Feng <raymond@ninemind.ai>`; end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Landmarks (verified)

- Page contract: `packages/console/src/contract.ts` (`ConsolePage`, `defineConsolePage`); register in `packages/console/src/pages.tsx` (import + array slot); `Deploy/index.tsx:22-30` is a `phase:"build"` example.
- Sealed iframe: `panels/Watch/index.tsx:73-81`; `panels/Watch/sandboxDoc.ts` (`sandboxDoc(html): string`); double-buffer in `panels/Watch/Dashboard.tsx`.
- Chat: `panels/Chat/index.tsx:62-72` (POST `/api/chat` `{agentId}` → `{chatId}`; add `miniapp`); `panels/Chat/chatStream.ts` (`openChatStream(chatId, message, handlers)`, events delta/tool/done/failed — but it hardcodes `/api/chat/stream`; PREFER the Watch convention and thread `apiBase`).
- HTTP: `api/routes.ts:800` `makeClient(apiBase)`; `defineRoute("GET"|"POST", path, { query?, body?, response })`; `route.call(client, { query|body })` (throws `ClientError`) / `route.safeCall(...)`.
- Backend Play routes: `src/play.controller.ts` (`/play/save`,`/play/studio`,`/play/miniapps`,`/play/publish`); `listMiniapps()`/`miniappDir()`/`MiniappMeta` in `packages/play/src/miniapps.ts`.
- Pickers: `panels/Curate/Analyze.tsx` (project picker via `testbedProjectsRoute`); `panels/Watch/index.tsx:91-134` (session list via `fetchSessions`).
- Console tests: `panels/Watch/__tests__/Dashboard.test.tsx` (Fake `EventSource`, assert iframe `srcdoc`/`sandbox`); `vitest.config.ts` (jsdom, `src/**/*.test.{ts,tsx}`).

---

### Task 1: Backend — `readMiniapp` + `GET /api/play/miniapp`, and `needs` on the list

**Files:**
- Modify: `packages/play/src/miniapps.ts` (add `readMiniapp`; add `needs` to list items), `packages/play/src/index.ts`
- Modify: `src/play.controller.ts` (add `@get("/play/miniapp")`; add `needs` to the list mapping), `src/schemas.ts` (schemas)
- Test: `src/play/__tests__/readMiniapp.test.ts`

**Interfaces:**
- Produces: `function readMiniapp(name: string): { name: string; html: string; meta: MiniappMeta }` (throws if absent); `listMiniapps()` items keep `meta` (so the route can surface `needs`).

- [ ] **Step 1: Write the failing test**

```ts
// src/play/__tests__/readMiniapp.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMiniapp, readMiniapp } from "@agentgem/play";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agh-")); process.env.AGENTGEM_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.AGENTGEM_HOME; });

const meta = { title: "T", genre: "project-fun" as const, createdFrom: { kind: "project" as const, path: "/p", flavor: "node" }, engineVersion: "1" };

describe("readMiniapp", () => {
  it("returns the html + meta for a saved miniapp", async () => {
    await saveMiniapp({ name: "g1", html: "<!doctype html><body><canvas></canvas></body>", meta });
    const r = readMiniapp("g1");
    expect(r.name).toBe("g1");
    expect(r.html).toContain("canvas");
    expect(r.meta.title).toBe("T");
  });
  it("throws for an unknown miniapp", () => { expect(() => readMiniapp("nope")).toThrow(); });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm test -- readMiniapp` → FAIL.

- [ ] **Step 3: Implement** — add to `packages/play/src/miniapps.ts`:

```ts
export function readMiniapp(name: string): { name: string; html: string; meta: MiniappMeta } {
  const dir = miniappDir(name); // validates + jails
  const html = readFileSync(join(dir, `${name}.html`), "utf8");
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as MiniappMeta;
  return { name, html, meta };
}
```

Export it in `packages/play/src/index.ts` (append to the miniapps export line): `readMiniapp`.

In `src/schemas.ts` add:
```ts
export const PlayMiniappQuerySchema = z.object({ name: z.string() });
export const PlayMiniappSchema = z.object({
  name: z.string(), html: z.string(),
  meta: z.object({
    title: z.string(), genre: z.string(),
    needs: z.array(z.enum(["live-session-events", "local-project-access", "invoke-agent"])).optional(),
  }),
});
```
Change `MiniappListSchema` (already defined) to include `needs`:
```ts
export const MiniappListSchema = z.object({ miniapps: z.array(z.object({
  name: z.string(), title: z.string(), genre: z.string(),
  needs: z.array(z.enum(["live-session-events", "local-project-access", "invoke-agent"])).optional(),
})) });
```

In `src/play.controller.ts`:
- import `readMiniapp` from `@agentgem/play` and the two schemas.
- Add `needs` to the list mapping: `.map((m) => ({ name: m.name, title: m.meta.title, genre: m.meta.genre, ...(m.meta.needs ? { needs: m.meta.needs } : {}) }))`.
- Add the route:
```ts
@get("/play/miniapp", { query: PlayMiniappQuerySchema, response: PlayMiniappSchema })
async miniapp(input: { query: z.infer<typeof PlayMiniappQuerySchema> }): Promise<z.infer<typeof PlayMiniappSchema>> {
  try {
    const r = readMiniapp(input.query.name);
    return { name: r.name, html: r.html, meta: { title: r.meta.title, genre: r.meta.genre, ...(r.meta.needs ? { needs: r.meta.needs } : {}) } };
  } catch (e) { throw new AgentError((e as Error).message, { status: 404 }); }
}
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm test -- readMiniapp` → PASS. Then `pnpm test` (full).

- [ ] **Step 5: Commit**
```bash
git add packages/play src/play.controller.ts src/schemas.ts src/play/__tests__/readMiniapp.test.ts
git commit -m "$(printf 'feat(play): GET /api/play/miniapp (html+meta) + needs on the list\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Console route declarations (`api/routes.ts`)

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add `defineRoute`s + zod schemas for `/api/play/*`)
- Test: none (compile-checked by `tsc -b`; exercised by the panels)

**Interfaces:**
- Produces: `playMiniappsRoute` (GET), `playMiniappRoute` (GET, query `{name}`), `playStudioRoute` (POST), `playSaveRoute` (POST), `playPublishRoute` (POST) — thin client mirrors of the server schemas.

- [ ] **Step 1: Add the routes** — near the other route declarations in `packages/console/src/api/routes.ts` (follow the existing `defineRoute` + local zod-schema style used there; do NOT import server schemas — the console mirrors them, like `cuts.ts` mirrors the cut vocab):

```ts
const PlaySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), agent: z.string(), project: z.string().optional(), sessionId: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("skill"), skillName: z.string(), sourceId: z.string().optional() }),
  z.object({ kind: z.literal("project"), path: z.string(), flavor: z.string() }),
]);
const PlayMetaSchema = z.object({
  title: z.string(), genre: z.enum(["replay", "skill-run", "project-fun"]),
  createdFrom: PlaySourceSchema, engineVersion: z.string().default("1"),
  needs: z.array(z.enum(["live-session-events", "local-project-access", "invoke-agent"])).optional(),
});

export const playMiniappsRoute = defineRoute("GET", "/api/play/miniapps", {
  response: z.object({ miniapps: z.array(z.object({ name: z.string(), title: z.string(), genre: z.string(),
    needs: z.array(z.enum(["live-session-events", "local-project-access", "invoke-agent"])).optional() })) }),
});
export const playMiniappRoute = defineRoute("GET", "/api/play/miniapp", {
  query: z.object({ name: z.string() }),
  response: z.object({ name: z.string(), html: z.string(),
    meta: z.object({ title: z.string(), genre: z.string(),
      needs: z.array(z.enum(["live-session-events", "local-project-access", "invoke-agent"])).optional() }) }),
});
export const playStudioRoute = defineRoute("POST", "/api/play/studio", {
  body: z.object({ source: PlaySourceSchema }), response: z.object({ name: z.string() }),
});
export const playSaveRoute = defineRoute("POST", "/api/play/save", {
  body: z.object({ name: z.string(), html: z.string(), meta: PlayMetaSchema }),
  response: z.object({ name: z.string(), commit: z.string().nullable() }),
});
export const playPublishRoute = defineRoute("POST", "/api/play/publish", {
  body: z.object({ remote: z.string().url().optional() }), response: z.object({ ok: z.boolean() }),
});
```

> Confirm the exact `defineRoute` import + `z` import already present at the top of `api/routes.ts` (`grep -n "defineRoute\|import { z }\|from \"zod\"" api/routes.ts`); match their style. If `defineRoute` requires a specific generic/options shape, mirror an existing GET-with-query route (e.g. `usageRoute`) verbatim.

- [ ] **Step 2: Verify it compiles** — `pnpm exec tsc -b` → CLEAN (this typechecks the console). No unit test; the panels in later tasks exercise these.

- [ ] **Step 3: Commit**
```bash
git add packages/console/src/api/routes.ts
git commit -m "$(printf 'feat(console): typed client routes for /api/play/*\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: The Runner + Arcade (`Runner.tsx`, `Arcade.tsx`)

**Files:**
- Create: `packages/console/src/panels/Play/Runner.tsx`, `packages/console/src/panels/Play/Arcade.tsx`
- Test: `packages/console/src/panels/Play/__tests__/Arcade.test.tsx`

**Interfaces:**
- Produces: `Runner({ html }: { html: string })` — the sealed iframe; `Arcade({ apiBase, onOpen }: { apiBase: string; onOpen: (name: string) => void })` — the miniapp grid.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/panels/Play/__tests__/Arcade.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { Arcade } from "../Arcade.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Arcade", () => {
  it("lists miniapps and calls onOpen when a card is clicked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ miniapps: [{ name: "auth-replay", title: "Auth Replay", genre: "replay", needs: ["live-session-events"] }] }),
    })) as unknown as typeof fetch);
    const onOpen = vi.fn();
    render(<Arcade apiBase="" onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText("Auth Replay")).toBeTruthy());
    expect(screen.getByText(/live/i)).toBeTruthy(); // permission chip
    fireEvent.click(screen.getByText("Auth Replay"));
    expect(onOpen).toHaveBeenCalledWith("auth-replay");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @agentgem/console test -- Arcade` → FAIL.

- [ ] **Step 3: Implement `Runner.tsx`**

```tsx
// packages/console/src/panels/Play/Runner.tsx
import { sandboxDoc } from "../Watch/sandboxDoc.js";

// The sealed miniapp player: null-origin iframe (no allow-same-origin), strict CSP via sandboxDoc.
export function Runner({ html, height = 520 }: { html: string; height?: number }) {
  return (
    <iframe
      title="miniapp preview"
      sandbox="allow-scripts"
      srcDoc={sandboxDoc(html)}
      style={{ width: "100%", height, border: "1px solid var(--border, #ccc)", borderRadius: 8, background: "#fff" }}
    />
  );
}
```

- [ ] **Step 4: Implement `Arcade.tsx`**

```tsx
// packages/console/src/panels/Play/Arcade.tsx
import { useEffect, useState } from "react";
import { makeClient } from "../../api/routes.js";
import { playMiniappsRoute } from "../../api/routes.js";

type Item = { name: string; title: string; genre: string; needs?: string[] };

// v1: chips are DISPLAY-ONLY. The consent gate + capability broker (live/local/invoke-agent) are the
// spec's Permissions Model and are deferred — no v1 genre declares `needs`.
const CHIP: Record<string, { label: string; title: string }> = {
  "live-session-events": { label: "🔴 live", title: "reads live sessions (host-brokered, read-only)" },
  "local-project-access": { label: "🟡 local", title: "reads local projects (host-brokered, read-only)" },
  "invoke-agent": { label: "⚙ agent", title: "runs a local agent (local-authored only)" },
};

export function Arcade({ apiBase, onOpen }: { apiBase: string; onOpen: (name: string) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => {
    playMiniappsRoute.call(makeClient(apiBase)).then((r) => setItems(r.miniapps)).catch(() => setItems([]));
  }, [apiBase]);

  if (!items) return <p className="ledger-view">Loading miniapps…</p>;
  if (items.length === 0) return <p className="ledger-empty">No miniapps yet — create one from a session, skill, or project.</p>;
  return (
    <ul className="analyze-list" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 12, listStyle: "none", padding: 0 }}>
      {items.map((m) => (
        <li key={m.name} className="analyze-row" style={{ cursor: "pointer", padding: 12, borderRadius: 8 }}
            onClick={() => onOpen(m.name)}>
          <div style={{ fontWeight: 600 }}>{m.title}</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>{m.genre}</div>
          <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(m.needs && m.needs.length ? m.needs : []).map((n) => (
              <span key={n} className="ws-chip" title={CHIP[n]?.title}>{CHIP[n]?.label ?? n}</span>
            ))}
            {(!m.needs || m.needs.length === 0) && <span className="ws-chip" title="fully offline snapshot">🟢 offline</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Run test to verify it passes** — `pnpm --filter @agentgem/console test -- Arcade` → PASS. Then `pnpm exec tsc -b` (CLEAN).

- [ ] **Step 6: Commit**
```bash
git add packages/console/src/panels/Play/Runner.tsx packages/console/src/panels/Play/Arcade.tsx packages/console/src/panels/Play/__tests__/Arcade.test.tsx
git commit -m "$(printf 'feat(console): Play Arcade grid + sealed Runner iframe\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: The Studio (`Studio.tsx`) — chat + live preview + save/publish

**Files:**
- Create: `packages/console/src/panels/Play/Studio.tsx`, `packages/console/src/panels/Play/studioStream.ts`
- Test: `packages/console/src/panels/Play/__tests__/Studio.test.tsx`

**Interfaces:**
- Consumes: `playMiniappRoute`/`playSaveRoute`/`playPublishRoute` (Task 2), `Runner` (Task 3), `sandboxDoc`.
- Produces: `openStudioStream(apiBase, chatId, message, handlers)` (a Watch-convention EventSource wrapper — threads `apiBase`, events delta/tool/done/failed); `Studio({ apiBase, name, onBack })`.

The Studio opens a chat targeting the miniapp (`POST /api/chat { agentId, miniapp: name }`), streams the agent's turns, and after each `done` re-fetches the miniapp HTML (`playMiniappRoute`) into the live `Runner`. Save = re-fetch HTML then `playSaveRoute` (gate + commit + dual-write). Publish = `playPublishRoute`.

- [ ] **Step 1: Write the failing test** (fake `fetch` for POST/GET + fake `EventSource` for the stream)

```tsx
// packages/console/src/panels/Play/__tests__/Studio.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Studio } from "../Studio.js";

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, cb: (e: unknown) => void) { (this.listeners[t] ??= []).push(cb); }
  close() {}
  emit(t: string, data: unknown) { for (const cb of this.listeners[t] ?? []) cb({ data: JSON.stringify(data) }); }
}
afterEach(() => { cleanup(); FakeES.last = null; vi.unstubAllGlobals(); });

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/api/agents")) return { ok: true, json: async () => ({ agents: [{ id: "claude", available: true }] }) };
    if (url.includes("/api/chat") && init?.method === "POST") return { ok: true, json: async () => ({ chatId: "c1" }) };
    if (url.includes("/api/play/miniapp")) return { ok: true, json: async () => ({ name: "g1", html: "<!doctype html><body><canvas data-v='2'></canvas></body>", meta: { title: "G1", genre: "replay" } }) };
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch);
  vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
}

describe("Studio", () => {
  it("sends a studio turn and refreshes the preview on done", async () => {
    stubFetch();
    render(<Studio apiBase="" name="g1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/g1/i)).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText(/build|edit|ask/i), { target: { value: "make it blue" } });
    fireEvent.click(screen.getByText(/send/i));
    await waitFor(() => expect(FakeES.last).toBeTruthy());
    expect(FakeES.last!.url).toContain("/api/chat/stream");
    FakeES.last!.emit("done", { result: { text: "done", toolCalls: [] } });
    // after done, the preview iframe re-fetches and shows the new html
    await waitFor(() => {
      const iframe = document.querySelector('iframe[title="miniapp preview"]') as HTMLIFrameElement;
      expect(iframe.getAttribute("srcdoc")).toContain("data-v='2'");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @agentgem/console test -- Studio` → FAIL.

- [ ] **Step 3: Implement `studioStream.ts`** (Watch convention — threads `apiBase`):

```ts
// packages/console/src/panels/Play/studioStream.ts
export interface StudioStreamHandlers {
  onDelta: (text: string) => void;
  onDone: (result: { text: string; toolCalls: unknown[] }) => void;
  onFailed: (error: string) => void;
}
export function openStudioStream(apiBase: string, chatId: string, message: string, h: StudioStreamHandlers): () => void {
  const params = new URLSearchParams({ chatId, message });
  const es = new EventSource(`${apiBase}/api/chat/stream?${params.toString()}`);
  es.addEventListener("delta", (e) => h.onDelta(JSON.parse((e as MessageEvent).data).text));
  es.addEventListener("done", (e) => { h.onDone(JSON.parse((e as MessageEvent).data).result); es.close(); });
  es.addEventListener("failed", (e) => { h.onFailed(JSON.parse((e as MessageEvent).data).error); es.close(); });
  es.addEventListener("error", () => { h.onFailed("connection lost"); es.close(); });
  return () => es.close();
}
```

- [ ] **Step 4: Implement `Studio.tsx`**

```tsx
// packages/console/src/panels/Play/Studio.tsx
import { useEffect, useRef, useState } from "react";
import { makeClient, playMiniappRoute, playSaveRoute, playPublishRoute } from "../../api/routes.js";
import { Runner } from "./Runner.js";
import { openStudioStream } from "./studioStream.js";

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };

export function Studio({ apiBase, name, onBack }: { apiBase: string; name: string; onBack: () => void }) {
  const [agentId, setAgentId] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [log, setLog] = useState<string>("");        // rolling agent output
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [html, setHtml] = useState<string>("");       // live preview source
  const [meta, setMeta] = useState<{ title: string; genre: string } | null>(null);
  const [status, setStatus] = useState<string>("");
  const closeRef = useRef<null | (() => void)>(null);

  const refresh = () =>
    playMiniappRoute.call(makeClient(apiBase), { query: { name } })
      .then((r) => { setHtml(r.html); setMeta(r.meta); }).catch(() => {});

  useEffect(() => {
    fetch(`${apiBase}/api/agents`).then(j).then((d: { agents: { id: string; available: boolean }[] }) => {
      setAgentId(d.agents.find((a) => a.available)?.id ?? d.agents[0]?.id ?? "");
    }).catch(() => {});
    refresh();
    return () => closeRef.current?.();
  }, [apiBase, name]);

  async function send() {
    if (!input.trim() || busy || !agentId) return;
    setBusy(true); setLog((l) => l + `\n\n> ${input}\n`);
    try {
      let id = chatId;
      if (!id) {
        const res = await fetch(`${apiBase}/api/chat`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId, miniapp: name }),  // ← studio mode (Plan 2b)
        }).then(j);
        id = res.chatId as string; setChatId(id);
      }
      const message = input; setInput("");
      closeRef.current = openStudioStream(apiBase, id, message, {
        onDelta: (t) => setLog((l) => l + t),
        onDone: async () => { setBusy(false); await refresh(); },  // ← live preview updates
        onFailed: (e) => { setBusy(false); setStatus(`error: ${e}`); },
      });
    } catch (e) { setBusy(false); setStatus(`error: ${(e as Error).message}`); }
  }

  async function save() {
    setStatus("saving…");
    try {
      const cur = await playMiniappRoute.call(makeClient(apiBase), { query: { name } });
      await playSaveRoute.call(makeClient(apiBase), { body: { name, html: cur.html, meta: {
        title: cur.meta.title, genre: cur.meta.genre as "replay" | "skill-run" | "project-fun",
        createdFrom: { kind: "project", path: "", flavor: "" }, engineVersion: "1",
        ...(cur.meta.needs ? { needs: cur.meta.needs } : {}),
      } } });
      setStatus("saved ✓");
    } catch (e) { setStatus(`save failed: ${(e as Error).message}`); }
  }

  async function publish() {
    setStatus("publishing…");
    try { await playPublishRoute.call(makeClient(apiBase), { body: {} }); setStatus("published ✓"); }
    catch (e) { setStatus(`publish failed: ${(e as Error).message}`); }
  }

  return (
    <section className="analyze">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <button className="ledger-search" style={{ width: "auto" }} onClick={onBack}>← arcade</button>
        <strong>{meta?.title ?? name}</strong>
        <span style={{ opacity: 0.6, fontSize: 12 }}>{meta?.genre}</span>
        <span style={{ flex: 1 }} />
        <button className="run-badge" onClick={save}>Save</button>
        <button className="run-badge" onClick={publish}>Publish</button>
        {status && <span className="run-status" style={{ marginLeft: 8 }}>{status}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <Runner html={html} height={420} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <pre className="ledger-view" style={{ height: 360, overflow: "auto", whiteSpace: "pre-wrap", margin: 0 }}>{log || "Ask the agent to build or change the miniapp…"}</pre>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="ledger-search" style={{ flex: 1, marginBottom: 0 }} placeholder="ask the agent to build/edit…"
              value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
            <button className="run-badge run-running" disabled={busy} onClick={send}>{busy ? "…" : "Send"}</button>
          </div>
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Run test to verify it passes** — `pnpm --filter @agentgem/console test -- Studio` → PASS. Then `pnpm exec tsc -b` (CLEAN).

- [ ] **Step 6: Commit**
```bash
git add packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/studioStream.ts packages/console/src/panels/Play/__tests__/Studio.test.tsx
git commit -m "$(printf 'feat(console): Play Studio — chat + live preview + save/publish\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: Composer + Play page + registration (`Composer.tsx`, `index.tsx`)

**Files:**
- Create: `packages/console/src/panels/Play/Composer.tsx`, `packages/console/src/panels/Play/index.tsx`
- Modify: `packages/console/src/pages.tsx` (register `playPage`)
- Test: `packages/console/src/panels/Play/__tests__/Composer.test.tsx`

**Interfaces:**
- Produces: `Composer({ apiBase, onCreated })` — pick a project (reuse `testbedProjectsRoute`) → `playStudioRoute` → `onCreated(name)`; `Play({ apiBase })` — the page shell (arcade ⇄ composer ⇄ studio views); `playPage = defineConsolePage({ id:"play", phase:"build", category:"setup", … })`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/panels/Play/__tests__/Composer.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../Composer.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Composer", () => {
  it("lists projects and creates a studio miniapp on pick", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/testbed/projects")) return { ok: true, json: async () => ({ projects: [{ path: "/p/demo", flavor: "node", lastUsed: null, exists: true }] }) };
      if (url.includes("/api/play/studio") && init?.method === "POST") return { ok: true, json: async () => ({ name: "demo" }) };
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch);
    const onCreated = vi.fn();
    render(<Composer apiBase="" onCreated={onCreated} />);
    await waitFor(() => expect(screen.getByText("/p/demo")).toBeTruthy());
    fireEvent.click(screen.getByText("/p/demo"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("demo"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @agentgem/console test -- Composer` → FAIL.

- [ ] **Step 3: Implement `Composer.tsx`** (project source in v1; session/skill sources are additive later — the backend already accepts all three)

```tsx
// packages/console/src/panels/Play/Composer.tsx
import { useEffect, useState } from "react";
import { makeClient, playStudioRoute } from "../../api/routes.js";
import { testbedProjectsRoute } from "../../api/routes.js";

type Proj = { path: string; flavor: string; exists: boolean };

export function Composer({ apiBase, onCreated }: { apiBase: string; onCreated: (name: string) => void }) {
  const [projects, setProjects] = useState<Proj[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    testbedProjectsRoute.call(makeClient(apiBase)).then((r) => setProjects(r.projects)).catch(() => setProjects([]));
  }, [apiBase]);

  async function pick(p: Proj) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const res = await playStudioRoute.call(makeClient(apiBase), { body: { source: { kind: "project", path: p.path, flavor: p.flavor } } });
      onCreated(res.name);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <section className="analyze">
      <p className="analyze-intro">Create a miniapp from a project — the agent seeds it and opens the studio.</p>
      {error && <p className="ledger-error">{error}</p>}
      {!projects ? <p className="ledger-view">Loading projects…</p> :
        <ul className="analyze-list">
          {projects.map((p) => (
            <li key={p.path} className="analyze-row" style={{ cursor: "pointer" }} onClick={() => pick(p)}>
              <span>{p.path}</span> <span style={{ opacity: 0.6, fontSize: 12 }}>{p.flavor}</span>
            </li>
          ))}
        </ul>}
      {busy && <p className="run-status">Seeding studio…</p>}
    </section>
  );
}
```

- [ ] **Step 4: Implement `index.tsx` + register**

```tsx
// packages/console/src/panels/Play/index.tsx
import { useState } from "react";
import { defineConsolePage } from "../../contract.js";
import { Arcade } from "./Arcade.js";
import { Composer } from "./Composer.js";
import { Studio } from "./Studio.js";

type View = { kind: "arcade" } | { kind: "composer" } | { kind: "studio"; name: string };

export function Play({ apiBase }: { apiBase: string }) {
  const [view, setView] = useState<View>({ kind: "arcade" });
  return (
    <section className="analyze">
      {view.kind !== "studio" && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button className={`ledger-search${view.kind === "arcade" ? " is-active" : ""}`} style={{ width: "auto", marginBottom: 0 }} onClick={() => setView({ kind: "arcade" })}>Arcade</button>
          <button className={`ledger-search${view.kind === "composer" ? " is-active" : ""}`} style={{ width: "auto", marginBottom: 0 }} onClick={() => setView({ kind: "composer" })}>+ New miniapp</button>
        </div>
      )}
      {view.kind === "arcade" && <Arcade apiBase={apiBase} onOpen={(name) => setView({ kind: "studio", name })} />}
      {view.kind === "composer" && <Composer apiBase={apiBase} onCreated={(name) => setView({ kind: "studio", name })} />}
      {view.kind === "studio" && <Studio apiBase={apiBase} name={view.name} onBack={() => setView({ kind: "arcade" })} />}
    </section>
  );
}

export const playPage = defineConsolePage({
  id: "play", title: "Play", icon: "🎮", order: 30,
  phase: "build", category: "setup",
  route: "#/play",
  component: ({ apiBase }) => <Play apiBase={apiBase} />,
});
```

Register in `packages/console/src/pages.tsx`: add `import { playPage } from "./panels/Play/index.js";` and add `playPage` to the `pages` array.

- [ ] **Step 5: Run tests** — `pnpm --filter @agentgem/console test -- Composer` → PASS; then `pnpm --filter @agentgem/console test` (all console tests) → green; then `pnpm exec tsc -b` (CLEAN — the page registers without an `assertPlacement` throw).

- [ ] **Step 6: Commit**
```bash
git add packages/console/src/panels/Play/Composer.tsx packages/console/src/panels/Play/index.tsx packages/console/src/pages.tsx packages/console/src/panels/Play/__tests__/Composer.test.tsx
git commit -m "$(printf 'feat(console): Play page — Composer + Arcade/Studio shell, registered in the build phase\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: Full build + suites green; manual smoke

- [ ] **Step 1: Root suite + build** — `pnpm test` (backend + `tsc -b` builds the console). PASS bar the possibly-flaky `consoleMount` when the console SPA isn't built (CI builds it first).
- [ ] **Step 2: Console suite** — `pnpm --filter @agentgem/console test`. All Play panel tests + existing console tests green.
- [ ] **Step 3: Confirm registration** — `grep -n "playPage" packages/console/src/pages.tsx` present; `grep -n "play" packages/console/src/api/routes.ts` shows the five routes.
- [ ] **Step 4: Commit any fixes**
```bash
git add -A && git commit -m "$(printf 'test(console): Play panel + backend green end to end\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Deferred (a future Plan 3b, explicitly out of scope)

- **The consent gate + capability broker runtime** (live-session-events / local-project-access / invoke-agent) — the spec's Permissions Model. v1 chips are display-only; no genre declares `needs`, so the broker is dormant. When a live genre ships, add the `postMessage` broker + per-gem consent per the spec.
- **Session/skill source pickers** in the Composer (backend already accepts all three `GameSource` kinds; v1 UI ships the project picker).
- **Double-buffered preview** (Watch/Dashboard pattern) if the single-iframe refresh flashes in practice.

## Self-Review

- **Spec coverage:** Arcade (grid + play) ✓; Composer (source → seed studio) ✓; Studio (chat targeting the miniapp + live preview + Save/Publish) ✓; sealed Runner reusing `sandboxDoc` ✓; permission chips (display-only, per constraint) ✓; the missing single-miniapp-HTML endpoint added (T1) ✓; typed client routes (T2) ✓; page registered in the build phase (T5) ✓. Consent/broker runtime explicitly deferred.
- **Placeholder scan:** T2 carries a `grep`-and-confirm for the `defineRoute`/`z` import style; the `Studio.save()` `createdFrom` uses a placeholder `{ path:"", flavor:"" }` because the console doesn't hold the original source — that is intentional (the gem's provenance was set at seed time; save only needs a valid-shaped meta to pass the schema), and it is called out here so a reviewer doesn't mistake it for an oversight. If provenance-on-resave matters, T1's `GET /api/play/miniapp` can be extended to return `createdFrom` and `save` can echo it — noted as a follow-up, not built.
- **Type consistency:** route names (`playMiniappsRoute`/`playMiniappRoute`/`playStudioRoute`/`playSaveRoute`/`playPublishRoute`) consistent across T2–T5; `Studio`/`Arcade`/`Composer`/`Runner` props match their call sites in `index.tsx`; `openStudioStream(apiBase, chatId, message, handlers)` threads `apiBase` (the corrected Watch convention).
- **Security:** every preview renders through `sandboxDoc` in a null-origin `allow-scripts` iframe; no `allow-same-origin`; the studio chat uses the Plan-2b validated `miniapp` field (server-side cwd gate), not a client path.
