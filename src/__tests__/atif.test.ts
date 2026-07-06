// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseAtifDocument, flattenAtifContent } from "@agentgem/insight";

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
