import { describe, it, expect } from "vitest";
import { parseClaudeTranscript, parseCodexTranscript } from "../observeScan.js";

describe("scan captures per-session usage", () => {
  it("counts Claude tool_use by name, and pulls skill/subagent from Skill/Task inputs", () => {
    const text = [
      JSON.stringify({
        type: "assistant", timestamp: "2026-07-01T00:00:00Z", cwd: "/home/u/proj",
        message: {
          model: "claude-opus-4-8", content: [
            { type: "text", text: "working" },
            { type: "tool_use", name: "Read", input: { file_path: "a" } },
            { type: "tool_use", name: "Read", input: { file_path: "b" } },
            { type: "tool_use", name: "Skill", input: { skill: "brainstorming" } },
            { type: "tool_use", name: "Task", input: { subagent_type: "Explore" } },
            { type: "tool_use", name: "Agent", input: { subagent_type: "Explore" } },
          ],
        },
      }),
      JSON.stringify({ type: "user", timestamp: "2026-07-01T00:01:00Z", message: { content: "ok" } }),
    ].join("\n");

    const stat = parseClaudeTranscript(text, "/sessions/abc-123.jsonl");
    expect(stat?.tools).toEqual({ Read: 2, Skill: 1, Task: 1, Agent: 1 });
    expect(stat?.skills).toEqual({ brainstorming: 1 });
    expect(stat?.subagents).toEqual({ Explore: 2 }); // Task + Agent both count
  });

  it("counts Codex function_call names as tools", () => {
    const text = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-01T00:00:00Z", payload: { id: "cx1", cwd: "/home/u/proj" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-01T00:01:00Z", payload: { type: "function_call", name: "shell" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-01T00:02:00Z", payload: { type: "function_call", name: "shell" } }),
    ].join("\n");

    const stat = parseCodexTranscript(text, "/x.jsonl");
    expect(stat?.tools).toEqual({ shell: 2 });
    expect(stat?.skills).toBeUndefined();
  });

  it("omits the maps entirely when a session used no tools (lean back-compat)", () => {
    const text = JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:00Z", message: { content: "just text" } });
    const stat = parseClaudeTranscript(text, "/sessions/x.jsonl");
    expect(stat?.tools).toBeUndefined();
  });
});
