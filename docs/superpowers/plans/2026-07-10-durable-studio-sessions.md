# Durable, Backgroundable Studio Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an in-progress Studio ACP session survive leaving the panel / reloading the tab: the turn keeps running in the background, and on return the thread re-renders from the durable on-disk transcript, with a Stop control to kill a wedged session.

**Architecture:** The ACP session already lives server-side in `ChatManager` and the adapter already writes a full transcript to disk keyed by its `sessionId`. We surface that `sessionId`, persist `{chatId, sessionId, agent}` in the browser (localStorage, keyed by miniapp name), add a liveness endpoint + a concurrency guard so a background turn is safe and reapable-only-when-idle, and restore history on mount via the existing `GET /api/inspect/session` route. No new turn engine, no live token re-attach (deferred).

**Tech Stack:** TypeScript (ESM), Node.js ≥24, `node:sqlite`-era monorepo (`packages/*` + root `src/`), Vitest, React 18 + `useSyncExternalStore`, agentback typed routes (`defineRoute`), Express-duck-typed SSE handlers.

## Global Constraints

- **Scope: Studio only.** The neutral Chat panel is an explicit fast-follow; do not modify `packages/console/src/panels/Chat/*` in this plan.
- **No new deps.** Reuse `useSyncExternalStore`, `localStorage`, existing routes (`inspectSessionRoute`), and the `try{localStorage}catch{}` idiom from `consent.ts`.
- **Dead-session continue is "fresh".** When the in-memory session is gone, render history read-only and let the next message open a new ACP session. No ACP `session/load`.
- **CI gate is the root `test (24)` job** (root `src/**/__tests__`). `packages/console` and `packages/*` tests are NOT in CI — run them locally with `pnpm -C packages/console exec vitest run` etc.
- **Persistence key format:** `agentgem:play:studiochat:<miniapp-name>` (mirrors `consent.ts`'s `agentgem:play:consent:...`).
- **Brief-injection marker:** the first turn's prompt is `` `${brief}\n\n---\nUser: ${message}` `` (`chatSession.ts:122`). The stable strip marker is the literal `\n---\nUser: `.

---

## File Structure

**Server (root `src/` + packages, all in CI):**
- `packages/base/src/acpSession.ts` — add `sessionId` to `RawAcpSession` (value already exists at line 138).
- `packages/run/src/chatSession.ts` — add `sessionId` to `ChatSessionHandle` + `LiveChat`; add `running` flag, concurrency guard, sweep/evict protection, and `stateOf()`.
- `src/goldmine/chatRoutes.ts` — `makeChatConnectFn` sets `sessionId` on the handle; `POST /api/chat` returns `{chatId, sessionId, agent}`; new `GET /api/chat/:chatId/state`.

**Client (`packages/console`, local tests only):**
- `packages/console/src/panels/Play/studioChatStore.ts` — **new**: localStorage-backed per-miniapp `{chatId, sessionId, agent}` store + hook.
- `packages/console/src/panels/Play/studioResume.ts` — **new**: `transcriptToMsgs()` mapper + `loadStudioSession()` orchestration.
- `packages/console/src/panels/Play/Studio.tsx` — persist on open, reconcile on mount, poll while running, Stop button.

---

## Task 1: Surface the ACP `sessionId` through the session stack

**Files:**
- Modify: `packages/base/src/acpSession.ts:69-73` (interface) and `:139-154` (returned object)
- Modify: `packages/run/src/chatSession.ts:23-31` (`ChatSessionHandle`), `:42-49` (`LiveChat`), `:101-110` (`openChat`)
- Modify: `src/goldmine/chatRoutes.ts:274-287` (`makeChatConnectFn`)
- Test: `src/gem/__tests__/chatSession.test.ts`

**Interfaces:**
- Produces: `RawAcpSession.sessionId: string`; `ChatSessionHandle.sessionId: string`; `ChatManager.stateOf(chatId: string): { alive: true; running: boolean; sessionId: string; agent: string } | { alive: false }`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test** — append to `src/gem/__tests__/chatSession.test.ts` (inside the `describe("ChatManager", ...)` block). Note the fake handle now returns a `sessionId`.

```ts
it("exposes sessionId + agent via stateOf for a live chat", async () => {
  const connect = async () => ({ ctx: { open: async () => ({
    sessionId: "sess_abc",
    setMode: async () => {},
    prompt: async () => ({ text: "", toolCalls: [] }),
    dispose: () => {},
  }) }, close: () => {} });
  const mgr = new ChatManager({ connectFn: connect as any });
  const id = await mgr.openChat({ agentId: "claude-code", brief: "B" });
  expect(mgr.stateOf(id)).toEqual({ alive: true, running: false, sessionId: "sess_abc", agent: "claude-code" });
  expect(mgr.stateOf("nope")).toEqual({ alive: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions exec vitest run src/gem/__tests__/chatSession.test.ts -t "stateOf"`
Expected: FAIL — `mgr.stateOf is not a function`.

- [ ] **Step 3a: Add `sessionId` to `RawAcpSession`** — `packages/base/src/acpSession.ts`, interface at line 69:

```ts
export interface RawAcpSession {
  sessionId: string;
  setMode(mode: string): Promise<void>;
  prompt(text: string, onUpdate: (update: unknown) => void): Promise<void>;
  dispose(): void;
}
```

And include it in the returned object (the `sessionId` const already exists at line 138) — change the `return {` at line 139 to lead with it:

```ts
      return {
        sessionId,
        async setMode(mode: string) {
```

- [ ] **Step 3b: Add `sessionId` to `ChatSessionHandle` + `LiveChat`, set it in `openChat`, add `stateOf`** — `packages/run/src/chatSession.ts`.

`ChatSessionHandle` (line 23):
```ts
export interface ChatSessionHandle {
  sessionId: string;
  setMode(m: string): Promise<void>;
  prompt(
    text: string,
    onDelta?: (c: string) => void,
    onToolCall?: (t: ToolInvocation) => void,
  ): Promise<RunResult>;
  dispose(): void;
}
```

`LiveChat` (line 42) — add `sessionId`:
```ts
interface LiveChat {
  agentId: string;
  sessionId: string;
  brief: string | null;
  conn: { ctx: ChatCtx; close: () => void };
  handle: ChatSessionHandle;
  lastMs: number;
}
```

In `openChat`, set it when building the `LiveChat` (line 102):
```ts
    this.live.set(chatId, {
      agentId: input.agentId,
      sessionId: handle.sessionId,
      brief: input.brief,
      conn,
      handle,
      lastMs: this.now(),
    });
```

Add a `stateOf` method (place it just after `closeChat`, ~line 165):
```ts
  /** Liveness + identity for a chat, for client reconciliation after navigation/reload. */
  stateOf(chatId: string): { alive: true; running: boolean; sessionId: string; agent: string } | { alive: false } {
    const c = this.live.get(chatId);
    if (!c) return { alive: false };
    return { alive: true, running: c.running ?? false, sessionId: c.sessionId, agent: c.agentId };
  }
```

(`c.running` is added in Task 2; `?? false` keeps this task self-contained and green.)

- [ ] **Step 3c: Set `sessionId` on the real handle** — `src/goldmine/chatRoutes.ts`, in `makeChatConnectFn`'s returned `ChatSessionHandle` (line 276):

```ts
        const session = await raw.open(cwd, { mcpServers: openOpts?.mcpServers as never });
        return {
          sessionId: session.sessionId,
          setMode: (m: string) => session.setMode(m),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions exec vitest run src/gem/__tests__/chatSession.test.ts`
Expected: PASS (all existing tests + the new one).

- [ ] **Step 5: Typecheck (a required field was added to two interfaces)**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions build` (or the repo's typecheck)
Expected: no errors. If `makeChatConnectFn` or `acpSession` open() report a missing `sessionId`, you missed Step 3a/3c.

- [ ] **Step 6: Commit**

```bash
git add packages/base/src/acpSession.ts packages/run/src/chatSession.ts src/goldmine/chatRoutes.ts src/gem/__tests__/chatSession.test.ts
git commit -m "feat(chat): surface ACP sessionId + ChatManager.stateOf"
```

---

## Task 2: `running` flag — concurrency guard + protect background turns from reaping

**Files:**
- Modify: `packages/run/src/chatSession.ts` — `LiveChat` (add `running`), `sendMessage` (guard + set/clear), `sweepIdle`, `evictLru`, `openChat` (cap error)
- Test: `src/gem/__tests__/chatSession.test.ts`

**Interfaces:**
- Produces: `LiveChat.running: boolean`; `sendMessage` rejects a concurrent turn with a `failed` event; `sweepIdle`/`evictLru` skip running chats; `openChat` throws `"too many active sessions; stop one to start another"` when at cap and all live chats are running.
- Consumes: `LiveChat` from Task 1.

- [ ] **Step 1: Write the failing tests** — append to `src/gem/__tests__/chatSession.test.ts`:

```ts
it("rejects a second concurrent turn while one is running", async () => {
  // prompt() blocks until we release it, so the first turn stays 'running'.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const connect = async () => ({ ctx: { open: async () => ({
    sessionId: "s", setMode: async () => {},
    prompt: async () => { await gate; return { text: "ok", toolCalls: [] }; },
    dispose: () => {},
  }) }, close: () => {} });
  const mgr = new ChatManager({ connectFn: connect as any });
  const id = await mgr.openChat({ agentId: "claude-code", brief: "B" });

  const first = (async () => { const e: any[] = []; for await (const x of mgr.sendMessage(id, "a")) e.push(x); return e; })();
  await new Promise((r) => setTimeout(r, 0)); // let the first turn start + set running
  expect(mgr.stateOf(id)).toMatchObject({ running: true });

  const second: any[] = []; for await (const x of mgr.sendMessage(id, "b")) second.push(x);
  expect(second.at(-1)).toMatchObject({ type: "failed", error: expect.stringContaining("already") });

  release(); await first;
  expect(mgr.stateOf(id)).toMatchObject({ running: false }); // cleared in finally
});

it("sweepIdle does NOT tear down a chat with a running turn", async () => {
  let t = 1000; let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const connect = async () => ({ ctx: { open: async () => ({
    sessionId: "s", setMode: async () => {},
    prompt: async () => { await gate; return { text: "", toolCalls: [] }; },
    dispose: () => {},
  }) }, close: () => {} });
  const mgr = new ChatManager({ connectFn: connect as any, now: () => t, idleMs: 100 });
  const id = await mgr.openChat({ agentId: "claude-code", brief: "B" });
  const running = (async () => { for await (const _ of mgr.sendMessage(id, "x")) { /* drain */ } })();
  await new Promise((r) => setTimeout(r, 0));
  t = 5000; mgr.sweepIdle();
  expect(mgr.stateOf(id)).toMatchObject({ alive: true }); // NOT swept while running
  release(); await running;
});

it("openChat throws when at cap and every live chat is running", async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const connect = async () => ({ ctx: { open: async () => ({
    sessionId: "s", setMode: async () => {},
    prompt: async () => { await gate; return { text: "", toolCalls: [] }; },
    dispose: () => {},
  }) }, close: () => {} });
  const mgr = new ChatManager({ connectFn: connect as any, maxLive: 1 });
  const a = await mgr.openChat({ agentId: "claude-code", brief: "B" });
  const running = (async () => { for await (const _ of mgr.sendMessage(a, "x")) { /* drain */ } })();
  await new Promise((r) => setTimeout(r, 0));
  await expect(mgr.openChat({ agentId: "claude-code", brief: "B" })).rejects.toThrow(/too many active sessions/);
  release(); await running;
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions exec vitest run src/gem/__tests__/chatSession.test.ts -t "running|too many|running turn"`
Expected: FAIL — no guard yet (second turn runs instead of failing; sweep evicts; openChat evicts instead of throwing).

- [ ] **Step 3a: Add `running` to `LiveChat` init** — `packages/run/src/chatSession.ts`, in `openChat`'s `this.live.set` (from Task 1), add `running: false,`:

```ts
    this.live.set(chatId, {
      agentId: input.agentId,
      sessionId: handle.sessionId,
      running: false,
      brief: input.brief,
      conn,
      handle,
      lastMs: this.now(),
    });
```

And the `LiveChat` interface gains `running: boolean;`. Update `stateOf` from Task 1 to read `c.running` directly (drop the `?? false`).

- [ ] **Step 3b: Guard + set/clear in `sendMessage`** — wrap the body. After the `if (!chat)` block (line 114-117), insert the guard; then set `running` and wrap the rest in `try/finally`:

```ts
  async *sendMessage(chatId: string, message: string): AsyncGenerator<ChatEvent> {
    const chat = this.live.get(chatId);
    if (!chat) {
      yield { type: "failed", error: `unknown chat ${chatId}` };
      return;
    }
    if (chat.running) {
      yield { type: "failed", error: "a turn is already running for this chat" };
      return;
    }
    chat.running = true;
    try {
      chat.lastMs = this.now();
      // ... existing body verbatim, from "const prompt = chat.brief ? ..." through the final
      //     "chat.lastMs = this.now(); yield { type: "done", result: result! };" ...
    } finally {
      chat.running = false;
    }
  }
```

Keep the existing `if (error) { yield failed; return; }` — `return` inside `try` still runs `finally`, so `running` clears on the failed path too.

- [ ] **Step 3c: Skip running chats in `sweepIdle`** — line 167:

```ts
  sweepIdle(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, c] of this.live) {
      if (!c.running && c.lastMs < cutoff) this.closeChat(id);
    }
  }
```

- [ ] **Step 3d: `evictLru` returns whether it evicted + skips running; `openChat` errors at cap** — line 174:

```ts
  private evictLru(): boolean {
    let oldest: string | null = null;
    let oldestMs = Infinity;
    for (const [id, c] of this.live) {
      if (c.running) continue;               // never evict an in-flight background turn
      if (c.lastMs < oldestMs) { oldestMs = c.lastMs; oldest = id; }
    }
    if (oldest) { this.closeChat(oldest); return true; }
    return false;
  }
```

`openChat` eviction loop (line 82):
```ts
    while (this.live.size >= this.maxLive) {
      if (!this.evictLru()) throw new Error("too many active sessions; stop one to start another");
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions exec vitest run src/gem/__tests__/chatSession.test.ts`
Expected: PASS (existing + all Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/run/src/chatSession.ts src/gem/__tests__/chatSession.test.ts
git commit -m "feat(chat): track running turns — concurrency guard + reap protection"
```

---

## Task 3: Routes — `POST /api/chat` returns sessionId, new `GET /api/chat/:chatId/state`

**Files:**
- Modify: `src/goldmine/chatRoutes.ts` — `App` interface (add nothing; `get` exists), `POST /api/chat` handler (line 156-176), add the `state` route
- Test: `src/goldmine/__tests__/chatRoutes.test.ts`

**Interfaces:**
- Produces: `POST /api/chat` → `{ chatId: string; sessionId: string; agent: string }`; `GET /api/chat/:chatId/state` → the `stateOf` shape.
- Consumes: `ChatManager.stateOf` (Task 1/2).

- [ ] **Step 1: Read the existing test harness** — open `src/goldmine/__tests__/chatRoutes.test.ts` and note how it builds a fake Express `app` + `deps` (it drives routes without real Express). Reuse that harness. Ensure its inline handle fake gains `sessionId: "sess_test"` so `stateOf` returns a real id.

- [ ] **Step 2: Write the failing tests** — add to `src/goldmine/__tests__/chatRoutes.test.ts`:

```ts
it("POST /api/chat returns chatId, sessionId, and agent", async () => {
  const { app, calls } = makeApp(); // existing harness helper; adjust name to match the file
  registerChatRoutes(app, deps);
  const res = await calls.post("/api/chat", { body: { agentId: "claude-code", miniapp: "demo" } });
  expect(res.json).toMatchObject({ chatId: expect.any(String), sessionId: "sess_test", agent: "claude-code" });
});

it("GET /api/chat/:chatId/state reports liveness", async () => {
  const { app, calls } = makeApp();
  registerChatRoutes(app, deps);
  const opened = await calls.post("/api/chat", { body: { agentId: "claude-code", miniapp: "demo" } });
  const live = await calls.get(`/api/chat/${opened.json.chatId}/state`, {});
  expect(live.json).toMatchObject({ alive: true, running: false, sessionId: "sess_test", agent: "claude-code" });
  const dead = await calls.get("/api/chat/chat_missing/state", {});
  expect(dead.json).toEqual({ alive: false });
});
```

> If the existing test file's harness differs (helper names, how `deps.manager` is constructed), mirror it exactly — do not invent a new harness. The two assertions above are the contract; adapt only the plumbing.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions exec vitest run src/goldmine/__tests__/chatRoutes.test.ts -t "state|sessionId"`
Expected: FAIL — POST returns only `{chatId}`; no `/state` route.

- [ ] **Step 4a: Enrich the POST response** — `src/goldmine/chatRoutes.ts`, in the `POST /api/chat` handler, replace the success `res.json` (line 166):

```ts
      const chatId = await deps.manager.openChat(args);
      const miniapp = req.body?.miniapp ? String(req.body.miniapp) : "";
      if (miniapp) chatMiniapps.set(chatId, miniapp);
      const st = deps.manager.stateOf(chatId);
      res.json({ chatId, sessionId: st.alive ? st.sessionId : "", agent: args.agentId });
```

- [ ] **Step 4b: Add the state route** — after the `DELETE /api/chat/:chatId` route (line 252), add:

```ts
  // GET /api/chat/:chatId/state — liveness for client reconciliation after navigation/reload.
  // { alive:false } if the session was swept/evicted or the core restarted.
  app.get("/api/chat/:chatId/state", guard, (req, res) => {
    res.json(deps.manager.stateOf(req.params.chatId));
  });
```

(`app.get` is already in the `App` interface. Route order is fine: `/api/chat/:chatId/state` cannot collide with `/api/chat/stream`, which has no `/state` suffix.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions exec vitest run src/goldmine/__tests__/chatRoutes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/goldmine/chatRoutes.ts src/goldmine/__tests__/chatRoutes.test.ts
git commit -m "feat(chat): POST returns sessionId + GET /api/chat/:id/state"
```

---

## Task 4: Client store — `studioChatStore.ts`

**Files:**
- Create: `packages/console/src/panels/Play/studioChatStore.ts`
- Test: `packages/console/src/panels/Play/__tests__/studioChatStore.test.ts`

**Interfaces:**
- Produces:
  - `type StudioChat = { chatId: string; sessionId: string; agent: string }`
  - `getStudioChat(name: string): StudioChat | null`
  - `setStudioChat(name: string, v: StudioChat): void`
  - `clearChatId(name: string): void` — drops `chatId` (session dead) but keeps `sessionId`/`agent` so history still renders.
  - `clearStudioChat(name: string): void` — removes the entry entirely.
  - `useStudioChat(name: string): StudioChat | null` — `useSyncExternalStore` hook.

- [ ] **Step 1: Write the failing test** — `packages/console/src/panels/Play/__tests__/studioChatStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getStudioChat, setStudioChat, clearChatId, clearStudioChat } from "../studioChatStore.js";

describe("studioChatStore", () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

  it("round-trips a studio chat keyed by miniapp name", () => {
    expect(getStudioChat("demo")).toBeNull();
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "claude-code" });
    expect(getStudioChat("demo")).toEqual({ chatId: "chat_1", sessionId: "sess_1", agent: "claude-code" });
    expect(getStudioChat("other")).toBeNull(); // per-name isolation
  });

  it("clearChatId drops chatId but keeps sessionId for history", () => {
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "claude-code" });
    clearChatId("demo");
    expect(getStudioChat("demo")).toEqual({ chatId: "", sessionId: "sess_1", agent: "claude-code" });
  });

  it("clearStudioChat removes the entry", () => {
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "claude-code" });
    clearStudioChat("demo");
    expect(getStudioChat("demo")).toBeNull();
  });

  it("survives corrupt JSON without throwing", () => {
    localStorage.setItem("agentgem:play:studiochat:demo", "{not json");
    expect(getStudioChat("demo")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem/packages/console exec vitest run src/panels/Play/__tests__/studioChatStore.test.ts`
(Use the worktree path: `.../agentgem-durable-sessions/packages/console`.)
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store** — `packages/console/src/panels/Play/studioChatStore.ts`:

```ts
// packages/console/src/panels/Play/studioChatStore.ts
// Per-miniapp durable pointer to its ACP session, so a Studio chat survives panel
// navigation and full reloads. Mirrors consent.ts's try/localStorage/catch idiom and
// activeGem.ts's module-store + useSyncExternalStore pattern.
import { useSyncExternalStore } from "react";

export type StudioChat = { chatId: string; sessionId: string; agent: string };

const key = (name: string) => `agentgem:play:studiochat:${name}`;
const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }

export function getStudioChat(name: string): StudioChat | null {
  try {
    const raw = localStorage.getItem(key(name));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StudioChat>;
    if (typeof v?.sessionId !== "string" || typeof v?.agent !== "string") return null;
    return { chatId: typeof v.chatId === "string" ? v.chatId : "", sessionId: v.sessionId, agent: v.agent };
  } catch { return null; }
}

export function setStudioChat(name: string, v: StudioChat): void {
  try { localStorage.setItem(key(name), JSON.stringify(v)); } catch { /* private mode */ }
  emit();
}

export function clearChatId(name: string): void {
  const cur = getStudioChat(name);
  if (cur) setStudioChat(name, { ...cur, chatId: "" });
}

export function clearStudioChat(name: string): void {
  try { localStorage.removeItem(key(name)); } catch { /* private mode */ }
  emit();
}

export function useStudioChat(name: string): StudioChat | null {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => getStudioChat(name),
    () => null,
  );
}
```

> Note: `useSyncExternalStore`'s snapshot must be referentially stable when unchanged, but here the consuming component reads it once on mount and otherwise drives state itself, so a fresh object per call is acceptable (the hook is used only for cross-tab/`emit` nudges, not in a render-hot path). If a lint/`useSyncExternalStore` warning appears, memoize by caching the last `{raw → parsed}` pair.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions/packages/console exec vitest run src/panels/Play/__tests__/studioChatStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/studioChatStore.ts packages/console/src/panels/Play/__tests__/studioChatStore.test.ts
git commit -m "feat(studio): localStorage-backed per-miniapp chat session store"
```

---

## Task 5: Transcript → `Msg[]` mapper (with brief-strip)

**Files:**
- Modify: `packages/console/src/panels/Play/studioResume.ts` (create in this task; `loadStudioSession` added in Task 6)
- Test: `packages/console/src/panels/Play/__tests__/studioResume.test.ts`

**Interfaces:**
- Produces: `type StudioMsg = { role: "user" | "agent"; text: string } | { role: "tool"; title: string; failed?: boolean }` and `transcriptToMsgs(turns: TranscriptTurn[]): StudioMsg[]`.
- Consumes: `TranscriptTurn`/`TranscriptSpan` from `../../api/routes.js`.

- [ ] **Step 1: Write the failing test** — `packages/console/src/panels/Play/__tests__/studioResume.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { transcriptToMsgs } from "../studioResume.js";
import type { TranscriptTurn } from "../../../api/routes.js";

const turn = (t: Partial<TranscriptTurn> & { spans: TranscriptTurn["spans"] }): TranscriptTurn =>
  ({ id: "x", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, ...t });

describe("transcriptToMsgs", () => {
  it("maps message + tool_call spans into studio msgs", () => {
    const turns: TranscriptTurn[] = [
      turn({ role: "user", spans: [{ kind: "message", role: "user", text: "make it blue" }] }),
      turn({ role: "assistant", spans: [
        { kind: "tool_call", name: "Edit", input: "{}", output: "ok" },
        { kind: "message", role: "assistant", text: "done" },
      ] }),
    ];
    expect(transcriptToMsgs(turns)).toEqual([
      { role: "user", text: "make it blue" },
      { role: "tool", title: "Edit", failed: false },
      { role: "agent", text: "done" },
    ]);
  });

  it("strips the injected brief from the first user message", () => {
    const turns: TranscriptTurn[] = [
      turn({ role: "user", spans: [{ kind: "message", role: "user", text: "SYSTEM BRIEF TEXT\n\n---\nUser: build a timer" }] }),
    ];
    expect(transcriptToMsgs(turns)).toEqual([{ role: "user", text: "build a timer" }]);
  });

  it("marks failed tool calls", () => {
    const turns: TranscriptTurn[] = [
      turn({ role: "assistant", spans: [{ kind: "tool_call", name: "Bash", input: "x", error: true }] }),
    ];
    expect(transcriptToMsgs(turns)).toEqual([{ role: "tool", title: "Bash", failed: true }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions/packages/console exec vitest run src/panels/Play/__tests__/studioResume.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the mapper** — `packages/console/src/panels/Play/studioResume.ts`:

```ts
// packages/console/src/panels/Play/studioResume.ts
// Restore a Studio chat from its durable on-disk transcript (via /api/inspect/session).
import type { TranscriptTurn } from "../../api/routes.js";

export type StudioMsg =
  | { role: "user" | "agent"; text: string }
  | { role: "tool"; title: string; failed?: boolean };

// The first turn's prompt is `${brief}\n\n---\nUser: ${message}` (chatSession.ts). Strip
// everything up to and including the first marker so the user sees their message, not the brief.
const BRIEF_MARK = "\n---\nUser: ";
function stripBrief(text: string): string {
  const i = text.indexOf(BRIEF_MARK);
  return i === -1 ? text : text.slice(i + BRIEF_MARK.length);
}

export function transcriptToMsgs(turns: TranscriptTurn[]): StudioMsg[] {
  const out: StudioMsg[] = [];
  let firstUserSeen = false;
  for (const t of turns) {
    for (const s of t.spans) {
      if (s.kind === "message") {
        if (s.role === "user") {
          const text = !firstUserSeen ? stripBrief(s.text) : s.text;
          firstUserSeen = true;
          out.push({ role: "user", text });
        } else {
          out.push({ role: "agent", text: s.text });
        }
      } else {
        out.push({ role: "tool", title: s.name, failed: s.error === true });
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions/packages/console exec vitest run src/panels/Play/__tests__/studioResume.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/studioResume.ts packages/console/src/panels/Play/__tests__/studioResume.test.ts
git commit -m "feat(studio): transcript→msgs mapper with brief-strip"
```

---

## Task 6: `loadStudioSession()` orchestration

**Files:**
- Modify: `packages/console/src/panels/Play/studioResume.ts` (add the loader)
- Test: `packages/console/src/panels/Play/__tests__/studioResume.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type StudioResume = { msgs: StudioMsg[]; chatId: string | null; sessionId: string | null; running: boolean };
  loadStudioSession(apiBase: string, name: string): Promise<StudioResume>
  ```
  - No stored session → `{ msgs: [], chatId: null, sessionId: null, running: false }`.
  - History fetch 404/error → `msgs: []` (do not throw).
  - `state.alive === false` → `chatId: null` (fresh continue) but `sessionId` + `msgs` still returned; also `clearChatId(name)`.
  - `state.alive && state.running` → `chatId` set, `running: true`.
- Consumes: `getStudioChat`/`clearChatId` (Task 4), `transcriptToMsgs` (Task 5), `inspectSessionRoute` + `makeClient` (`../../api/routes.js`).

- [ ] **Step 1: Write the failing test** — add to `studioResume.test.ts`. Stub `fetch` (for `/state`) and `inspectSessionRoute` via `makeClient`'s underlying fetch. Simplest: mock global `fetch` to route by URL.

```ts
import { beforeEach, vi } from "vitest";
import { loadStudioSession } from "../studioResume.js";
import { setStudioChat, getStudioChat } from "../studioChatStore.js";

function mockFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url, "http://x").pathname;
    const hit = Object.entries(routes).find(([p]) => path.endsWith(p) || path.includes(p));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => hit[1] } as any;
  });
}

describe("loadStudioSession", () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } vi.restoreAllMocks(); });

  it("returns empty when nothing stored", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    expect(await loadStudioSession("", "demo")).toEqual({ msgs: [], chatId: null, sessionId: null, running: false });
  });

  it("renders history + keeps chatId when the session is alive and running", async () => {
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "claude" });
    vi.stubGlobal("fetch", mockFetch({
      "/api/inspect/session": { sessionId: "sess_1", agent: "claude", meta: {}, turns: [
        { id: "1", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "user", text: "hi" }] },
      ] },
      "/api/chat/chat_1/state": { alive: true, running: true, sessionId: "sess_1", agent: "claude" },
    }));
    const r = await loadStudioSession("", "demo");
    expect(r).toMatchObject({ chatId: "chat_1", sessionId: "sess_1", running: true });
    expect(r.msgs).toEqual([{ role: "user", text: "hi" }]);
  });

  it("drops chatId (fresh continue) when the session is dead but keeps history", async () => {
    setStudioChat("demo", { chatId: "chat_gone", sessionId: "sess_1", agent: "claude" });
    vi.stubGlobal("fetch", mockFetch({
      "/api/inspect/session": { sessionId: "sess_1", agent: "claude", meta: {}, turns: [
        { id: "1", role: "assistant", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "assistant", text: "old reply" }] },
      ] },
      "/api/chat/chat_gone/state": { alive: false },
    }));
    const r = await loadStudioSession("", "demo");
    expect(r).toMatchObject({ chatId: null, sessionId: "sess_1", running: false });
    expect(r.msgs).toEqual([{ role: "agent", text: "old reply" }]);
    expect(getStudioChat("demo")?.chatId).toBe(""); // clearChatId applied
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions/packages/console exec vitest run src/panels/Play/__tests__/studioResume.test.ts -t "loadStudioSession"`
Expected: FAIL — `loadStudioSession` not exported.

- [ ] **Step 3: Implement the loader** — append to `packages/console/src/panels/Play/studioResume.ts`:

```ts
import { makeClient, inspectSessionRoute } from "../../api/routes.js";
import { getStudioChat, clearChatId } from "./studioChatStore.js";

export type StudioResume = { msgs: StudioMsg[]; chatId: string | null; sessionId: string | null; running: boolean };

export async function loadStudioSession(apiBase: string, name: string): Promise<StudioResume> {
  const stored = getStudioChat(name);
  if (!stored) return { msgs: [], chatId: null, sessionId: null, running: false };

  // History from the durable transcript. 404 (opened-but-no-output, or file gone) → empty, not an error.
  let msgs: StudioMsg[] = [];
  try {
    const view = await inspectSessionRoute.call(makeClient(apiBase), {
      query: { id: stored.sessionId, agent: stored.agent as "claude" | "codex" },
    });
    msgs = transcriptToMsgs(view.turns);
  } catch { msgs = []; }

  // Liveness — only the in-memory ChatManager knows. No chatId stored → treat as dead.
  let alive = false, running = false;
  if (stored.chatId) {
    try {
      const res = await fetch(`${apiBase}/api/chat/${encodeURIComponent(stored.chatId)}/state`);
      const st = res.ok ? await res.json() as { alive: boolean; running?: boolean } : { alive: false };
      alive = st.alive === true;
      running = alive && st.running === true;
    } catch { alive = false; }
  }

  if (!alive && stored.chatId) clearChatId(name); // fresh-continue on next send; keep sessionId for history
  return { msgs, chatId: alive ? stored.chatId : null, sessionId: stored.sessionId, running };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions/packages/console exec vitest run src/panels/Play/__tests__/studioResume.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/studioResume.ts packages/console/src/panels/Play/__tests__/studioResume.test.ts
git commit -m "feat(studio): loadStudioSession — restore history + reconcile liveness"
```

---

## Task 7: Wire Studio.tsx — persist on open, reconcile on mount, poll, Stop button

**Files:**
- Modify: `packages/console/src/panels/Play/Studio.tsx`
- Test: `packages/console/src/panels/Play/__tests__/Studio.resume.test.tsx`

**Interfaces:**
- Consumes: `setStudioChat`, `clearChatId`, `clearStudioChat` (Task 4); `loadStudioSession` (Task 6).
- Produces: user-visible restore + Stop; no new exports.

- [ ] **Step 1: Persist sessionId when a session opens** — in `send()`, when the POST returns, the response now includes `sessionId`. Update the block at line 154-158:

```ts
      let id = chatId;
      if (!id) {
        const res = await fetch(`${apiBase}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, miniapp: name }) }).then(j);
        id = res.chatId as string; setChatId(id);
        setStudioChat(name, { chatId: id, sessionId: res.sessionId as string, agent: agentId });
      }
```

Add the import at the top:
```ts
import { setStudioChat, clearChatId, clearStudioChat } from "./studioChatStore.js";
import { loadStudioSession } from "./studioResume.js";
```

- [ ] **Step 2: Reconcile on mount + poll while running** — extend the mount effect (currently line 81-85). Replace it with:

```ts
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    refresh();
    let cancelled = false;
    (async () => {
      const r = await loadStudioSession(apiBase, name);
      if (cancelled) return;
      if (r.msgs.length) setMsgs(r.msgs);
      if (r.chatId) setChatId(r.chatId);
      if (r.running) { setBusy(true); setWorking("resuming…"); pollWhileRunning(r.chatId!); }
    })();
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
      closeRef.current?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, name]);

  // Poll /state until the background turn finishes, then refresh history + preview.
  function pollWhileRunning(id: string) {
    const tick = async () => {
      try {
        const st = await fetch(`${apiBase}/api/chat/${encodeURIComponent(id)}/state`).then((r) => r.ok ? r.json() : { alive: false });
        if (!st.alive || !st.running) {
          setBusy(false); setWorking("");
          const r = await loadStudioSession(apiBase, name);
          setMsgs(r.msgs);
          await refresh();
          return;
        }
      } catch { /* transient — keep polling */ }
      pollRef.current = setTimeout(tick, 1500);
    };
    pollRef.current = setTimeout(tick, 1500);
  }
```

- [ ] **Step 3: Stop button** — add a handler and a header button. Handler (near `changeAgent`):

```ts
  async function stop() {
    const id = chatId;
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    closeRef.current?.(); closeRef.current = null;
    setBusy(false); setWorking("");
    setChatId(null);
    clearChatId(name); // keep sessionId so history still renders
    if (id) { try { await fetch(`${apiBase}/api/chat/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch { /* best-effort */ } }
    setStatus("session stopped");
  }
```

Header button — add to the `play-studio-head` row (after the Save button at line 293), shown only when a turn is active:

```tsx
        {busy && <button className="play-btn play-btn--ghost" onClick={stop} title="kill the running agent session">Stop</button>}
```

- [ ] **Step 4: `changeAgent` clears the store pointer** — the old session belonged to the previous agent; drop the whole entry so a stale sessionId/agent can't resurface. In `changeAgent` (after `setChatId(null)`, line 139):

```ts
    clearStudioChat(name);
```

- [ ] **Step 5: Write the integration test** — `packages/console/src/panels/Play/__tests__/Studio.resume.test.tsx`. Mirror the setup in the existing `Runner.test.tsx` (jsdom, `@testing-library/react`, mocked `fetch`, `IdentityProvider` wrapper if required). Seed the store, mount, assert history renders and Stop calls DELETE.

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Studio } from "../Studio.js";
import { setStudioChat } from "../studioChatStore.js";

// Follow Runner.test.tsx for any required providers/mocks (IdentityProvider, useSplit, etc.).
afterEach(() => { cleanup(); try { localStorage.clear(); } catch { /* ignore */ } vi.restoreAllMocks(); });

function routeFetch(map: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://x").pathname;
    if (init?.method === "DELETE") { (routeFetch as any).deleted = path; return { ok: true, json: async () => ({ ok: true }) } as any; }
    const hit = Object.entries(map).find(([p]) => path.includes(p));
    return hit ? { ok: true, json: async () => hit[1] } as any : { ok: false, status: 404, json: async () => ({}) } as any;
  });
}

describe("Studio resume", () => {
  it("restores history from the transcript on mount", async () => {
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "claude" });
    vi.stubGlobal("fetch", routeFetch({
      "/api/play/miniapp": { html: "<p>x</p>", meta: { title: "Demo", genre: "project-fun" } },
      "/api/inspect/session": { sessionId: "sess_1", agent: "claude", meta: {}, turns: [
        { id: "1", role: "user", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "user", text: "make a timer" }] },
      ] },
      "/api/chat/chat_1/state": { alive: false },
    }));
    render(<Studio apiBase="" name="demo" agents={[]} agentId="claude" onAgentIdChange={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText("make a timer")).toBeTruthy());
  });
});
```

> If wiring the full `Studio` render proves heavy (identity/bind hooks), it is acceptable to assert the restore behavior through `loadStudioSession` (Task 6, already covered) and verify Studio manually via **Step 7**. Do not delete the server-side coverage to make this pass.

- [ ] **Step 6: Run the console test + typecheck**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions/packages/console exec vitest run src/panels/Play/`
Then: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions build`
Expected: PASS + clean typecheck. (Recall: console tests are NOT in CI; run them here.)

- [ ] **Step 7: Manual end-to-end verification** — use the `/run` skill or launch the console:
  1. Open a miniapp in Studio, send a build message, and while the agent is working, navigate to another panel and back → the thread + a "resuming…" spinner appear, and it completes.
  2. Reload the whole tab mid-turn → history re-renders from the transcript; spinner resumes; completes.
  3. Click **Stop** during a turn → the agent halts, the button clears, history remains.
  4. Idle >15 min (or restart the core), return → history renders read-only; sending a new message starts fresh (a new `sessionId` is stored).

- [ ] **Step 8: Commit**

```bash
git add packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/__tests__/Studio.resume.test.tsx
git commit -m "feat(studio): durable session resume + Stop control"
```

---

## Final verification

- [ ] **Run the CI-gated suite** (root, the `test (24)` job):

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions test`
Expected: PASS — this covers Tasks 1–3 (server). Do not rely on it for Tasks 4–7 (console; run those explicitly as above).

- [ ] **Full typecheck/build across the workspace:**

Run: `pnpm -C /Users/rfeng/Projects/ninemind/agentgem-durable-sessions build`
Expected: clean.

- [ ] **Open the PR** per `CLAUDE.md`: push `feat/durable-studio-sessions`, `gh run watch <id> --exit-status`, then `gh pr merge --rebase --delete-branch`. Verify each commit's marker on `origin/main` after merge (the dropped-commit trap).

---

## Self-review (spec coverage)

- **R1 Background** → Task 2 (turn keeps running; guard makes the orphaned-handler completion safe) + Task 7 Step 2 (poll while running). ✓
- **R2 Restore (reload + core restart)** → Task 1 (surface sessionId) + Task 4 (persist) + Tasks 5/6 (transcript restore) + Task 7 (mount reconcile). ✓
- **R3 Recover / Stop** → Task 7 Step 3 (Stop → DELETE). ✓
- **R4 Dead-session fresh continue** → Task 6 (`alive:false` → `chatId:null`, `clearChatId`, history kept) + Task 7 Step 1 (next send opens fresh, re-persists). ✓
- **Concurrency guard / reap protection** → Task 2. ✓
- **`maxLive` all-running** → Task 2 Step 3d (throws `"too many active sessions"`). ✓
- **Error/edge (404 empty, localStorage off, corrupt JSON)** → Task 4 (corrupt JSON), Task 6 (404 → empty), `try/catch` throughout. ✓
- **Out of scope** (live re-attach tailing, ACP `session/load`, Chat panel) → not implemented, per Global Constraints. ✓
