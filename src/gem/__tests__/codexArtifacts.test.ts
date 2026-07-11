import { describe, it, expect } from "vitest";
import { resolveCodexHtmlPaths } from "@agentgem/insight";

const meta = (cwd: string) => JSON.stringify({ type: "session_meta", payload: { id: "s1", cwd } });
const call = (name: string, args: string) =>
  JSON.stringify({ type: "response_item", payload: { type: "function_call", name, arguments: args } });

describe("resolveCodexHtmlPaths", () => {
  it("resolves apply_patch Add/Update File headers against the session cwd", () => {
    const text = [
      meta("/work/site"),
      call("apply_patch", JSON.stringify({ input: "*** Begin Patch\n*** Add File: public/index.html\n+<h1>hi</h1>\n*** End Patch" })),
    ].join("\n");
    expect(resolveCodexHtmlPaths(text)).toEqual(["/work/site/public/index.html"]);
  });

  it("picks up absolute .html paths from shell redirects", () => {
    const text = [
      meta("/work/site"),
      call("shell", JSON.stringify({ command: ["bash", "-lc", "cat > /work/site/page.html <<'EOF'\n<p>x</p>\nEOF"] })),
    ].join("\n");
    expect(resolveCodexHtmlPaths(text)).toContain("/work/site/page.html");
  });

  it("dedupes across records and preserves first-seen order", () => {
    const text = [
      meta("/w"),
      call("apply_patch", JSON.stringify({ input: "*** Update File: a.html" })),
      call("apply_patch", JSON.stringify({ input: "*** Update File: b.html" })),
      call("apply_patch", JSON.stringify({ input: "*** Update File: a.html" })),
    ].join("\n");
    expect(resolveCodexHtmlPaths(text)).toEqual(["/w/a.html", "/w/b.html"]);
  });

  it("matches .htm and is case-insensitive", () => {
    const text = [meta("/w"), call("shell", JSON.stringify({ command: ["cp", "t.HTM", "/w/OUT.HTML"] }))].join("\n");
    expect(resolveCodexHtmlPaths(text)).toContain("/w/OUT.HTML");
  });

  it("skips relative paths seen before any cwd is known", () => {
    const text = [call("apply_patch", JSON.stringify({ input: "*** Add File: early.html" })), meta("/w")].join("\n");
    expect(resolveCodexHtmlPaths(text)).toEqual([]);
  });

  it("does not merge two comma-separated .html paths into one token", () => {
    const text = [meta("/w"), call("shell", JSON.stringify({ command: ["bash", "-lc", "cp /w/a.html,/w/b.html ."] }))].join("\n");
    expect(resolveCodexHtmlPaths(text)).toEqual(["/w/a.html", "/w/b.html"]);
  });

  it("does not mistake a URL for a local file path", () => {
    const text = [meta("/w"), call("shell", JSON.stringify({ command: ["curl", "https://example.com/page.html"] }))].join("\n");
    // The '//example.com/...' fragment after the scheme is rejected; no bogus root path.
    expect(resolveCodexHtmlPaths(text)).toEqual([]);
  });
});
