import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseClaudeTranscriptView, parseCodexTranscriptView, loadSessionTranscript, resolveClaudeSession,
  dehomeDistilled, type TranscriptView, type DistilledSkill,
} from "@agentgem/insight";

let home: string, claudeDir: string, codexDir: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "inspect-"));
  claudeDir = join(home, ".claude");
  codexDir = join(home, ".codex");
  const cproj = join(claudeDir, "projects", "proj-a");
  mkdirSync(cproj, { recursive: true });

  // Claude session with: user text, assistant text + tool_use, and a later
  // user record carrying the tool_result (must pair back, not become its own turn).
  // Includes a secret (sk- prefix) and a /Users/<name>/ path to exercise scrubbing.
  writeFileSync(join(cproj, "s1.jsonl"), [
    JSON.stringify({ type: "user", uuid: "u1", cwd: "/work/app", timestamp: "2026-06-28T10:00:00.000Z",
      message: { role: "user", content: "read /Users/alice/notes.txt" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", cwd: "/work/app", timestamp: "2026-06-28T10:00:05.000Z",
      message: { role: "assistant", model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "Reading it now" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/Users/alice/notes.txt", token: "sk-abcdefghijklmnop" } },
        ] } }),
    JSON.stringify({ type: "user", uuid: "u2", cwd: "/work/app", timestamp: "2026-06-28T10:00:06.000Z",
      message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "line one\nline two" },
      ] } }),
    "{ not json",
  ].join("\n") + "\n");

  // Codex session: session_meta + a message + a function_call paired with its output.
  const xdir = join(codexDir, "sessions", "2026", "06", "28");
  mkdirSync(xdir, { recursive: true });
  writeFileSync(join(xdir, "rollout-x1.jsonl"), [
    JSON.stringify({ type: "session_meta", timestamp: "2026-06-28T11:00:00.000Z", payload: { id: "x1", cwd: "/work/web" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-06-28T11:00:02.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-06-28T11:00:03.000Z",
      payload: { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"cmd\":\"ls\"}" } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-06-28T11:00:04.000Z",
      payload: { type: "function_call_output", call_id: "c1", output: "a.ts\nb.ts" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-06-28T11:05:00.000Z",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 80, reasoning_output_tokens: 20 } } } }),
  ].join("\n") + "\n");
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

function read(view: TranscriptView | null): TranscriptView {
  expect(view).not.toBeNull();
  return view!;
}

describe("parseClaudeTranscriptView", () => {
  const path = "/x/s1.jsonl"; // sessionId derives from filename basename
  let view: TranscriptView;
  beforeAll(() => {
    const text = [
      JSON.stringify({ type: "user", uuid: "u1", cwd: "/work/app", timestamp: "2026-06-28T10:00:00.000Z",
        message: { role: "user", content: "read /Users/alice/notes.txt" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-06-28T10:00:05.000Z",
        message: { role: "assistant", model: "claude-opus-4-8",
          usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
          content: [
            { type: "thinking", thinking: "" },
            { type: "text", text: "Reading it now" },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/Users/alice/notes.txt", token: "sk-abcdefghijklmnop" } },
          ] } }),
      JSON.stringify({ type: "user", uuid: "u2", timestamp: "2026-06-28T10:00:06.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "line one\nline two" }] } }),
    ].join("\n") + "\n";
    view = read(parseClaudeTranscriptView(text, path));
  });

  it("emits two turns: user text + assistant (tool_result folds into tool_use, not a 3rd turn)", () => {
    expect(view.agent).toBe("claude");
    expect(view.sessionId).toBe("s1");
    expect(view.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  });

  it("assistant turn carries text + tool_call span with paired output", () => {
    const a = view.turns[1];
    expect(a.spans).toHaveLength(2); // empty thinking dropped; text + tool_use
    expect(a.spans[0]).toMatchObject({ kind: "message", role: "assistant", text: "Reading it now" });
    const call = a.spans[1] as Extract<TranscriptSpanT, { kind: "tool_call" }>;
    expect(call.kind).toBe("tool_call");
    expect(call.name).toBe("Read");
    expect(call.output).toContain("line one");
  });

  it("per-turn tokens come from message.usage", () => {
    expect(view.turns[1].tokens).toEqual({ in: 100, out: 40, cache: 15 });
    expect(view.turns[0].tokens).toEqual({ in: 0, out: 0, cache: 0 }); // user: no usage
  });

  it("scrubs secrets and de-homes paths on the read path", () => {
    const call = view.turns[1].spans[1] as Extract<TranscriptSpanT, { kind: "tool_call" }>;
    expect(call.input).toContain("<redacted>");        // sk- token redacted
    expect(call.input).not.toContain("sk-abcdefghijklmnop");
    expect(call.input).not.toContain("/Users/alice/"); // de-homed to ~/
    expect(view.turns[0].spans[0]).toMatchObject({ text: expect.stringContaining("~/notes.txt") });
  });
});

type TranscriptSpanT = TranscriptView["turns"][number]["spans"][number];

describe("parseCodexTranscriptView", () => {
  it("emits a message turn + a function_call turn with paired output", () => {
    const text = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-06-28T11:00:00.000Z", payload: { id: "x1", cwd: "/work/web" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-06-28T11:00:02.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-06-28T11:00:03.000Z", payload: { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"cmd\":\"ls\"}" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-06-28T11:00:04.000Z", payload: { type: "function_call_output", call_id: "c1", output: "a.ts\nb.ts" } }),
    ].join("\n") + "\n";
    const view = read(parseCodexTranscriptView(text, "/x/rollout-x1.jsonl"));
    expect(view.agent).toBe("codex");
    expect(view.sessionId).toBe("x1");
    expect(view.turns).toHaveLength(2); // message + function_call (output folds in)
    expect(view.turns[0]).toMatchObject({ role: "user" });
    const call = view.turns[1].spans[0] as Extract<TranscriptSpanT, { kind: "tool_call" }>;
    expect(call.name).toBe("shell");
    expect(call.output).toContain("a.ts");
  });
});

describe("robustness", () => {
  it("returns null for an empty / meta-less transcript instead of throwing", () => {
    expect(parseClaudeTranscriptView("\n", "/x/empty.jsonl")).toBeNull();
    expect(parseCodexTranscriptView("garbage\n", "/x/rollout-y.jsonl")).toBeNull();
  });

  it("degrades unknown content items to text, never throws", () => {
    const text = JSON.stringify({ type: "assistant", uuid: "z", timestamp: "2026-06-28T10:00:00.000Z",
      message: { role: "assistant", content: [{ type: "future_block", text: "still shown" }] } }) + "\n";
    const view = read(parseClaudeTranscriptView(text, "/x/z.jsonl"));
    expect(view.turns[0].spans[0]).toMatchObject({ kind: "message", text: "still shown" });
  });
});

describe("loadSessionTranscript", () => {
  it("resolves a Claude session by filename id", async () => {
    const view = read(await loadSessionTranscript("s1", "claude", { claudeDir, codexDir }));
    expect(view.sessionId).toBe("s1");
    expect(view.turns.length).toBeGreaterThan(0);
  });

  it("resolves a Codex session by scanning session_meta ids", async () => {
    const view = read(await loadSessionTranscript("x1", "codex", { claudeDir, codexDir }));
    expect(view.sessionId).toBe("x1");
  });

  it("returns null for a missing session without throwing", async () => {
    expect(await loadSessionTranscript("nope", "claude", { claudeDir, codexDir })).toBeNull();
    expect(await loadSessionTranscript("nope", "codex", { claudeDir, codexDir })).toBeNull();
  });
});

describe("resolveClaudeSession (distill hook seam)", () => {
  it("returns the transcript path and the RAW cwd for distillation", async () => {
    const found = await resolveClaudeSession("s1", { claudeDir });
    expect(found).not.toBeNull();
    expect(found!.path.endsWith("s1.jsonl")).toBe(true);
    expect(found!.cwd).toBe("/work/app"); // raw, un-de-homed — needed to resolve the project
  });

  it("returns null for a missing session", async () => {
    expect(await resolveClaudeSession("nope", { claudeDir })).toBeNull();
  });
});

describe("dehomeDistilled (distill response privacy)", () => {
  const draft = (root: string): DistilledSkill => ({
    name: "do-thing", description: "d", triggers: ["t"], tools: ["Read"], mutating: false, body: "b",
    evidence: { sessions: 1, exampleSequence: ["Read"], root, provenance: { occurrences: [] } },
    status: "draft", confidence: "low", origin: "heuristic",
  });

  it("de-homes the absolute project root so the username never reaches the client", () => {
    const [out] = dehomeDistilled([draft("/Users/alice/Projects/secret-app")]);
    expect(out.evidence.root).toBe("~/Projects/secret-app");
    expect(out.evidence.root).not.toContain("/Users/alice");
  });

  it("leaves an already-relative root untouched", () => {
    expect(dehomeDistilled([draft("~/Projects/app")])[0].evidence.root).toBe("~/Projects/app");
  });
});
