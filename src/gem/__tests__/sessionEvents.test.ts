import { describe, it, expect } from "vitest";
import { claudeSessionEvents, codexSessionEvents, type SessionEvent } from "@agentgem/insight";

// A Claude transcript with: a user message, an assistant text + tool_use (Read),
// then — in a LATER user record — the tool_result. The live feed must keep the
// call and result as two separate ordered events (unfolded). Includes an sk- token
// and a /Users/<name>/ path to prove the scrub boundary carries over.
const claudeText =
  [
    JSON.stringify({
      type: "user", uuid: "u1", timestamp: "2026-06-28T10:00:00.000Z",
      message: { role: "user", content: "read /Users/alice/notes.txt" },
    }),
    JSON.stringify({
      type: "assistant", uuid: "a1", timestamp: "2026-06-28T10:00:05.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "Reading it now" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/Users/alice/notes.txt", token: "sk-abcdefghijklmnop" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user", uuid: "u2", timestamp: "2026-06-28T10:00:06.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "line one\nline two" }] } }),
  ].join("\n") + "\n";

const kinds = (ev: SessionEvent[]) => ev.map((e) => e.span.kind);

describe("claudeSessionEvents", () => {
  it("flattens a transcript into ordered events, tool_call and tool_result kept separate", () => {
    const ev = claudeSessionEvents(claudeText, "/x/s1.jsonl");
    // user msg, assistant msg, tool_call, tool_result — empty thinking dropped.
    expect(kinds(ev)).toEqual(["message", "message", "tool_call", "tool_result"]);
    expect(ev[0].span).toMatchObject({ kind: "message", role: "user" });
    expect(ev[1].span).toMatchObject({ kind: "message", role: "assistant", text: "Reading it now" });
    expect(ev[2].span).toMatchObject({ kind: "tool_call", toolId: "toolu_1", name: "Read" });
    expect(ev[3].span).toMatchObject({ kind: "tool_result", toolId: "toolu_1", error: false });
    expect((ev[3].span as { output: string }).output).toContain("line one");
  });

  it("scrubs secrets and de-homes paths in the event stream", () => {
    const ev = claudeSessionEvents(claudeText, "/x/s1.jsonl");
    const call = ev[2].span as { input: string };
    expect(call.input).toContain("<redacted>");
    expect(call.input).not.toContain("sk-abcdefghijklmnop");
    expect(call.input).not.toContain("/Users/alice/");
    expect((ev[0].span as { text: string }).text).toContain("~/notes.txt");
  });

  it("returns [] for a non-transcript", () => {
    expect(claudeSessionEvents("not json\n", "/x/s1.jsonl")).toEqual([]);
  });
});

// A Codex rollout: session_meta + a user message + a function_call paired with its
// output in a LATER record. Same unfolded-events contract as Claude.
const codexText =
  [
    JSON.stringify({ type: "session_meta", timestamp: "2026-06-28T11:00:00.000Z", payload: { id: "x1", cwd: "/work/web" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-06-28T11:00:02.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-06-28T11:00:03.000Z", payload: { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"cmd\":\"ls\"}" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-06-28T11:00:04.000Z", payload: { type: "function_call_output", call_id: "c1", output: "a.ts\nb.ts" } }),
  ].join("\n") + "\n";

describe("codexSessionEvents", () => {
  it("flattens a rollout into ordered events, function_call and output kept separate", () => {
    const ev = codexSessionEvents(codexText, "/x/rollout-x1.jsonl");
    expect(kinds(ev)).toEqual(["message", "tool_call", "tool_result"]);
    expect(ev[0].span).toMatchObject({ kind: "message", role: "user", text: "hello codex" });
    expect(ev[1].span).toMatchObject({ kind: "tool_call", toolId: "c1", name: "shell" });
    expect(ev[2].span).toMatchObject({ kind: "tool_result", toolId: "c1" });
    expect((ev[2].span as { output: string }).output).toContain("a.ts");
  });

  it("returns [] for a non-transcript", () => {
    expect(codexSessionEvents("not json\n", "/x/rollout-x1.jsonl")).toEqual([]);
  });
});
