// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The Claude source scans EVERY *.jsonl under ~/.claude/projects, while the Codex and
// Gemini sources prefix-filter their own stores. That tree is the one third-party tooling
// writes into, so plugins and tools drop their own .jsonl logs beside the transcripts. Any
// of them carrying a per-row `timestamp` used to parse into a phantom session — inflating
// the session count and feeding arbitrary timestamps into the startMs/endMs extrema behind
// the reveal's "N days".
//
// A real transcript is identified by having at least one user/assistant turn, NOT by its
// filename: a `<uuid>.jsonl` + `agent-<hex>.jsonl` allowlist would go stale the moment
// Claude renames anything and would then silently drop real sessions.
import { describe, it, expect } from "vitest";
import { parseClaudeTranscript } from "../observeScan.js";

const noNormalize = (c: string) => c;
const parse = (rows: object[], name = "/p/0f9c1a2b-3d4e-5f60-7a81-92b3c4d5e6f7.jsonl") =>
  parseClaudeTranscript(rows.map((r) => JSON.stringify(r)).join("\n"), name, noNormalize);

describe("foreign .jsonl files in the Claude projects tree are not sessions", () => {
  it("rejects a hook's skill-injections log, whose every row has a timestamp", () => {
    // Verbatim record shape from a real store — it is why the count was inflated.
    expect(parse([
      { timestamp: "2026-03-28T05:45:09.357Z", event: "inject", hookEvent: "UserPromptSubmit", matchedSkills: [], injectedSkills: [] },
      { timestamp: "2026-03-28T05:46:09.357Z", event: "inject", hookEvent: "UserPromptSubmit", matchedSkills: [], injectedSkills: [] },
    ], "/p/skill-injections.jsonl")).toBeNull();
  });

  it("rejects a workflow run's journal", () => {
    expect(parse([
      { type: "agent-start", key: "review:bugs", agentId: "a1", timestamp: "2026-07-28T00:00:00.000Z" },
      { type: "agent-end", key: "review:bugs", agentId: "a1", timestamp: "2026-07-28T00:05:00.000Z" },
    ], "/p/journal.jsonl")).toBeNull();
  });

  it("accepts a real transcript regardless of what the file is called", () => {
    // The rule must not depend on the filename: a subagent transcript is named
    // `agent-<hex>.jsonl`, and about half the files in a real store are that shape.
    const rows = [
      { type: "user", cwd: "/proj", timestamp: "2026-07-28T00:00:00.000Z", message: { content: "hi" } },
      { type: "assistant", timestamp: "2026-07-28T00:01:00.000Z", message: { model: "claude-x", content: [{ type: "text", text: "ok" }] } },
    ];
    expect(parse(rows, "/p/agent-acfef51fd05d86cf5.jsonl")?.sessionId).toBe("agent-acfef51fd05d86cf5");
    expect(parse(rows)?.msgs).toBe(2);
  });

  it("rejects a timestamped file that only ever describes tool activity, never a turn", () => {
    // The discriminator is a user/assistant turn — not merely "has records with usage".
    expect(parse([
      { timestamp: "2026-07-28T00:00:00.000Z", type: "summary", summary: "a prior session" },
      { timestamp: "2026-07-28T00:01:00.000Z", type: "system", subtype: "hook_result" },
    ], "/p/some-tool.jsonl")).toBeNull();
  });
});
