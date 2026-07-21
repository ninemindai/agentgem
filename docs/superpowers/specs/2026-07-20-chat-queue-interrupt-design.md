# Chat queue + turn interrupt — design

**Problem.** While an ACP agent turn is in flight, both composers (Play Studio and the
goldmine Chat tab) disable the textarea, and the only recovery is "Stop", which kills the
whole chat session (`DELETE /api/chat/:id`). Users can neither stack corrections while the
agent works nor redirect it without losing the session.

**Decisions (brainstormed 2026-07-20, approved):**
- Scope: **both** surfaces — Studio and the Chat tab share `/api/chat` + `chatSession`.
- Queueing: typed messages queue client-side while busy and **coalesce into one next turn**
  (newline-joined), shown as removable pending chips until they fire.
- Interrupt: **interrupt-and-redirect** — cancel the in-flight turn via ACP
  `session/cancel`; the session stays alive; a non-empty queue fires immediately as the
  next turn. Empty queue → just unlock.
- Approach: thin server cancel seam + client-owned queue (rejected: server-side queue —
  multi-tab/fire-unwatched complexity; client-only SSE abort — cosmetic interrupt, agent
  keeps burning tokens).

## Server: the cancel seam

The chain, bottom-up (every layer already exists; each gains one small member):

1. **`packages/base/src/acpSession.ts`** — the raw session (from `connectAcpAdapter().open()`)
   gains `cancel(): void` → `void agentCtx.notify("session/cancel", { sessionId })`
   (typed in the ACP SDK; a notification, never awaited against the turn). Per the ACP
   spec the agent may still emit final updates, then the in-flight prompt ends with a
   `stop` message. `prompt()` now **returns the stop message's `stopReason`**
   (`string | undefined`) instead of discarding it at `break`.
2. **`packages/run/src/acpRun.ts`** — `RunResult` gains `stopReason?: string`; both
   wrappers (`connectRunSession`, and `makeChatConnectFn` in
   `packages/app/src/goldmine/chatRoutes.ts`) set it from the base prompt's return.
3. **`packages/run/src/chatSession.ts`** — `ChatSessionHandle` gains **optional**
   `cancel?(): void` (optional keeps fakes/other implementors compiling); the module
   gains `cancelChat(chatId: string): boolean` — returns false unless the chat exists
   and is `running`, else calls `chat.handle.cancel?.()` and returns true. The running
   turn's own event loop finishes naturally; its `done` event now carries
   `stopReason` from the result. **Turn-end checkpointing still runs after a cancelled
   turn** — durable WIP is the point of checkpoints.
4. **`packages/app/src/goldmine/chatRoutes.ts`** — new route
   `POST /api/chat/:id/cancel` → `{ cancelled: boolean }`; unknown id → 404; idle chat
   → `{ cancelled: false }` (interrupting an already-finished turn is a no-op, never an
   error). The SSE `done` event forwards `stopReason`.

Race semantics: cancel vs natural end is resolved by the turn's own stream — whichever
`done` arrives is authoritative; `stopReason === "cancelled"` is the only signal clients
use to render "interrupted". No new server state.

## Client: queue + interrupt (same pattern, both composers)

- **The textarea is never disabled.** While `busy`, Enter/Send appends to
  `queued: string[]` (component state) rendered as removable chips above the composer
  ("queued — sends when the agent finishes"). Chips are removable until they fire.
- **Auto-fire:** on turn end (`onDone`): if `queued` is non-empty, coalesce
  (`queued.join("\n")`) into one `send()` and clear the queue. On `onFailed`: **hold**
  the queue (never auto-fire into a broken session) and show a "send queued" affordance.
- **Interrupt:** while `busy` the Stop button's slot shows **Interrupt** →
  `POST /api/chat/:id/cancel`; the stream's `done(stopReason: "cancelled")` unlocks and
  the transcript marks the turn "⏹ interrupted"; a non-empty queue then auto-fires
  (redirect). If the cancel POST itself fails, fall back to the existing session-kill
  `stop()` with a status note. Session-kill remains available when idle (unchanged
  semantics, existing title).
- **`studioStream.ts`** (and the Chat tab's stream consumer) pass `stopReason` through
  `onDone`.
- Queue is in-memory (v1): a reload drops unsent chips. Documented; `studioChatStore`
  persistence is a follow-up if it ever bites.

## Error handling

- Cancel racing natural completion → server no-ops (`cancelled: false`), client renders
  whatever the stream said.
- Agent adapter without cancel support: the notification is fire-and-forget; if the turn
  doesn't end, the user still has session-kill (unchanged escape hatch).
- Queue + interrupt + failed cancel → queue held, composer unlocked only by stream end or
  session-kill (today's semantics).

## Testing

- **Root (CI-gated):** `chatSession` — cancel mid-turn against a fake handle (done event
  carries `stopReason: "cancelled"`, `running` cleared, checkpoint ran); `cancelChat` on
  idle/unknown chat; route test — 404 / `{cancelled:false}` idle / `{cancelled:true}`
  running. Base: `acpSession.prompt` returns the stop reason (fake stop message).
- **Console (jsdom, local):** type-while-busy queues chips; chip removal; done →
  coalesced auto-send (one send, newline-joined); failed → queue held + affordance;
  Interrupt calls the cancel route and the queue fires on the cancelled done;
  interrupted turn marked in transcript. Existing durable-resume tests stay green.
