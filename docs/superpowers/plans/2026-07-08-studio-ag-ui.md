# PR E — AG-UI on the Studio Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Let external AG-UI clients (CopilotKit, LangGraph/CrewAI UIs) consume AgentGem's Studio authoring agent by emitting the standard **AG-UI event protocol** on the chat stream — additive, behind `?protocol=ag-ui`, leaving the existing native `ChatEvent` stream (and the internal Studio client) untouched (no parity risk).

**Architecture:** A pure, stateful mapper `createAguiMapper` translates the `ChatEvent` stream (`phase|delta|tool|done|failed` from `@agentgem/run`) into AG-UI events (`RUN_STARTED`, `TEXT_MESSAGE_START/CONTENT/END`, `TOOL_CALL_START/ARGS/END`, `RUN_FINISHED`, `RUN_ERROR`, `CUSTOM`). `GET /api/chat/stream?protocol=ag-ui` runs the mapper over `manager.sendMessage()` and emits AG-UI SSE (`data: {json}`, type inside the JSON — AG-UI's default encoding). Dependency-free (AG-UI event shapes hand-rolled to the documented protocol; a conformance test pins the event-type set + required fields).

**Tech Stack:** TypeScript ESM; Express SSE route (`src/goldmine/chatRoutes.ts`); Vitest (dist-run at repo root); `node:crypto` `randomUUID`.

## Global Constraints

- **Node >=24.** Copyright header not used in `src/goldmine` (match sibling files' style — a `//` path/description comment).
- **Tests run from COMPILED dist** at repo root: `pnpm exec tsc -b && pnpm exec vitest run dist/goldmine/__tests__/<x>.test.js`. Authoritative typecheck: `pnpm exec tsc -b --force`.
- **Additive only:** the default `/api/chat/stream` (no `protocol` or `protocol!=="ag-ui"`) behavior and the native `ChatEvent` SSE shape are UNCHANGED. The internal Studio client (`studioStream.ts`) keeps using native events.
- **AG-UI event `type` values (exact, from docs.ag-ui.com):** `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `CUSTOM`.
- Reuse `type ChatEvent` from `@agentgem/run` (`{type:"phase",phase} | {type:"delta",text} | {type:"tool",tool:{toolCallId,title,kind?,status?}} | {type:"done",result} | {type:"failed",error}`).

---

### Task 1: `aguiStream.ts` — ChatEvent → AG-UI mapper

**Files:**
- Create: `src/goldmine/aguiStream.ts`
- Test: `src/goldmine/__tests__/aguiStream.test.ts`

**Interface (Produces):**
```ts
export interface AguiEvent { type: string; [k: string]: unknown }
export interface AguiMapper {
  start(): AguiEvent[];                 // RUN_STARTED
  onChat(ev: ChatEvent): AguiEvent[];   // one ChatEvent → 0+ AG-UI events (incl done→RUN_FINISHED, failed→RUN_ERROR)
  error(message: string): AguiEvent[];  // transport-level RUN_ERROR (closes any open text msg first)
}
export function createAguiMapper(o: { threadId: string; runId: string; genId: () => string }): AguiMapper;
```

**Contract (state: an optionally-open assistant `textMsgId`):**
- `start()` → `[{type:"RUN_STARTED", threadId, runId}]`.
- `onChat`:
  - `delta` → open the text message on first delta (`{type:"TEXT_MESSAGE_START", messageId: genId(), role:"assistant"}`), then always `{type:"TEXT_MESSAGE_CONTENT", messageId, delta: ev.text}`.
  - `tool` → first close any open text msg (`TEXT_MESSAGE_END`), then `{type:"TOOL_CALL_START", toolCallId: ev.tool.toolCallId, toolCallName: ev.tool.title}`, then (if `kind`/`status` present) `{type:"TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify({kind, status})}`, then `{type:"TOOL_CALL_END", toolCallId}`.
  - `phase` → `[{type:"CUSTOM", name:"phase", value: ev.phase}]`.
  - `done` → close any open text msg, then `{type:"RUN_FINISHED", threadId, runId}`.
  - `failed` → close any open text msg, then `{type:"RUN_ERROR", message: ev.error}`.
- `error(message)` → close any open text msg, then `{type:"RUN_ERROR", message}`.

- [ ] **Step 1: Write tests** (`aguiStream.test.ts`), injecting a deterministic `genId` (e.g. a counter `m1,m2,…`):
  - A full sequence — `start()` then `onChat` over `[{delta,"He"},{delta,"llo"},{tool,{toolCallId:"t1",title:"Edit",kind:"write",status:"done"}},{delta,"done"},{done,result}]` — produces, in order: `RUN_STARTED`; `TEXT_MESSAGE_START(m1)`,`TEXT_MESSAGE_CONTENT(m1,"He")`,`TEXT_MESSAGE_CONTENT(m1,"llo")`; `TEXT_MESSAGE_END(m1)`,`TOOL_CALL_START(t1,"Edit")`,`TOOL_CALL_ARGS(t1)`,`TOOL_CALL_END(t1)`; `TEXT_MESSAGE_START(m2)`,`TEXT_MESSAGE_CONTENT(m2,"done")`; `TEXT_MESSAGE_END(m2)`,`RUN_FINISHED`. (Assert types + key fields in order.)
  - `failed` → `RUN_ERROR{message}` (and closes an open text msg first).
  - `phase` → `CUSTOM{name:"phase",value}`.
  - `error("boom")` after an open delta → `[TEXT_MESSAGE_END, RUN_ERROR{message:"boom"}]`.
  - Every emitted `type` is in the allowed AG-UI set (conformance).
- [ ] **Step 2: RED** — `pnpm exec tsc -b && pnpm exec vitest run dist/goldmine/__tests__/aguiStream.test.js`.
- [ ] **Step 3: Implement `aguiStream.ts`.**
- [ ] **Step 4: GREEN + `pnpm exec tsc -b --force`.**
- [ ] **Step 5: Commit** `feat(goldmine): AG-UI event mapper for the studio chat stream`.

---

### Task 2: wire `?protocol=ag-ui` into the chat stream route

**Files:**
- Modify: `src/goldmine/chatRoutes.ts` (`GET /api/chat/stream` — branch on `protocol`)
- Test: `src/goldmine/__tests__/chatRoutes.test.ts` (append; or a focused new test file if the route isn't covered there — check existing coverage first)

**Contract:** in the `GET /api/chat/stream` handler, after reading `chatId`/`message`:
```ts
if (String(req.query.protocol ?? "") === "ag-ui") {
  const mapper = createAguiMapper({ threadId: chatId, runId: randomUUID(), genId: () => randomUUID() });
  const emit = (e: AguiEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`); // AG-UI SSE: type is inside the JSON
  for (const e of mapper.start()) emit(e);
  try { for await (const ev of deps.manager.sendMessage(chatId, message)) for (const e of mapper.onChat(ev)) emit(e); }
  catch (e) { for (const ev of mapper.error((e as Error).message)) emit(ev); }
  res.end();
  return;
}
// ...unchanged native path below
```
`randomUUID` from `node:crypto`.

- [ ] **Step 1: Write a route test** (drive the handler with a fake `manager.sendMessage` async-gen yielding a couple ChatEvents; capture `res.write` calls). With `protocol=ag-ui`: assert the written SSE frames are `data: {json}` whose parsed `type`s begin with `RUN_STARTED` and end with `RUN_FINISHED`, and include `TEXT_MESSAGE_CONTENT`. WITHOUT `protocol`: assert the native `event: <type>\ndata: ...` frames are unchanged (a delta ChatEvent → `event: delta`). Match the existing chatRoutes test harness style (check `src/goldmine/__tests__/chatRoutes.test.ts` for how it fakes the manager + res).
- [ ] **Step 2: RED → implement → GREEN** (`pnpm exec tsc -b && pnpm exec vitest run dist/goldmine/__tests__/chatRoutes.test.js`) + `pnpm exec tsc -b --force`.
- [ ] **Step 3: Commit** `feat(goldmine): serve the studio stream as AG-UI via ?protocol=ag-ui`.

## Notes
- This is server-side emit only; a matching AG-UI *client* (or pointing CopilotKit at this endpoint) is a follow-up.
- State deltas (`STATE_SNAPSHOT`/`STATE_DELTA`) aren't modeled — the Studio agent has no shared-state surface yet; add if/when CoAgent-style shared state lands.
