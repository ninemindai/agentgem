// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseAtifDocument, flattenAtifContent, parseAtifMeta, atifSessionEvents } from "@agentgem/insight";

const MIN_DOC = JSON.stringify({
  schema_version: "ATIF-v1.7",
  session_id: "sess-1",
  agent: { name: "harbor-agent", version: "1.0.0", model_name: "gemini-2.5-flash" },
  steps: [
    { step_id: 1, source: "user", message: "What is the price of GOOGL?", timestamp: "2026-07-01T10:00:00Z" },
    {
      step_id: 2, source: "agent", message: "Searching.", timestamp: "2026-07-01T10:00:05Z",
      tool_calls: [{ tool_call_id: "call_1", function_name: "financial_search", arguments: { ticker: "GOOGL" } }],
      observation: { results: [{ source_call_id: "call_1", content: "GOOGL is at $185.35" }] },
      metrics: { prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 400 },
    },
  ],
  final_metrics: { total_prompt_tokens: 1120, total_completion_tokens: 124 },
});

describe("parseAtifDocument", () => {
  it("parses a minimal v1.x trajectory", () => {
    const doc = parseAtifDocument(MIN_DOC);
    expect(doc).not.toBeNull();
    expect(doc!.schema_version).toBe("ATIF-v1.7");
    expect(doc!.steps).toHaveLength(2);
    expect(doc!.steps[1].tool_calls?.[0].function_name).toBe("financial_search");
  });

  it("degrades to null on junk, wrong schema_version, or missing steps", () => {
    expect(parseAtifDocument("not json")).toBeNull();
    expect(parseAtifDocument(JSON.stringify({ schema_version: "OTHER-v1", agent: { name: "x", version: "1" }, steps: [] }))).toBeNull();
    expect(parseAtifDocument(JSON.stringify({ schema_version: "ATIF-v1.7", agent: { name: "x", version: "1" } }))).toBeNull();
  });

  it("flattens string and multimodal message content", () => {
    expect(flattenAtifContent("hello")).toBe("hello");
    expect(flattenAtifContent([{ type: "text", text: "a" }, { type: "image", source: { media_type: "image/png", path: "x.png" } }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(flattenAtifContent(undefined)).toBe("");
  });
});

describe("parseAtifMeta", () => {
  it("folds a trajectory into a SessionStat", () => {
    const s = parseAtifMeta(MIN_DOC, "/tmp/atif/sess-1.json");
    expect(s).toMatchObject({
      agent: "atif", sessionId: "sess-1", model: "gemini-2.5-flash",
      msgs: 2, tokensIn: 720, tokensOut: 124, tokensCache: 400,
    });
    expect(s!.startMs).toBe(Date.parse("2026-07-01T10:00:00Z"));
    expect(s!.endMs).toBe(Date.parse("2026-07-01T10:00:05Z"));
  });

  it("prefers trajectory_id over session_id, falls back to filename; 0-timestamps when absent", () => {
    const doc = JSON.parse(MIN_DOC);
    doc.trajectory_id = "traj-9";
    delete doc.steps[0].timestamp; delete doc.steps[1].timestamp;
    const s = parseAtifMeta(JSON.stringify(doc), "/tmp/atif/whatever.json");
    expect(s!.sessionId).toBe("traj-9");
    expect(s!.startMs).toBe(0);
    delete doc.trajectory_id; delete doc.session_id;
    expect(parseAtifMeta(JSON.stringify(doc), "/tmp/atif/fallback-name.json")!.sessionId).toBe("fallback-name");
  });

  it("sums per-step metrics when final_metrics is absent", () => {
    const doc = JSON.parse(MIN_DOC);
    delete doc.final_metrics;
    const s = parseAtifMeta(JSON.stringify(doc), "/tmp/x.json");
    expect(s).toMatchObject({ tokensIn: 600, tokensOut: 100, tokensCache: 400 }); // 1000-400, 100, 400
  });

  it("returns null for non-ATIF text", () => {
    expect(parseAtifMeta("{}", "/tmp/x.json")).toBeNull();
  });
});

describe("atifSessionEvents", () => {
  it("emits ordered message / tool_call / tool_result events", () => {
    const events = atifSessionEvents(MIN_DOC, "/tmp/atif/sess-1.json");
    const kinds = events.map((e) => e.span.kind);
    expect(kinds).toEqual(["message", "message", "tool_call", "tool_result"]);
    const call = events[2].span as { kind: "tool_call"; toolId: string | null; name: string; input: string };
    expect(call.name).toBe("financial_search");
    expect(call.toolId).toBe("call_1");
    const result = events[3].span as { kind: "tool_result"; toolId: string | null; output: string };
    expect(result.toolId).toBe("call_1");
    expect(result.output).toContain("185.35");
  });

  it("skips system steps and emits reasoning as an assistant message", () => {
    const doc = JSON.parse(MIN_DOC);
    doc.steps.unshift({ step_id: 0, source: "system", message: "sys prompt" });
    doc.steps[2].reasoning_content = "thinking about it";
    const events = atifSessionEvents(JSON.stringify(doc), "/tmp/x.json");
    expect(events.some((e) => e.span.kind === "message" && (e.span as { text: string }).text === "sys prompt")).toBe(false);
    expect(events.some((e) => e.span.kind === "message" && (e.span as { text: string }).text.includes("thinking about it"))).toBe(true);
  });
});
