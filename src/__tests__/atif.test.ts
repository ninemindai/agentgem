// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAtifDocument, flattenAtifContent, parseAtifMeta, atifSessionEvents, parseAtifTranscriptView, loadSessionTranscript, atifSource, BUILTIN_SOURCES, watchableSources, sessionToAtif, scanAtifSessions, summarizeDiagnostics, isFileRejection, groupDiagnostics, scanAtifHealth, type AtifDiagnostics } from "@agentgem/insight";

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

describe("parseAtifTranscriptView", () => {
  it("builds turns with tool outputs paired onto tool_call spans", () => {
    const view = parseAtifTranscriptView(MIN_DOC, "/tmp/atif/sess-1.json");
    expect(view).not.toBeNull();
    expect(view!.agent).toBe("atif");
    expect(view!.sessionId).toBe("sess-1");
    expect(view!.turns).toHaveLength(2);
    const agentTurn = view!.turns[1];
    expect(agentTurn.role).toBe("assistant");
    const call = agentTurn.spans.find((s) => s.kind === "tool_call") as { kind: "tool_call"; name: string; output?: string };
    expect(call.name).toBe("financial_search");
    expect(call.output).toContain("185.35");
    expect(agentTurn.tokens).toEqual({ in: 600, out: 100, cache: 400 });
  });
});

describe("loadSessionTranscript (atif)", () => {
  it("resolves a dropped trajectory by sessionId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgem-atif-"));
    try {
      writeFileSync(join(dir, "sess-1.json"), MIN_DOC);
      const view = await loadSessionTranscript("sess-1", "atif", { atifDir: dir });
      expect(view?.sessionId).toBe("sess-1");
      expect(await loadSessionTranscript("nope", "atif", { atifDir: dir })).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("sessionToAtif", () => {
  it("round-trips: view → ATIF → parseable trajectory with same session id and step count", () => {
    const view = parseAtifTranscriptView(MIN_DOC, "/tmp/atif/sess-1.json")!;
    const doc = sessionToAtif(view);
    expect(doc.schema_version).toBe("ATIF-v1.7");
    expect(doc.session_id).toBe("sess-1");
    expect(doc.steps.map((s) => s.step_id)).toEqual([1, 2]);       // sequential from 1
    expect(doc.steps[0].source).toBe("user");
    expect(doc.steps[1].tool_calls![0].function_name).toBe("financial_search");
    expect(doc.steps[1].observation!.results[0].content).toContain("185.35");
    expect(doc.final_metrics!.total_completion_tokens).toBe(124);  // from view.meta (parseAtifMeta of MIN_DOC)
    const rt = parseAtifTranscriptView(JSON.stringify(doc), "/tmp/rt.json");
    expect(rt!.turns).toHaveLength(view.turns.length);
  });
});

describe("atif import diagnostics", () => {
  const codesFor = (text: string, path = "/tmp/atif/x.json") => {
    const diags: AtifDiagnostics = [];
    parseAtifDocument(text, path, diags);
    return diags.map((d) => d.code);
  };

  it("distinguishes all five whole-file rejection reasons", () => {
    expect(codesFor("not json")).toEqual(["invalid_json"]);
    expect(codesFor("[1,2,3]")).toEqual(["not_an_object"]);
    expect(codesFor(JSON.stringify({ schema_version: "OTHER-v1", agent: { name: "x", version: "1" }, steps: [{}] }))).toEqual(["unknown_schema_version"]);
    expect(codesFor(JSON.stringify({ schema_version: "ATIF-v1.7", steps: [{}] }))).toEqual(["missing_agent"]);
    expect(codesFor(JSON.stringify({ schema_version: "ATIF-v1.7", agent: { name: "x", version: "1" }, steps: [] }))).toEqual(["no_steps"]);
  });

  it("records nothing for a well-formed trajectory", () => {
    const diags: AtifDiagnostics = [];
    expect(parseAtifMeta(MIN_DOC, "/tmp/atif/sess-1.json", diags)).not.toBeNull();
    expect(atifSessionEvents(MIN_DOC, "/tmp/atif/sess-1.json", diags)).toHaveLength(4);
    expect(diags).toEqual([]);
  });

  it("reports a foreign format's version verbatim, but only when it is identifier-shaped", () => {
    const foreign = (v: unknown) => {
      const diags: AtifDiagnostics = [];
      parseAtifDocument(JSON.stringify({ schema_version: v, agent: { name: "x", version: "1" }, steps: [{}] }), "/tmp/x.json", diags);
      return diags[0];
    };
    // The motivating case: someone drops a Letta trajectory-v1 file in the ATIF dir.
    expect(foreign("trajectory-v1")).toMatchObject({ code: "unknown_schema_version", schemaVersion: "trajectory-v1" });
    // Anything that is not a bare identifier is omitted rather than truncated.
    expect(foreign("v1 <script>alert(1)</script>").schemaVersion).toBeUndefined();
    expect(foreign("x".repeat(200)).schemaVersion).toBeUndefined();
    expect(foreign(42).schemaVersion).toBeUndefined();
  });

  it("flags a trajectory whose steps carry no parseable timestamp", () => {
    const doc = JSON.parse(MIN_DOC);
    delete doc.steps[0].timestamp; delete doc.steps[1].timestamp;
    const diags: AtifDiagnostics = [];
    const s = parseAtifMeta(JSON.stringify(doc), "/tmp/atif/no-ts.json", diags);
    expect(s!.startMs).toBe(0);                                   // the mtime fallback fires
    expect(diags).toEqual([{ code: "timestamps_missing", path: "/tmp/atif/no-ts.json" }]);
  });

  it("flags observation results that cannot be paired with their call", () => {
    const doc = JSON.parse(MIN_DOC);
    delete doc.steps[1].observation.results[0].source_call_id;
    const diags: AtifDiagnostics = [];
    atifSessionEvents(JSON.stringify(doc), "/tmp/atif/orphan.json", diags);
    expect(diags).toEqual([{ code: "orphan_tool_result", path: "/tmp/atif/orphan.json", stepId: 2 }]);
  });

  it("collapses repeats of one code into a count instead of one entry each", () => {
    const doc = JSON.parse(MIN_DOC);
    doc.steps[1].observation.results = Array.from({ length: 400 }, () => ({ content: "x" }));
    const diags: AtifDiagnostics = [];
    atifSessionEvents(JSON.stringify(doc), "/tmp/atif/many.json", diags);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: "orphan_tool_result", stepId: 2, count: 400 });
  });

  it("never carries transcript content", () => {
    // Every string in the doc is a distinctive marker; none may reach a diagnostic.
    const doc = JSON.parse(MIN_DOC);
    doc.schema_version = "NOTATIF";
    doc.steps[0].message = "SECRET_MESSAGE_MARKER";
    doc.steps[1].tool_calls[0].arguments = { ticker: "SECRET_ARG_MARKER" };
    doc.steps[1].observation.results[0].content = "SECRET_RESULT_MARKER";
    const diags: AtifDiagnostics = [];
    parseAtifDocument(JSON.stringify(doc), "/tmp/atif/secret.json", diags);
    doc.schema_version = "ATIF-v1.7";                             // now let it parse, so step-scoped codes fire too
    delete doc.steps[1].observation.results[0].source_call_id;
    delete doc.steps[0].timestamp; delete doc.steps[1].timestamp;
    parseAtifMeta(JSON.stringify(doc), "/tmp/atif/secret.json", diags);
    atifSessionEvents(JSON.stringify(doc), "/tmp/atif/secret.json", diags);
    expect(diags.length).toBeGreaterThan(1);
    const serialized = JSON.stringify(diags);
    for (const marker of ["SECRET_MESSAGE_MARKER", "SECRET_ARG_MARKER", "SECRET_RESULT_MARKER"]) {
      expect(serialized).not.toContain(marker);
    }
  });

  it("summarizes by code with a bounded path sample", () => {
    const diags: AtifDiagnostics = [
      { code: "invalid_json", path: "/a.json" },
      { code: "invalid_json", path: "/b.json" },
      { code: "invalid_json", path: "/c.json" },
      { code: "invalid_json", path: "/d.json" },
      { code: "orphan_tool_result", path: "/e.json", stepId: 2, count: 7 },
    ];
    const lines = summarizeDiagnostics(diags);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("invalid_json: 4 occurrence(s) across 4 rejected file(s)");
    expect(lines[0]).toContain("(+1 more)");                      // 3 paths shown, 1 elided
    expect(lines[1]).toContain("orphan_tool_result: 7 occurrence(s) across 1 degraded file(s)");
    expect(isFileRejection("invalid_json")).toBe(true);
    expect(isFileRejection("orphan_tool_result")).toBe(false);
  });

  it("scanAtifSessions surfaces the files it silently skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgem-atif-diag-"));
    try {
      writeFileSync(join(dir, "good.json"), MIN_DOC);
      writeFileSync(join(dir, "junk.json"), "not a trajectory");
      writeFileSync(join(dir, "foreign.json"), JSON.stringify({ schema_version: "trajectory-v1", agent: { name: "x", version: "1" }, steps: [{}] }));
      const { stats, diagnostics } = await scanAtifSessions([join(dir, "good.json"), join(dir, "junk.json"), join(dir, "foreign.json")]);
      expect(stats).toHaveLength(1);
      expect(diagnostics.map((d) => d.code).sort()).toEqual(["invalid_json", "unknown_schema_version"]);
      expect(diagnostics.find((d) => d.code === "unknown_schema_version")).toMatchObject({ schemaVersion: "trajectory-v1" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("atifSource", () => {
  it("is registered and watchable", () => {
    expect(BUILTIN_SOURCES.some((s) => s.id === "atif")).toBe(true);
    expect(watchableSources().some((s) => s.id === "atif")).toBe(true);
  });

  it("scans a drop dir and backfills mtime when the trajectory has no timestamps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgem-atif-src-"));
    try {
      const noTs = JSON.parse(MIN_DOC);
      delete noTs.steps[0].timestamp; delete noTs.steps[1].timestamp;
      writeFileSync(join(dir, "sess-1.json"), JSON.stringify(noTs));
      writeFileSync(join(dir, "junk.json"), "not a trajectory");
      const stats = await atifSource.scanSessions!(atifSource.roots({ baseDir: dir }));
      expect(stats).toHaveLength(1);
      const mtime = statSync(join(dir, "sess-1.json")).mtimeMs;
      expect(stats[0].startMs).toBeCloseTo(mtime, -2);
      expect(stats[0].endMs).toBeCloseTo(mtime, -2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("groupDiagnostics", () => {
  it("groups by code, reduces paths to basenames, sums occurrences, and orders rejections first", () => {
    const groups = groupDiagnostics([
      { code: "orphan_tool_result", path: "/drop/partial.json", stepId: 2, count: 40 },
      { code: "unknown_schema_version", path: "/drop/conv-1.json", schemaVersion: "trajectory-v1" },
      { code: "unknown_schema_version", path: "/drop/conv-2.json" },
    ]);
    // rejections (unknown_schema_version) come before degradations (orphan_tool_result)
    expect(groups.map((g) => g.code)).toEqual(["unknown_schema_version", "orphan_tool_result"]);

    const rej = groups[0];
    expect(rej.rejection).toBe(true);
    expect(rej.occurrences).toBe(2);                       // two diagnostics, no counts → 1 + 1
    expect(rej.files).toEqual([{ name: "conv-1.json" }, { name: "conv-2.json" }]); // basenames, no absolute paths

    const deg = groups[1];
    expect(deg.rejection).toBe(false);
    expect(deg.occurrences).toBe(40);                      // count honoured
    expect(deg.files).toEqual([{ name: "partial.json", detail: "step 2" }]);
  });

  it("collapses the same file+step but keeps distinct steps of one file", () => {
    const [g] = groupDiagnostics([
      { code: "orphan_tool_result", path: "/drop/a.json", stepId: 1 },
      { code: "orphan_tool_result", path: "/drop/a.json", stepId: 1 },
      { code: "orphan_tool_result", path: "/drop/a.json", stepId: 3 },
    ]);
    expect(g.files).toEqual([{ name: "a.json", detail: "step 1" }, { name: "a.json", detail: "step 3" }]);
    expect(g.occurrences).toBe(3);
  });

  it("returns an empty array for no diagnostics", () => {
    expect(groupDiagnostics([])).toEqual([]);
  });
});

describe("scanAtifHealth", () => {
  it("reports totals and grouped issues for a mixed drop dir, with no absolute paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgem-atif-health-"));
    try {
      writeFileSync(join(dir, "good.json"), MIN_DOC);
      writeFileSync(join(dir, "junk.json"), "not a trajectory");
      writeFileSync(join(dir, "foreign.json"), JSON.stringify({ schema_version: "trajectory-v1", agent: { name: "x", version: "1" }, steps: [{}] }));

      const health = await scanAtifHealth({ baseDir: dir });
      expect(health.totalFiles).toBe(3);
      expect(health.imported).toBe(1);                       // only good.json parses
      expect(health.groups.map((g) => g.code).sort()).toEqual(["invalid_json", "unknown_schema_version"]);
      expect(health.groups.find((g) => g.code === "unknown_schema_version")!.files).toEqual([{ name: "foreign.json" }]);
      // privacy: the temp dir's absolute path must not appear anywhere in the payload
      expect(JSON.stringify(health)).not.toContain(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns empty groups for a clean drop dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentgem-atif-clean-"));
    try {
      writeFileSync(join(dir, "good.json"), MIN_DOC);
      const health = await scanAtifHealth({ baseDir: dir });
      expect(health).toMatchObject({ totalFiles: 1, imported: 1, groups: [] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
