# Studio Resume Live-Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Studio panel resumes an in-flight agent turn, show live progress (from the durable transcript) and never leave the chat permanently locked.

**Architecture:** Client-only. Extract a transcript-only loader in `studioResume.ts`, then rewrite `pollWhileRunning` in `Studio.tsx` so each still-running tick refreshes the transcript and the poll never gives up (mild backoff, no dead-but-`busy` cap). No server/core changes.

**Tech Stack:** TypeScript, React, Vitest (jsdom), `@testing-library/react`. Package: `packages/console`.

## Global Constraints

- No server/core changes — client-only (`packages/console`).
- Run console unit tests with: `pnpm -C packages/console exec vitest run <path>` (jsdom; `Date.now`, `fetch` mocked per-test).
- Preserve existing resume behavior: dead session → `chatId` cleared, history kept; alive+running → resume; transport-drop → reconcile not fail.
- The `busy` lock while a turn is genuinely running is correct — do NOT unlock the composer mid-turn. The fix is progress + guaranteed recovery via **Stop**, not unlocking.
- Transcripts only grow during a turn (append-only session log); the tick's log update replaces state **only on growth** — equal length ⇒ identical content, and adopting a same-length copy re-fires the scroll-follow effect every tick.
- The poll loop must be invalidatable: `clearTimeout` cannot stop a tick that is mid-`await`, so unmount/Stop use a generation counter (`pollGenRef`) that stale ticks check after every `await`.

---

### Task 1: `loadStudioTranscript` — transcript-only loader

**Files:**
- Modify: `packages/console/src/panels/Play/studioResume.ts`
- Test: `packages/console/src/panels/Play/__tests__/studioResume.test.ts`

**Interfaces:**
- Consumes: `getStudioChat` (`./studioChatStore.js`), `makeClient`, `inspectSessionRoute` (`../../api/routes.js`), `transcriptToMsgs`, `StudioMsg` (same file).
- Produces: `export async function loadStudioTranscript(apiBase: string, name: string): Promise<StudioMsg[]>` — returns the miniapp's transcript as `StudioMsg[]`, or `[]` when nothing is stored / the read fails. `loadStudioSession` reuses it for its `msgs`.

- [ ] **Step 1: Write the failing test**

Add to `packages/console/src/panels/Play/__tests__/studioResume.test.ts` (imports `loadStudioTranscript` alongside the existing imports on line 2; reuses the file's `meta` and `mockFetch` helpers):

```ts
import { transcriptToMsgs, loadStudioSession, loadStudioTranscript } from "../studioResume.js";
```

```ts
describe("loadStudioTranscript", () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } vi.restoreAllMocks(); });

  it("returns [] when nothing is stored (no fetch)", async () => {
    const fetchMock = mockFetch({});
    vi.stubGlobal("fetch", fetchMock);
    expect(await loadStudioTranscript("", "demo")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled(); // no session pointer → no round-trip
  });

  it("maps the durable transcript to studio msgs", async () => {
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "claude" });
    vi.stubGlobal("fetch", mockFetch({
      "/api/inspect/session": { sessionId: "sess_1", agent: "claude", meta, turns: [
        { id: "1", role: "assistant", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "assistant", text: "on it" }] },
      ] },
    }));
    expect(await loadStudioTranscript("", "demo")).toEqual([{ role: "agent", text: "on it" }]);
  });

  it("returns [] when the transcript read fails (404)", async () => {
    setStudioChat("demo", { chatId: "chat_1", sessionId: "sess_1", agent: "claude" });
    vi.stubGlobal("fetch", mockFetch({})); // inspect/session → 404 → route throws
    expect(await loadStudioTranscript("", "demo")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/studioResume.test.ts -t "loadStudioTranscript"`
Expected: FAIL — `loadStudioTranscript` is not exported (import error / not a function).

- [ ] **Step 3: Implement `loadStudioTranscript` and reuse it in `loadStudioSession`**

In `packages/console/src/panels/Play/studioResume.ts`, add the loader above `loadStudioSession` (after the `StudioResume` type on line 40):

```ts
// Transcript-only read, reused by loadStudioSession and by Studio's resume poll (so a
// running turn's completed spans surface as it works). No session pointer → [], no round-trip.
// A 404 (opened-but-no-output, or file gone) or any read failure → [], never throws.
export async function loadStudioTranscript(apiBase: string, name: string): Promise<StudioMsg[]> {
  const stored = getStudioChat(name);
  if (!stored) return [];
  try {
    const view = await inspectSessionRoute.call(makeClient(apiBase), {
      query: { id: stored.sessionId, agent: stored.agent as "claude" | "codex" },
    });
    return transcriptToMsgs(view.turns);
  } catch { return []; }
}
```

Then replace the inline transcript read inside `loadStudioSession` (currently lines 47-53) with a call to the new helper:

```ts
  // History from the durable transcript. 404 / read failure → empty, not an error.
  const msgs = await loadStudioTranscript(apiBase, name);
```

(Delete the old `let msgs: StudioMsg[] = []; try { ... } catch { msgs = []; }` block it replaces.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/studioResume.test.ts`
Expected: PASS — the new `loadStudioTranscript` cases and every existing `loadStudioSession` / `transcriptToMsgs` case (which now flows through the helper) are green.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/studioResume.ts packages/console/src/panels/Play/__tests__/studioResume.test.ts
git commit -m "feat(console): loadStudioTranscript helper for resume progress"
```

---

### Task 2: `pollWhileRunning` — live progress + guaranteed recovery

**Files:**
- Modify: `packages/console/src/panels/Play/Studio.tsx` (imports; `pollRef` block at line 123; mount-effect cleanup at :138-142; `pollWhileRunning` at lines 149-169; `stop()` at :235-244; `send()` `onFailed` at :262-272)
- Test: `packages/console/src/panels/Play/__tests__/Studio.resume.test.tsx`

**Interfaces:**
- Consumes: `loadStudioTranscript` (Task 1), `loadStudioSession` (`./studioResume.js`), existing component state setters (`setBusy`, `setWorking`, `setMsgs`, `setInput`, `setStatus`), `refresh`, `pollRef`.
- Produces: nothing new exported — same `pollWhileRunning(id: string)` signature and same two callers (mount effect `Studio.tsx:136`, `send()` reconcile `:267`). Adds a component-local `pollGenRef = useRef(0)` generation counter.

- [ ] **Step 1: Write the failing tests**

The existing `Studio.resume.test.tsx` mocks `../studioStream.js` so `openStudioStream` fires `onFailed("connection lost")` synchronously — leave that intact. Add fake timers to drive ticks and route `/inspect/session` so the transcript can grow between ticks.

Add these cases to `packages/console/src/panels/Play/__tests__/Studio.resume.test.tsx` inside the `describe("Studio resume", …)` block. Note `routeFetch` (defined in that file) matches by `path.includes(p)`; return a stateful `/inspect/session` body so call N+1 differs from call N.

```ts
it("surfaces new transcript spans while a background turn is still running", async () => {
  vi.useFakeTimers();
  try {
    setStudioChat("demo4", { chatId: "chat_4", sessionId: "sess_4", agent: "codex" });
    let turns: unknown[] = []; // grows on the 2nd inspect read
    const base = {
      agent: "codex", sessionId: "sess_4", project: null, model: null, gitBranch: null,
      startMs: 0, endMs: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
    };
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url, "http://x").pathname;
      if (path.includes("/api/inspect/session")) {
        const body = { sessionId: "sess_4", agent: "codex", meta: base, turns };
        turns = [{ id: "1", role: "assistant", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "assistant", text: "wiring it up…" }] }];
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
      }
      if (path.includes("/api/chat/chat_4/state")) return { ok: true, json: async () => ({ alive: true, running: true }) } as unknown as Response;
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "demo4", html: "<p>x</p>",
      meta: { title: "Demo4", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    } as never);

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo4" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    // Mount resume shows the reconnecting label first; nothing built yet.
    await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
    // First still-running tick (1.5s) refreshes the transcript → the new span renders and the label flips to working.
    await vi.advanceTimersByTimeAsync(1600);
    await vi.waitFor(() => expect(screen.getByText("wiring it up…")).toBeTruthy());
    expect(screen.getByText(/working…/i)).toBeTruthy();
  } finally { vi.useRealTimers(); }
});

it("keeps polling (no give-up lock) after many ticks while still running", async () => {
  vi.useFakeTimers();
  try {
    setStudioChat("demo5", { chatId: "chat_5", sessionId: "sess_5", agent: "codex" });
    const fetchMock = routeFetch({
      "/api/inspect/session": { sessionId: "sess_5", agent: "codex", meta: {
        agent: "codex", sessionId: "sess_5", project: null, model: null, gitBranch: null,
        startMs: 0, endMs: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
      }, turns: [] },
      "/api/chat/chat_5/state": { alive: true, running: true },
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "demo5", html: "<p>x</p>",
      meta: { title: "Demo5", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    } as never);

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo5" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    const stopBtn = await screen.findByTitle("kill the agent session");
    // Advance well past the old ~10-min cap; the spinner must still be live and Stop must still recover.
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(screen.getByText(/working…/i)).toBeTruthy();
    fireEvent.click(stopBtn);
    await vi.waitFor(() => expect((fetchMock as unknown as { deleted?: string }).deleted).toBe("/api/chat/chat_5"));
    await vi.waitFor(() => expect(screen.getByText("session stopped")).toBeTruthy());
    // Stop invalidated the poll generation: a stale tick must neither resurrect the
    // spinner nor keep fetching.
    const callsAfterStop = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.length).toBe(callsAfterStop);
    expect(screen.queryByText(/working…/i)).toBeNull();
  } finally { vi.useRealTimers(); }
});
```

Hoist a shared meta helper to the top of the file (above `routeFetch`) — the new
cases below all need an `/inspect/session` meta body:

```ts
const inspectMeta = (sessionId: string) => ({
  agent: "codex", sessionId, project: null, model: null, gitBranch: null,
  startMs: 0, endMs: 0, msgs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0,
});
```

Also import the mocked stream opener alongside the existing imports (the
already-running case overrides its implementation once):

```ts
import { openStudioStream } from "../studioStream.js";
```

Then add these six cases inside the same `describe`:

```ts
it("clears busy and renders the final transcript when the turn completes (regression: never-unlocks)", async () => {
  vi.useFakeTimers();
  try {
    setStudioChat("demo6", { chatId: "chat_6", sessionId: "sess_6", agent: "codex" });
    let stateCalls = 0;
    const finalTurns = [{ id: "1", role: "assistant", tsMs: 0, tokens: { in: 0, out: 0, cache: 0 }, spans: [{ kind: "message", role: "assistant", text: "all done" }] }];
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url, "http://x").pathname;
      if (path.includes("/api/chat/chat_6/state")) {
        stateCalls++; // mount read + tick 1 report running; tick 2 reports done
        return { ok: true, json: async () => ({ alive: true, running: stateCalls <= 2 }) } as unknown as Response;
      }
      if (path.includes("/api/inspect/session")) {
        const body = { sessionId: "sess_6", agent: "codex", meta: inspectMeta("sess_6"), turns: stateCalls >= 2 ? finalTurns : [] };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "demo6", html: "<p>x</p>",
      meta: { title: "Demo6", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    } as never);

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo6" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
    await vi.advanceTimersByTimeAsync(5000); // tick 1 running → tick 2 sees running:false
    await vi.waitFor(() => expect(screen.getByText("all done")).toBeTruthy());
    expect(screen.queryByText(/working…|resuming…/i)).toBeNull(); // spinner gone
    expect((screen.getByPlaceholderText(/ask the agent/i) as HTMLTextAreaElement).disabled).toBe(false); // composer re-enabled
  } finally { vi.useRealTimers(); }
});

it("does not drop the optimistic user message while the transcript is behind (growth-only guard)", async () => {
  vi.useFakeTimers();
  try {
    setStudioChat("demo7", { chatId: "chat_7", sessionId: "sess_7", agent: "codex" });
    let mounted = false;
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url, "http://x").pathname;
      if (path.includes("/api/chat/chat_7/state")) {
        const running = mounted; mounted = true; // idle at mount; running for the send-reconcile poll
        return { ok: true, json: async () => ({ alive: true, running }) } as unknown as Response;
      }
      if (path.includes("/api/inspect/session")) {
        const body = { sessionId: "sess_7", agent: "codex", meta: inspectMeta("sess_7"), turns: [] }; // never catches up
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "demo7", html: "<p>x</p>",
      meta: { title: "Demo7", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    } as never);

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo7" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    const sendBtn = await screen.findByRole("button", { name: "Send" });
    fireEvent.change(screen.getByPlaceholderText(/ask the agent/i), { target: { value: "keep going" } });
    fireEvent.click(sendBtn); // stream mock fires onFailed("connection lost") → reconcile-poll
    await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
    await vi.advanceTimersByTimeAsync(3200); // two ticks with an empty (behind) transcript
    expect(screen.getByText("keep going")).toBeTruthy(); // optimistic message survives
  } finally { vi.useRealTimers(); }
});

it("keeps polling through a transient /state failure and still completes", async () => {
  vi.useFakeTimers();
  try {
    setStudioChat("demo8", { chatId: "chat_8", sessionId: "sess_8", agent: "codex" });
    let stateCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url, "http://x").pathname;
      if (path.includes("/api/chat/chat_8/state")) {
        stateCalls++;
        if (stateCalls === 2) throw new Error("socket hiccup"); // first poll tick fails
        return { ok: true, json: async () => ({ alive: true, running: stateCalls < 3 }) } as unknown as Response;
      }
      if (path.includes("/api/inspect/session")) {
        const body = { sessionId: "sess_8", agent: "codex", meta: inspectMeta("sess_8"), turns: [] };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "demo8", html: "<p>x</p>",
      meta: { title: "Demo8", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    } as never);

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo8" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
    await vi.advanceTimersByTimeAsync(5000); // tick 1 throws → tick 2 completes
    await vi.waitFor(() => expect(screen.queryByText(/resuming…|working…/i)).toBeNull());
  } finally { vi.useRealTimers(); }
});

it("stops polling when the panel unmounts (no orphan loop)", async () => {
  vi.useFakeTimers();
  try {
    setStudioChat("demo9", { chatId: "chat_9", sessionId: "sess_9", agent: "codex" });
    const fetchMock = routeFetch({
      "/api/inspect/session": { sessionId: "sess_9", agent: "codex", meta: inspectMeta("sess_9"), turns: [] },
      "/api/chat/chat_9/state": { alive: true, running: true },
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "demo9", html: "<p>x</p>",
      meta: { title: "Demo9", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    } as never);

    const { unmount } = render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo9" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
    await vi.advanceTimersByTimeAsync(1600); // let the loop take at least one tick
    const calls = fetchMock.mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.length).toBe(calls); // generation guard: nothing after unmount
  } finally { vi.useRealTimers(); }
});

it("admits connection trouble after repeated /state failures instead of claiming work", async () => {
  vi.useFakeTimers();
  try {
    setStudioChat("demo10", { chatId: "chat_10", sessionId: "sess_10", agent: "codex" });
    let stateCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url, "http://x").pathname;
      if (path.includes("/api/chat/chat_10/state")) {
        stateCalls++;
        if (stateCalls > 1) throw new Error("server unreachable"); // mount succeeds; every poll tick fails
        return { ok: true, json: async () => ({ alive: true, running: true }) } as unknown as Response;
      }
      if (path.includes("/api/inspect/session")) {
        const body = { sessionId: "sess_10", agent: "codex", meta: inspectMeta("sess_10"), turns: [] };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "demo10", html: "<p>x</p>",
      meta: { title: "Demo10", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    } as never);

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo10" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    await vi.waitFor(() => expect(screen.getByText(/resuming…/i)).toBeTruthy());
    await vi.advanceTimersByTimeAsync(4 * 1500 + 500); // OFFLINE_TICKS consecutive failures
    await vi.waitFor(() => expect(screen.getByText(/can't reach the agent — retrying…/i)).toBeTruthy());
  } finally { vi.useRealTimers(); }
});

it("restores the message to the composer when the server rejects it (already running)", async () => {
  vi.useFakeTimers();
  try {
    setStudioChat("demo11", { chatId: "chat_11", sessionId: "sess_11", agent: "codex" });
    vi.mocked(openStudioStream).mockImplementationOnce(
      (_apiBase: string, _chatId: string, _message: string, h: { onFailed: (e: string) => void }) => {
        h.onFailed("a turn is already running for this chat");
        return () => {};
      });
    const fetchMock = routeFetch({
      "/api/inspect/session": { sessionId: "sess_11", agent: "codex", meta: inspectMeta("sess_11"), turns: [] },
      "/api/chat/chat_11/state": { alive: true, running: false }, // idle at mount; reconcile-poll resolves fast
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "demo11", html: "<p>x</p>",
      meta: { title: "Demo11", genre: "project-fun", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    } as never);

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="demo11" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    const sendBtn = await screen.findByRole("button", { name: "Send" });
    fireEvent.change(screen.getByPlaceholderText(/ask the agent/i), { target: { value: "second thought" } });
    fireEvent.click(sendBtn);

    await vi.waitFor(() => expect(screen.getByText("agent is still working — message not sent")).toBeTruthy());
    expect(screen.queryByText("second thought")).toBeNull();               // un-appended from the log
    expect(screen.getByDisplayValue("second thought")).toBeTruthy();       // back in the composer
  } finally { vi.useRealTimers(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Studio.resume.test.tsx`
Expected: FAIL — the new cases fail (old `pollWhileRunning` never re-reads the transcript, so "wiring it up…" never appears; at 15 min the old cap has cleared the spinner leaving no `working…` text; there is no generation guard, degraded label, or already-running restore yet). Existing cases still pass.

- [ ] **Step 3: Add the import and the generation counter**

In `packages/console/src/panels/Play/Studio.tsx`, extend the existing `studioResume.js` import (line 16):

```ts
import { loadStudioSession, loadStudioTranscript } from "./studioResume.js";
```

Next to `pollRef` (line 123), add the generation counter:

```ts
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Invalidates in-flight poll ticks: clearTimeout can't stop a tick that is mid-await,
  // so unmount/Stop bump the generation and stale ticks bail instead of rescheduling.
  const pollGenRef = useRef(0);
```

- [ ] **Step 4: Rewrite `pollWhileRunning`**

Replace `Studio.tsx` lines 146-169 (the `POLL_MS`/`POLL_MAX` constants and the `pollWhileRunning` function) with:

```js
  // Poll /state until the background turn finishes, then refresh history + preview.
  // While it runs, re-read the durable transcript each tick so completed spans surface as
  // live progress (Approach A). No give-up cap: a running turn is legitimately running — keep
  // the correct busy lock, show movement, and leave Stop as the guaranteed recovery. Mild
  // backoff after a ramp window keeps a long turn from re-parsing hot. pollGenRef invalidates
  // the loop across unmount/Stop/re-entry — a stale tick must neither touch state nor reschedule.
  const POLL_MS = 1500;
  const POLL_SLOW_MS = 4000;
  const RAMP_TICKS = Math.round((2 * 60_000) / POLL_MS); // fast for ~2 min, then back off
  const OFFLINE_TICKS = 4; // consecutive /state failures before the label admits trouble
  function pollWhileRunning(id: string) {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; } // never run two loops
    const gen = ++pollGenRef.current;
    let ticks = 0;
    let failStreak = 0;
    const tick = async () => {
      try {
        const st = await fetch(`${apiBase}/api/chat/${encodeURIComponent(id)}/state`).then((r) => r.ok ? r.json() : { alive: false });
        if (gen !== pollGenRef.current) return; // stale loop (unmounted / stopped / superseded)
        failStreak = 0;
        if (!st.alive || !st.running) {
          setBusy(false); setWorking("");
          const r = await loadStudioSession(apiBase, name);
          if (gen !== pollGenRef.current) return;
          setMsgs(r.msgs);
          await refresh();
          return;
        }
        // Still running — reflect live work and grow the log. Replace only when the transcript
        // GREW: the durable log is append-only during a turn, so equal length ⇒ identical
        // content, and adopting a same-length copy would re-fire the scroll-follow effect every
        // tick (yanking a scrolled-up reader to the bottom). Growth-only also means the
        // send()-path optimistic user message and a transient empty read never clobber the screen.
        setWorking("working…");
        const msgs = await loadStudioTranscript(apiBase, name);
        if (gen !== pollGenRef.current) return;
        setMsgs((cur) => (msgs.length > cur.length ? msgs : cur));
      } catch {
        // transient — keep polling, keep the last log; after a streak, tell the truth
        if (gen !== pollGenRef.current) return;
        if (++failStreak >= OFFLINE_TICKS) setWorking("can't reach the agent — retrying…");
      }
      ticks++;
      pollRef.current = setTimeout(tick, ticks >= RAMP_TICKS ? POLL_SLOW_MS : POLL_MS);
    };
    pollRef.current = setTimeout(tick, POLL_MS);
  }
```

- [ ] **Step 5: Invalidate the generation in the mount cleanup and `stop()`, split the `onFailed` reconcile branch**

In the mount effect's cleanup (`Studio.tsx:138-142`), bump the generation next to the existing `clearTimeout`:

```ts
    return () => {
      cancelled = true;
      pollGenRef.current++; // orphan any in-flight tick — it may resume after this cleanup
      if (pollRef.current) clearTimeout(pollRef.current);
      closeRef.current?.();
    };
```

In `stop()` (`Studio.tsx:237`), same bump beside the existing `clearTimeout`:

```ts
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; }
    pollGenRef.current++; // a mid-flight tick must not resurrect the spinner after Stop
```

In `send()`'s `onFailed` (`Studio.tsx:262-272`), split the two reconcile cases — "already running"
means the server REFUSED this message (`chatSession.ts:127-128`), so it will never reach the
transcript and must go back to the composer instead of being silently eaten by the next
transcript replace:

```ts
        onFailed: (e) => {
          // A turn stays alive server-side after a stream drop (Task 3). "already running"
          // (another window owns the turn) means the server REFUSED this message — un-append
          // the optimistic copy and hand the text back to the composer, then reconcile.
          // "connection lost" (transient transport drop) means the turn DID start with this
          // message — reconcile via /state; the growth guard protects the optimistic copy.
          if (id && /already running/i.test(e)) {
            setMsgs((m) => (m.length && m[m.length - 1].role === "user" ? m.slice(0, -1) : m));
            setInput(message);
            setStatus("agent is still working — message not sent");
            setWorking("resuming…"); pollWhileRunning(id);
            return;
          }
          if (id && e === "connection lost") {
            setWorking("resuming…"); pollWhileRunning(id);
            return;
          }
          setBusy(false); setWorking("");
          setMsgs((m) => [...m, { role: "tool", title: `failed: ${e}`, failed: true }]);
        },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Studio.resume.test.tsx`
Expected: PASS — the eight new cases and all three existing resume cases (restore history; resuming spinner + Stop kills; reconcile-not-fail on transport drop) are green.

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/__tests__/Studio.resume.test.tsx
git commit -m "fix(console): Studio resume shows live progress and never locks the chat"
```

---

### Task 3: Full-panel regression pass

**Files:**
- Test only (no source changes): the Play panel suite.

- [ ] **Step 1: Run the full Play panel test suite**

Run: `pnpm -C packages/console exec vitest run src/panels/Play`
Expected: PASS — no regressions across Studio, Runner, Composer, and the resume/stream suites.

- [ ] **Step 2: Run the whole console unit suite**

Run: `pnpm -C packages/console test`
Expected: PASS — full console suite green (build.test.ts is excluded from this fast loop by config).

- [ ] **Step 3: Typecheck**

Run: `pnpm -C packages/console exec tsc --noEmit` (or the package's build script if it typechecks)
Expected: no type errors — `loadStudioTranscript` signature and the `setMsgs` functional-updater types line up.

- [ ] **Step 4: Manual check — live progress against a real codex turn (2 min)**

Incremental mid-turn transcript writes are proven for the Watch Feed's read path
(PR #463), but confirm the Studio resume path against a real **codex** session:
start a long-running codex turn in Studio, reload the window mid-turn, and watch
completed spans appear during resume (not only at turn end). Also scroll up in
the chat log mid-turn and confirm the view is NOT yanked to the bottom on quiet
ticks (jsdom cannot test scroll behavior).

(No commit — this task only verifies.)

---

## Self-Review

**Spec coverage:**
- Spec §Design.1 "transcript-only loader" → Task 1. ✓
- Spec §Design.2 "pollWhileRunning progress + recovery (transcript refresh, backoff, drop cap, generation guard, labels)" → Task 2, Steps 3-5. ✓
- Spec §Design.3 "rejected message returns to the composer" → Task 2, Step 5 (`onFailed` split) + already-running test. ✓
- Spec §Design.4 "no other UI changes; both callers funnel through pollWhileRunning" → unchanged callers; verified by Task 3 regression. ✓
- Spec §Testing (1) progress while running → Task 2 test 1. (2) optimistic survives → dedicated growth-guard test. (3) completion clears → dedicated regression test (busy clears, composer re-enables, final transcript). (4) no permanent lock → 15-min test incl. post-Stop generation assert. (5) unmount stops polling → dedicated test. (6) transient failure recovers → dedicated test. (7) degraded label → dedicated test. (8) rejected message restored → dedicated test. ✓
- Spec §Error handling (state throw / degraded label / transcript throw / unmount-Stop generation / rejected message / wedged) → all mapped to Task 2 code + tests; wedged-turn watchdog captured in `TODOS.md`. ✓

**Placeholder scan:** none — every code/test step shows full content and exact commands.

**Type consistency:** `loadStudioTranscript(apiBase: string, name: string): Promise<StudioMsg[]>` defined in Task 1 and consumed identically in Task 2; `setMsgs((cur) => …)` matches the `StudioMsg[]` state; `pollGenRef: MutableRefObject<number>`; `m[m.length - 1].role` narrows on the `StudioMsg` union (both variants carry `role`); imports updated in Task 2 Step 3.

**Eng-review provenance (2026-07-17):** generation guard, growth-only (`>`)
replace, degraded offline label, already-running composer restore, and the
completion-clears regression test were added by `/plan-eng-review` of PR #469
(decisions D2-D9; outside-voice pass by Codex concurred on the Stop-invalidation
and degraded-label points).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | CLEAR (outside voice) | 6 findings: 2 accepted (D9, D10), 2 absorbed (D2, D4), 2 rejected on code facts |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 8 issues (2 arch, 2 quality, 1 perf, 3 test gaps), all folded into spec + plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** outside-voice pass concurred on Stop-invalidation and degraded-label; its pointer-consistency and length-merge concerns were rejected against the actual code (synchronous reads cannot interleave; the session log is append-only).
- **CROSS-MODEL:** both models converged on the two D2/D9 lock-class fixes; the wedged-turn watchdog both flagged is captured in `TODOS.md`.
- **VERDICT:** ENG CLEARED — plan updated with all accepted decisions (D2-D10); ready to implement.

NO UNRESOLVED DECISIONS
