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
- Transcripts only grow during a turn; the tick's log update must never regress or clobber the optimistic trailing user message.

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
- Modify: `packages/console/src/panels/Play/Studio.tsx` (imports; `pollWhileRunning` at lines 149-169)
- Test: `packages/console/src/panels/Play/__tests__/Studio.resume.test.tsx`

**Interfaces:**
- Consumes: `loadStudioTranscript` (Task 1), `loadStudioSession` (`./studioResume.js`), existing component state setters (`setBusy`, `setWorking`, `setMsgs`), `refresh`, `pollRef`.
- Produces: nothing new exported — same `pollWhileRunning(id: string)` signature and same two callers (mount effect `Studio.tsx:136`, `send()` reconcile `:267`).

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
  } finally { vi.useRealTimers(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Studio.resume.test.tsx`
Expected: FAIL — the new cases fail (old `pollWhileRunning` never re-reads the transcript, so "wiring it up…" never appears; and at 15 min the old cap has cleared the spinner leaving no `working…` text). Existing cases still pass.

- [ ] **Step 3: Add the import**

In `packages/console/src/panels/Play/Studio.tsx`, extend the existing `studioResume.js` import (line 16):

```ts
import { loadStudioSession, loadStudioTranscript } from "./studioResume.js";
```

- [ ] **Step 4: Rewrite `pollWhileRunning`**

Replace `Studio.tsx` lines 146-169 (the `POLL_MS`/`POLL_MAX` constants and the `pollWhileRunning` function) with:

```js
  // Poll /state until the background turn finishes, then refresh history + preview.
  // While it runs, re-read the durable transcript each tick so completed spans surface as
  // live progress (Approach A). No give-up cap: a running turn is legitimately running — keep
  // the correct busy lock, show movement, and leave Stop as the guaranteed recovery. Unmount
  // clears pollRef. Mild backoff after a ramp window keeps a long turn from re-parsing hot.
  const POLL_MS = 1500;
  const POLL_SLOW_MS = 4000;
  const RAMP_TICKS = Math.round((2 * 60_000) / POLL_MS); // fast for ~2 min, then back off
  function pollWhileRunning(id: string) {
    if (pollRef.current) { clearTimeout(pollRef.current); pollRef.current = null; } // never run two loops
    let ticks = 0;
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
        // Still running — reflect live work and grow the log. Only replace when the transcript is
        // caught up (it only grows during a turn), so the send()-path optimistic user message and
        // a transient empty read never clobber what's on screen.
        setWorking("working…");
        const msgs = await loadStudioTranscript(apiBase, name);
        setMsgs((cur) => (msgs.length >= cur.length ? msgs : cur));
      } catch { /* transient — keep polling, keep the last log */ }
      ticks++;
      pollRef.current = setTimeout(tick, ticks >= RAMP_TICKS ? POLL_SLOW_MS : POLL_MS);
    };
    pollRef.current = setTimeout(tick, POLL_MS);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/Studio.resume.test.tsx`
Expected: PASS — new cases and all three existing resume cases (restore history; resuming spinner + Stop kills; reconcile-not-fail on transport drop) are green.

- [ ] **Step 6: Commit**

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

(No commit — this task only verifies.)

---

## Self-Review

**Spec coverage:**
- Spec §Design.1 "transcript-only loader" → Task 1. ✓
- Spec §Design.2 "pollWhileRunning progress + recovery (transcript refresh, backoff, drop cap, label)" → Task 2, Step 4. ✓
- Spec §Design.3 "optimistic-message flicker guard (`msgs.length >= cur.length`)" → Task 2, Step 4 code + Step 1 rationale (covered by the "surfaces new spans" + existing reconcile tests). ✓
- Spec §Design.4 "shared code path, both callers funnel through pollWhileRunning" → unchanged callers; verified by Task 3 regression. ✓
- Spec §Testing (1) progress while running → Task 2 test 1. (3) completion clears → existing test + Task 1 done-branch unchanged. (4) no permanent lock → Task 2 test 2. ✓
- Spec §Error handling (state throw / transcript throw / unmount / wedged) → `catch` keeps polling; `loadStudioTranscript` returns `[]` guarded by `>=`; unmount cleanup unchanged; Stop recovers. ✓

**Placeholder scan:** none — every code/test step shows full content and exact commands.

**Type consistency:** `loadStudioTranscript(apiBase: string, name: string): Promise<StudioMsg[]>` defined in Task 1 and consumed identically in Task 2; `setMsgs((cur) => …)` matches the `StudioMsg[]` state; import updated in Task 2 Step 3.

**Note on Spec §Testing (2)** (optimistic-message-survives as a standalone unit test): the `>=` guard is exercised indirectly by test 1 (empty transcript on the first read does not blank the log) and by the existing send-reconcile test. A dedicated standalone assertion was folded in rather than duplicated to keep the suite DRY; if a reviewer wants it explicit, add a case that appends a user message, ticks once with `turns: []`, and asserts the user message is still present.
