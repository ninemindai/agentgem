import { describe, it, expect } from "vitest";
import { resolveGeminiHtmlPaths, parseGeminiMeta, watchableSources } from "@agentgem/insight";

// A Gemini session line where the model calls write_file with an absolute path.
const writeFile = (fp: string, content = "<h1>g</h1>") => JSON.stringify({
  id: "m2", type: "gemini", timestamp: "2026-07-03T10:00:00Z", model: "gemini-2.5-pro",
  content: [{ functionCall: { name: "write_file", args: { file_path: fp, content } } }],
});

describe("resolveGeminiHtmlPaths", () => {
  it("extracts absolute .html paths from write_file args", () => {
    const text = writeFile("/work/site/index.html");
    expect(resolveGeminiHtmlPaths(text)).toEqual(["/work/site/index.html"]);
  });

  it("handles the `replace` tool's file_path and dedupes across records", () => {
    const replace = JSON.stringify({ id: "m3", type: "gemini", content: [{ functionCall: { name: "replace", args: { file_path: "/w/a.html", old_string: "x", new_string: "y" } } }] });
    const text = [writeFile("/w/a.html"), replace, writeFile("/w/b.html")].join("\n");
    expect(resolveGeminiHtmlPaths(text)).toEqual(["/w/a.html", "/w/b.html"]);
  });

  it("accepts the absolute_path field name too", () => {
    const text = JSON.stringify({ id: "m", type: "gemini", content: [{ functionCall: { name: "read_file", args: { absolute_path: "/w/page.HTML" } } }] });
    expect(resolveGeminiHtmlPaths(text)).toEqual(["/w/page.HTML"]);
  });

  it("skips relative paths (Gemini file tools require absolute)", () => {
    const text = writeFile("relative/index.html");
    expect(resolveGeminiHtmlPaths(text)).toEqual([]);
  });

  it("ignores non-html file_paths", () => {
    const text = writeFile("/w/main.ts");
    expect(resolveGeminiHtmlPaths(text)).toEqual([]);
  });
});

describe("gemini Watch wiring", () => {
  it("is registered as a watchable source with a file-driven detector", () => {
    const gemini = watchableSources().find((s) => s.id === "gemini");
    expect(gemini).toBeTruthy();
    expect(gemini!.resolveArtifactPaths).toBeTruthy();
    expect(gemini!.watchFiles && gemini!.parseMeta).toBeTruthy();
  });

  it("parseGeminiMeta derives session id + project from the path", () => {
    const text = [
      JSON.stringify({ sessionId: "sess-xyz", projectHash: "h" }),
      JSON.stringify({ id: "m1", type: "user", timestamp: "2026-07-03T10:00:00Z", content: "hi" }),
      JSON.stringify({ id: "m2", type: "gemini", timestamp: "2026-07-03T10:00:05Z", model: "gemini-2.5-pro", content: "ok", tokens: { input: 5, output: 3 } }),
    ].join("\n");
    const stat = parseGeminiMeta(text, "/home/u/.gemini/tmp/myslug/chats/session-abc.jsonl");
    expect(stat).toMatchObject({ agent: "gemini", sessionId: "sess-xyz", project: "myslug" });
  });
});
