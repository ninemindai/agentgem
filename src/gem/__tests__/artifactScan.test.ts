import { describe, it, expect } from "vitest";
import { detectHtmlArtifacts, artifactPaths, jsonLines } from "@agentgem/insight";

// Build one assistant transcript record carrying a single tool_use item.
const toolRec = (name: string, input: unknown, ts = "2026-07-03T10:00:00.000Z") =>
  ({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input }] } });

describe("detectHtmlArtifacts", () => {
  it("captures a Write to a .html file as v1 with full content", () => {
    const recs = [toolRec("Write", { file_path: "/w/app/index.html", content: "<h1>hi</h1>" })];
    const v = detectHtmlArtifacts(recs);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ path: "/w/app/index.html", html: "<h1>hi</h1>", tool: "Write", version: 1 });
    expect(v[0].tsMs).toBe(Date.parse("2026-07-03T10:00:00.000Z"));
  });

  it("ignores non-HTML writes", () => {
    const recs = [toolRec("Write", { file_path: "/w/app/main.ts", content: "const x = 1" })];
    expect(detectHtmlArtifacts(recs)).toHaveLength(0);
  });

  it("matches .htm as well as .html, case-insensitively", () => {
    const recs = [toolRec("Write", { file_path: "/w/PAGE.HTM", content: "<p>x</p>" })];
    expect(detectHtmlArtifacts(recs)).toHaveLength(1);
  });

  it("applies a subsequent Edit onto the last Write snapshot (v2)", () => {
    const recs = [
      toolRec("Write", { file_path: "/w/i.html", content: "<h1>hi</h1>" }),
      toolRec("Edit", { file_path: "/w/i.html", old_string: "hi", new_string: "hello" }),
    ];
    const v = detectHtmlArtifacts(recs);
    expect(v.map((x) => x.html)).toEqual(["<h1>hi</h1>", "<h1>hello</h1>"]);
    expect(v.map((x) => x.version)).toEqual([1, 2]);
  });

  it("honors replace_all in an Edit", () => {
    const recs = [
      toolRec("Write", { file_path: "/w/i.html", content: "<b>a</b><b>a</b>" }),
      toolRec("Edit", { file_path: "/w/i.html", old_string: "a", new_string: "z", replace_all: true }),
    ];
    expect(detectHtmlArtifacts(recs)[1].html).toBe("<b>z</b><b>z</b>");
  });

  it("applies MultiEdit edits sequentially onto the snapshot", () => {
    const recs = [
      toolRec("Write", { file_path: "/w/i.html", content: "<h1>one</h1>" }),
      toolRec("MultiEdit", { file_path: "/w/i.html", edits: [
        { old_string: "one", new_string: "two" },
        { old_string: "<h1>", new_string: "<h2>" },
      ] }),
    ];
    const v = detectHtmlArtifacts(recs);
    expect(v[1].html).toBe("<h2>two</h1>");
    expect(v[1].tool).toBe("MultiEdit");
  });

  it("skips an Edit that precedes any Write (no base document to mutate)", () => {
    const recs = [toolRec("Edit", { file_path: "/w/i.html", old_string: "a", new_string: "b" })];
    expect(detectHtmlArtifacts(recs)).toHaveLength(0);
  });

  it("versions two distinct paths independently", () => {
    const recs = [
      toolRec("Write", { file_path: "/w/a.html", content: "A1" }),
      toolRec("Write", { file_path: "/w/b.html", content: "B1" }),
      toolRec("Write", { file_path: "/w/a.html", content: "A2" }),
    ];
    const v = detectHtmlArtifacts(recs);
    expect(v.map((x) => `${x.path}#${x.version}`)).toEqual(["/w/a.html#1", "/w/b.html#1", "/w/a.html#2"]);
    expect(artifactPaths(v)).toEqual(["/w/a.html", "/w/b.html"]);
  });

  it("degrades on records with no content array or malformed input", () => {
    const recs = [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } },
      toolRec("Write", { file_path: "/w/ok.html", content: "<x/>" }),
    ];
    expect(detectHtmlArtifacts(recs)).toHaveLength(1);
  });

  it("works end-to-end from raw jsonl text via jsonLines", () => {
    const text = [
      JSON.stringify(toolRec("Write", { file_path: "/w/i.html", content: "<h1>v1</h1>" })),
      "{ not json",
      JSON.stringify(toolRec("Edit", { file_path: "/w/i.html", old_string: "v1", new_string: "v2" })),
    ].join("\n");
    const v = detectHtmlArtifacts(jsonLines(text));
    expect(v.map((x) => x.html)).toEqual(["<h1>v1</h1>", "<h1>v2</h1>"]);
  });
});
