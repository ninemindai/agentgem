import { describe, it, expect } from "vitest";
import { resolveContinueHtmlPaths, parseContinueMeta, watchableSources } from "@agentgem/insight";

describe("resolveContinueHtmlPaths", () => {
  it("extracts absolute .html paths from a filepath tool arg", () => {
    const text = JSON.stringify({ history: [{ message: { role: "assistant", toolCalls: [{ function: { name: "builtin_edit_existing_file", arguments: JSON.stringify({ filepath: "/work/site/index.html", new_contents: "<h1>c</h1>" }) } }] } }] });
    expect(resolveContinueHtmlPaths(text)).toEqual(["/work/site/index.html"]);
  });

  it("accepts file_path and absolute_path field names and dedupes", () => {
    const text = [
      JSON.stringify({ file_path: "/w/a.html" }),
      JSON.stringify({ absolute_path: "/w/a.html" }),
      JSON.stringify({ filepath: "/w/b.html" }),
    ].join("\n");
    expect(resolveContinueHtmlPaths(text)).toEqual(["/w/a.html", "/w/b.html"]);
  });

  it("skips relative paths (degrades safely when the tool uses workspace-relative paths)", () => {
    expect(resolveContinueHtmlPaths(JSON.stringify({ filepath: "src/index.html" }))).toEqual([]);
  });

  it("ignores non-html paths", () => {
    expect(resolveContinueHtmlPaths(JSON.stringify({ filepath: "/w/app.ts" }))).toEqual([]);
  });
});

describe("continue Watch wiring", () => {
  it("is registered as a file-driven watchable source", () => {
    const cont = watchableSources().find((s) => s.id === "continue");
    expect(cont?.resolveArtifactPaths).toBeTruthy();
    expect(cont?.watchFiles && cont?.parseMeta).toBeTruthy();
  });

  it("parseContinueMeta falls back to the filename for the session id", () => {
    const text = JSON.stringify({ workspaceDirectory: "/p/site", history: [{ message: { role: "user", content: "hi" } }, { message: { role: "assistant", content: "ok" } }] });
    const stat = parseContinueMeta(text, "/home/u/.continue/sessions/sess-9.json");
    expect(stat).toMatchObject({ agent: "continue", sessionId: "sess-9", project: "site" });
  });
});
