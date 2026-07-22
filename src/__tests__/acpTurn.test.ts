import { describe, it, expect } from "vitest";
import { promptRun, turnEvents, type TurnEvent } from "@agentgem/base";

const fakeSession = {
  async prompt(_text: string, onUpdate: (u: unknown) => void) {
    onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi " } });
    onUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "pending" });
    onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" } });
    return "end_turn";
  },
};

describe("promptRun", () => {
  it("folds updates into a RunResult with merged tool statuses", async () => {
    const deltas: string[] = [];
    const result = await promptRun(fakeSession, "q", { onDelta: (c) => deltas.push(c) });
    expect(result.text).toBe("hi there");
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls).toEqual([{ toolCallId: "t1", title: "Read", kind: undefined, status: "completed" }]);
    expect(deltas).toEqual(["hi ", "there"]);
  });
});

describe("turnEvents", () => {
  it("yields deltas and tools live, then done", async () => {
    const seen: TurnEvent[] = [];
    for await (const ev of turnEvents((onDelta, onToolCall) => promptRun(fakeSession, "q", { onDelta, onToolCall }))) seen.push(ev);
    expect(seen.map((e) => e.type)).toEqual(["delta", "tool", "delta", "done"]);
  });
  it("yields failed when the turn rejects", async () => {
    const seen: TurnEvent[] = [];
    for await (const ev of turnEvents(async () => { throw new Error("boom"); })) seen.push(ev);
    expect(seen).toEqual([{ type: "failed", error: "boom" }]);
  });
});
