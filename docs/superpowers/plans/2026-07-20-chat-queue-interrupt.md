# Chat Queue + Turn Interrupt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While an ACP agent turn is in flight, both chat composers (Play Studio, goldmine Chat tab) keep accepting typed messages as a removable client-side queue that coalesces into one next turn, and gain an Interrupt that cancels the in-flight turn via ACP `session/cancel` without killing the session.

**Architecture:** One thin server seam threaded bottom-up — `acpSession` gains `cancel()` (an ACP notification) and stops discarding the turn's `stopReason`; `RunResult` carries `stopReason` so the existing `done` SSE frame forwards it for free; `ChatManager` gains `cancelChat`; `chatRoutes` gains `POST /api/chat/:id/cancel`. Everything else is client state in the two composers (queue chips, auto-fire, Interrupt button). Spec: `docs/superpowers/specs/2026-07-20-chat-queue-interrupt-design.md`.

**Tech Stack:** TypeScript ESM monorepo (pnpm), vitest against compiled `dist/` at the root, React + jsdom vitest in `packages/console` (local-only, not CI).

## Global Constraints

- **Root tests run compiled**: `tsc -b` first; focused runs filter on the **dist** path (`npx vitest run dist/goldmine/__tests__/chatRoutes.test.js`), never `src/`.
- **Console tests are local-only** (not in CI): run `npx vitest run <file>` from `packages/console`; also run `npx tsc --noEmit` there before finishing.
- **`ChatSessionHandle.cancel` is optional** (`cancel?(): void`) so existing fakes/implementors keep compiling.
- **Interrupting an idle or unknown-cancel chat is a no-op, never an error**; `cancelled: false` in the route reply.
- **Cancelled turns still checkpoint**: `chatRoutes`' stream handler checkpoints when `!failed && miniapp` — a cancelled turn ends with `done` (not `failed`), so this holds with no change; do not "fix" it.
- **Queue is in-memory v1** — no persistence; on `onFailed` the queue is held, never auto-fired.
- Worktree `../agentgem-worktrees/chat-queue-interrupt` (branch `chat-queue-interrupt`); PR gated on `test (24)`; verify every commit's content on `origin/main` after merge.

---

### Task 1: the cancel + stopReason seam (base → run → chat manager)

**Files:**
- Modify: `packages/base/src/acpSession.ts` (the session object returned by `open()`, ~lines 139–157, and the session interface at ~lines 67–73)
- Modify: `packages/run/src/acpRun.ts` (`RunResult` ~line 39; `connectRunSession`'s handle ~lines 218–225)
- Modify: `packages/run/src/chatSession.ts` (`ChatSessionHandle` interface ~line 23; new `cancelChat` method on `ChatManager` next to `closeChat`)
- Modify: `packages/app/src/goldmine/chatRoutes.ts` (`makeChatConnectFn`'s handle, ~lines 292–303)
- Test: `src/goldmine/__tests__/chatCancel.test.ts` (new; harness copied from `chatRoutes.test.ts`)

**Interfaces:**
- Consumes: `agentCtx.notify("session/cancel", { sessionId })` — typed in `@agentclientprotocol/sdk`; the prompt loop's `stop` message (verify the reason field on the SDK's stop message at implementation — expected `msg.stopReason`, e.g. `"end_turn" | "cancelled"`).
- Produces: `RunResult.stopReason?: string`; `ChatSessionHandle.cancel?(): void`; `ChatManager.cancelChat(chatId: string): boolean`. Tasks 2–5 rely on these exact names.

- [ ] **Step 1: Write the failing tests**

Create `src/goldmine/__tests__/chatCancel.test.ts`. Copy the top-of-file harness from `src/goldmine/__tests__/chatRoutes.test.ts` (the `makeFakeConnectFn` + `new ChatManager({ connectFn })` pattern — read that file first and mirror its imports and fake shape exactly), then make the fake's `prompt` hang until its `cancel` fires:

```ts
// A fake handle whose prompt only resolves after cancel() — mirrors an agent honoring session/cancel.
const makeCancellableConnectFn = () => {
  const seen = { cancelled: false };
  const connectFn = async () => ({
    ctx: {
      open: async () => {
        let release: (() => void) | null = null;
        return {
          sessionId: "sess_c",
          setMode: async () => {},
          prompt: async () => {
            await new Promise<void>((r) => { release = r; });
            return { text: "partial", toolCalls: [], stopReason: "cancelled" };
          },
          cancel: () => { seen.cancelled = true; release?.(); },
          dispose: () => {},
        };
      },
    },
    close: () => {},
  });
  return { connectFn, seen };
};

describe("cancelChat", () => {
  it("cancels a running turn: handle.cancel fires and done carries stopReason cancelled", async () => {
    const { connectFn, seen } = makeCancellableConnectFn();
    const mgr = new ChatManager({ connectFn: connectFn as never });
    const chatId = await mgr.openChat({ agentId: "claude-code", cwd: "/tmp" } as never);
    const events: unknown[] = [];
    const gen = mgr.sendMessage(chatId, "build it");
    const consuming = (async () => { for await (const e of gen) events.push(e); })();
    await new Promise((r) => setTimeout(r, 20));          // turn is now running
    expect(mgr.cancelChat(chatId)).toBe(true);
    await consuming;
    expect(seen.cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", result: { stopReason: "cancelled" } });
    expect(mgr.stateOf(chatId)).toMatchObject({ alive: true, running: false }); // session survives
  });

  it("is a no-op on an idle chat and an unknown chat", async () => {
    const { connectFn } = makeCancellableConnectFn();
    const mgr = new ChatManager({ connectFn: connectFn as never });
    const chatId = await mgr.openChat({ agentId: "claude-code", cwd: "/tmp" } as never);
    expect(mgr.cancelChat(chatId)).toBe(false);           // idle
    expect(mgr.cancelChat("nope")).toBe(false);           // unknown
  });

  it("returns false when the handle has no cancel support", async () => {
    // Reuse chatRoutes.test.ts's makeFakeConnectFn (no cancel member) — running or not, no cancel to send.
    const mgr = new ChatManager({ connectFn: makeFakeConnectFn({}) as never });
    const chatId = await mgr.openChat({ agentId: "claude-code", cwd: "/tmp" } as never);
    expect(mgr.cancelChat(chatId)).toBe(false);
  });
});
```

Adapt `openChat`'s argument shape to whatever `chatRoutes.test.ts` actually passes (read it; do not invent fields).

- [ ] **Step 2: Compile, run, verify failure**

Run: `tsc -b && npx vitest run dist/goldmine/__tests__/chatCancel.test.js`
Expected: FAIL — `cancelChat` is not a function.

- [ ] **Step 3: Implement the seam, bottom-up**

(a) `packages/base/src/acpSession.ts` — session interface (~line 67):

```ts
  sessionId: string;
  setMode(mode: string): Promise<void>;
  /** Resolves with the turn's stop reason (e.g. "end_turn", "cancelled") once the agent stops. */
  prompt(text: string, onUpdate: (update: unknown) => void): Promise<string | undefined>;
  /** Fire-and-forget ACP session/cancel — the in-flight prompt then ends with stopReason "cancelled". */
  cancel(): void;
  dispose(): void;
```

and the implementation inside `open()` (~line 145): the prompt loop returns the reason instead of discarding it, plus the new member:

```ts
        async prompt(text: string, onUpdate: (update: unknown) => void) {
          if (died) throw died; // session already dead — fail fast instead of hanging
          void session.prompt(text);
          for (;;) {
            // Race the next update against child death so a crashed adapter rejects here, not hangs.
            const msg: any = await Promise.race([session.nextUpdate(), dead]);
            if (msg.kind === "stop") return msg.stopReason as string | undefined;
            if (msg.kind === "session_update") onUpdate(msg.update);
          }
        },
        cancel() {
          // A notification, not a request: the agent may emit final updates, then the running
          // prompt ends with stopReason "cancelled" (ACP spec). Never awaited against the turn.
          void agentCtx.notify("session/cancel", { sessionId }).catch(() => {});
        },
```

Before writing, confirm the stop message's reason field name in the installed SDK: `grep -n "stopReason" node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` (after `pnpm install` in the worktree). If the stop message nests it differently (e.g. `msg.reason`), use the real name.

(b) `packages/run/src/acpRun.ts` — `RunResult` (~line 39) gains the field:

```ts
export interface RunResult {
  text: string;
  toolCalls: ToolInvocation[];
  /** ACP stop reason for the turn (e.g. "end_turn", "cancelled"); absent on adapters that omit it. */
  stopReason?: string;
}
```

and `connectRunSession`'s handle (~line 220) threads it plus cancel:

```ts
        async prompt(text, onDelta, onToolCall) {
          const acc = createAccumulator();
          const stopReason = await session.prompt(text, (u) => applyUpdate(acc, (u ?? {}) as Parameters<typeof applyUpdate>[1], { onDelta, onToolCall }));
          return { ...acc, stopReason };
        },
        cancel: () => session.cancel(),
```

(c) `packages/run/src/chatSession.ts` — `ChatSessionHandle` (~line 23) gains the optional member:

```ts
  /** Fire-and-forget cancel of the in-flight prompt (ACP session/cancel). Optional: fakes and
   * adapters without cancel support simply omit it. */
  cancel?(): void;
```

and `ChatManager` gains, next to `closeChat`:

```ts
  /** Cancel the running turn of a chat, if any. The turn's own stream then finishes with
   * done + stopReason "cancelled"; the session stays alive. Returns whether a cancel was sent. */
  cancelChat(chatId: string): boolean {
    const chat = this.live.get(chatId);
    if (!chat?.running || !chat.handle.cancel) return false;
    try { chat.handle.cancel(); } catch { return false; }
    return true;
  }
```

(d) `packages/app/src/goldmine/chatRoutes.ts` — `makeChatConnectFn`'s handle (~line 295) mirrors (b):

```ts
          async prompt(text: string, onDelta?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void) {
            const acc = createAccumulator();
            const stopReason = await session.prompt(text, (u) =>
              applyUpdate(acc, (u ?? {}) as Parameters<typeof applyUpdate>[1], { onDelta, onToolCall }),
            );
            return { ...acc, stopReason };
          },
          cancel: () => session.cancel(),
```

- [ ] **Step 4: Compile, run the new tests plus neighbors**

Run: `tsc -b && npx vitest run dist/goldmine/__tests__/chatCancel.test.js dist/goldmine/__tests__/chatRoutes.test.js dist/gem/__tests__/chatSession.live.test.js`
Expected: ALL PASS (the live test is env-gated; skipping is fine, failing is not).

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/acpSession.ts packages/run/src/acpRun.ts packages/run/src/chatSession.ts packages/app/src/goldmine/chatRoutes.ts src/goldmine/__tests__/chatCancel.test.ts
git commit -m "feat(chat): ACP turn cancel seam — session/cancel + stopReason through the stack"
```

---

### Task 2: `POST /api/chat/:id/cancel`

**Files:**
- Modify: `packages/app/src/goldmine/chatRoutes.ts` (`registerChatRoutes` — add the route next to the existing `DELETE /api/chat/:id`; mirror its guard + express style exactly)
- Test: extend `src/goldmine/__tests__/chatCancel.test.ts`

**Interfaces:**
- Consumes: `ChatManager.cancelChat(chatId): boolean` (Task 1).
- Produces: `POST /api/chat/:id/cancel` → 200 `{ cancelled: boolean }`; 404 for an unknown chat. Tasks 4–5 call it via `fetch`.

- [ ] **Step 1: Write the failing route test**

Read how `chatRoutes.test.ts` invokes routes (it registers against a fake/real express app — mirror precisely). Add to `chatCancel.test.ts`:

```ts
describe("POST /api/chat/:id/cancel", () => {
  it("404s for an unknown chat; {cancelled:false} idle; {cancelled:true} while running", async () => {
    // Mirror the register + request helper from chatRoutes.test.ts verbatim.
    // unknown id → 404
    // open a chat, no turn → 200 { cancelled: false }
    // start a turn with the cancellable fake, then cancel → 200 { cancelled: true }, and the
    // stream's final event is done with stopReason "cancelled".
  });
});
```

Fill the body with the harness's real request helper — the assertions above are the contract; the plumbing comes from the existing test file (read it, copy its style; the three sub-cases may be three `it`s if the harness prefers).

- [ ] **Step 2: Run to verify failure** — `tsc -b && npx vitest run dist/goldmine/__tests__/chatCancel.test.js` → FAIL (404 route missing entirely).

- [ ] **Step 3: Implement the route** (in `registerChatRoutes`, styled exactly like the neighboring `DELETE /api/chat/:id` — same `guard`, same param decoding):

```ts
  // POST /api/chat/:id/cancel — interrupt the running turn (ACP session/cancel); session stays
  // alive. Idle chat → { cancelled: false } (interrupting an already-finished turn is a no-op,
  // never an error). Unknown chat → 404.
  app.post("/api/chat/:id/cancel", guard, (req, res) => {
    const chatId = req.params.id;
    if (manager.stateOf(chatId).alive === false) { res.status(404).json({ error: "unknown chat" }); return; }
    res.json({ cancelled: manager.cancelChat(chatId) });
  });
```

Adapt identifier names (`manager`, `guard`, `app`) to what `registerChatRoutes` actually holds — read the surrounding function; do not rename its locals.

- [ ] **Step 4: Run tests** — same command as Step 2 → PASS, plus `dist/goldmine/__tests__/chatRoutes.test.js` still green.

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/goldmine/chatRoutes.ts src/goldmine/__tests__/chatCancel.test.ts
git commit -m "feat(chat): POST /api/chat/:id/cancel — turn interrupt route"
```

---

### Task 3: stream consumers surface stopReason

**Files:**
- Modify: `packages/console/src/panels/Play/studioStream.ts` (the `StudioStreamHandlers.onDone` type)
- Modify: `packages/console/src/panels/Chat/chatStream.ts` (same change — read the file; it is a near-copy with a hardcoded apiBase)
- Test: `packages/console/src/panels/Play/studioStream.test.ts` (extend)

**Interfaces:**
- Produces: `onDone(result: { text: string; toolCalls: unknown[]; stopReason?: string })` — Tasks 4–5 branch on `result.stopReason === "cancelled"`.

- [ ] **Step 1: Failing test** — in `studioStream.test.ts` (read its EventSource-faking pattern and mirror): emit a `done` frame whose data is `{"result":{"text":"t","toolCalls":[],"stopReason":"cancelled"}}` and assert `onDone` received `stopReason: "cancelled"`.
- [ ] **Step 2: Run** — from `packages/console`: `npx vitest run src/panels/Play/studioStream.test.ts` → FAIL only if the type/pass-through drops the field; if it already passes structurally (the field rides the same object), tighten the assertion then move on — the change is then type-only.
- [ ] **Step 3: Implement** — in both stream files, extend the handler type:

```ts
  onDone: (result: { text: string; toolCalls: unknown[]; stopReason?: string }) => void;
```

(no runtime change — the SSE `done` frame already carries `result` verbatim, which now includes `stopReason` from Task 1).

- [ ] **Step 4: Run** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/studioStream.ts packages/console/src/panels/Play/studioStream.test.ts packages/console/src/panels/Chat/chatStream.ts
git commit -m "feat(console): chat streams surface the turn's stopReason"
```

---

### Task 4: Studio composer — queue chips + Interrupt

**Files:**
- Modify: `packages/console/src/panels/Play/Studio.tsx` — the `busy` composer block: textarea (`disabled={busy}` ~line 711), Send button (~line 762), Stop button (~line 603), `send()` (~line 284), `submit()` (~line 333), the stream's `onDone` (~line 300)
- Test: `packages/console/src/panels/Play/__tests__/Studio.queue.test.tsx` (new; mirror the render/mocking harness of the existing Studio tests in that directory — find them with `ls packages/console/src/panels/Play/__tests__ | grep -i studio` and read one before writing)

**Interfaces:**
- Consumes: `POST /api/chat/:id/cancel` (Task 2); `onDone(result.stopReason)` (Task 3).
- Produces: user-visible behavior only.

- [ ] **Step 1: Failing tests** (`Studio.queue.test.tsx`) — five behaviors, using the existing Studio test harness for rendering and stream stubbing:

```ts
// 1. typing while busy queues: with a turn in flight, type "also blue" + Enter → a chip
//    "also blue" renders, no second POST/stream is opened, textarea clears.
// 2. chips are removable: click the chip's ✕ → chip gone, nothing sent.
// 3. done → coalesced auto-send: queue ["a","b"], complete the turn (onDone) → exactly ONE
//    new stream opens with message "a\nb", queue empties.
// 4. failed → queue holds: queue ["a"], fail the turn (onFailed) → no auto-send; a
//    "Send queued" button appears; clicking it sends "a".
// 5. Interrupt: while busy, an "Interrupt" button shows (Stop's slot); click → fetch POSTs
//    /api/chat/<id>/cancel; when the stream then ends with stopReason "cancelled", the
//    transcript shows "interrupted" and the queued message auto-fires.
```

Write these as real tests against the harness's actual seams (the existing Studio tests stub `openStudioStream` and `fetch` — reuse their exact stubbing helpers).

- [ ] **Step 2: Run** — `npx vitest run src/panels/Play/__tests__/Studio.queue.test.tsx` → FAIL.
- [ ] **Step 3: Implement in `Studio.tsx`:**

```tsx
// state, near `busy`:
const [queued, setQueued] = useState<string[]>([]);

// submit(): while busy, queue instead of dropping (replaces the busy early-return):
function submit() {
  if (!agentId) return;
  const text = input.trim();
  if (busy) {
    if (!text) return;
    setQueued((q) => [...q, text]);
    setInput("");
    return;                       // uploads stay send-time-only: attach when not busy (v1)
  }
  /* existing non-busy path unchanged */
}

// one place fires the queue — used by onDone and by the held-queue button:
const fireQueued = useCallback(() => {
  setQueued((q) => {
    if (q.length) void send(q.join("\n"));
    return [];
  });
}, [/* send's deps per the existing useCallback conventions in this file */]);

// stream onDone (inside send()): after the existing done work,
onDone: async (result) => {
  setBusy(false); setWorking("");
  if (result.stopReason === "cancelled")
    setMsgs((m) => [...m, { role: "tool", title: "⏹ interrupted" }]);
  await refresh();
  fireQueued();                    // coalesce-and-go; no-op when empty
},
// onFailed: leave the queue alone (held).

// interrupt(): POST the cancel; on network failure fall back to session-kill stop():
async function interrupt() {
  if (!chatId) return;
  try { await fetch(`${apiBase}/api/chat/${encodeURIComponent(chatId)}/cancel`, { method: "POST" }); }
  catch { setStatus("interrupt failed — stopping session"); await stop(); }
}

// JSX — textarea never disabled (drop `disabled={busy}`); Enter handler calls submit() as today.
// Button row: while busy show Interrupt in Stop's slot; Stop (session kill) only when idle:
{busy
  ? <button className="play-btn play-btn--ghost" onClick={() => void interrupt()} title="interrupt this turn — the session survives">Interrupt</button>
  : chatId && <button className="play-btn play-btn--ghost" onClick={stop} title="kill the agent session">Stop</button>}
// Send button while busy becomes the queue affordance:
<button className="play-btn play-btn--primary" disabled={!agentId || (!input.trim() && (!busy && up.uploads.length === 0))} onClick={submit}>
  {busy ? "Queue" : "Send"}
</button>
// Queue chips above the composer (reuse the staged-uploads chip styling in this file — grep
// `chip` in Studio.tsx and mirror; every className must already exist in the console styles):
{queued.length > 0 && (
  <div className="studio-queue">
    {queued.map((q, i) => (
      <span key={`${i}:${q}`} className="studio-queue__chip" title="queued — sends when the agent finishes">
        {q}
        <button aria-label={`remove queued message ${i + 1}`} onClick={() => setQueued((qs) => qs.filter((_, j) => j !== i))}>✕</button>
      </span>
    ))}
    {!busy && <button className="play-btn" onClick={fireQueued}>Send queued</button>}
  </div>
)}
```

Adapt to the file's real shapes (e.g. `send()`'s busy guard, the exact onDone body, the uploads-integrated submit) — the code above states the target behavior with this file's idioms; keep every existing behavior that isn't explicitly changed. **Styling rule:** if `studio-queue`/`studio-queue__chip` classes don't exist in the console stylesheet, add rules there in the same change, mirroring the existing chip/pill styles (grep first — reuse an existing chip class if one fits).

- [ ] **Step 4: Run** — the new file plus the whole Play test dir: `npx vitest run src/panels/Play/__tests__` → ALL PASS (durable-resume tests especially).
- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/__tests__/Studio.queue.test.tsx <stylesheet-if-touched>
git commit -m "feat(studio): type-while-busy message queue + turn Interrupt"
```

---

### Task 5: Chat tab composer — same pattern

**Files:**
- Modify: `packages/console/src/panels/Chat/index.tsx` (the `sending` state gates: textarea `disabled` ~line 258, send button ~line 266, `sendMessage` ~line 58; stream `onDone` handler)
- Test: `packages/console/src/panels/Chat/__tests__/Chat.queue.test.tsx` (new; mirror the existing Chat tests' harness — locate with `ls packages/console/src/panels/Chat/__tests__` and read one first)

**Interfaces:** identical contract to Task 4 (queue chips, coalesced auto-fire on done, held on failed, Interrupt via the cancel route, "interrupted" marker on `stopReason === "cancelled"`).

- [ ] **Step 1: Failing tests** — the same five behaviors as Task 4 Step 1, written against the Chat harness (its stream consumer is `openChatStream` from `./chatStream.js`; its busy flag is `sending`; its send is `sendMessage`).
- [ ] **Step 2: Run** — `npx vitest run src/panels/Chat/__tests__/Chat.queue.test.tsx` → FAIL.
- [ ] **Step 3: Implement** — port the Task 4 pattern onto this component's local names: `queued` state; `sendMessage` queues while `sending`; textarea loses `disabled={sending}` (keep the agents-null guards); Send shows "Queue" while sending; chips + removal + "Send queued"; `interrupt()` POSTs the cancel route with this component's apiBase convention (read how it builds URLs — it hardcodes; follow it); `onDone` marks interrupted + fires the queue. Reuse the exact same class names introduced/reused in Task 4.
- [ ] **Step 4: Run** — `npx vitest run src/panels/Chat` → ALL PASS.
- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Chat/index.tsx packages/console/src/panels/Chat/__tests__/Chat.queue.test.tsx
git commit -m "feat(chat-tab): type-while-busy queue + turn Interrupt"
```

---

### Task 6: deliver

- [ ] **Step 1:** Root suite: `pnpm test` at the worktree root → green (only known flakes acceptable). Console: `npx vitest run` + `npx tsc --noEmit` from `packages/console` → green.
- [ ] **Step 2:** Walk `docs/miniapps/spec.md` §10 — this feature touches the Studio surface but no miniapp capability; confirm no widening, T-invariants untouched, SKILL.md untouched (the authoring contract is unchanged).
- [ ] **Step 3:** Push, PR (reference the design spec; describe the queue/interrupt semantics and the cancel seam), `gh run watch <id> --exit-status`, `gh pr merge --rebase --delete-branch` (local delete errors are benign), then `git fetch` and grep `origin/main` for a marker from **every** commit (acpSession `session/cancel`, route `chat/:id/cancel`, `studioStream` `stopReason`, Studio `Interrupt`, Chat tab `Interrupt`). Remove the worktree.
