import { describe, it, expect } from "vitest";
import { detectClineArtifacts, parseClineMeta, watchableSources } from "@agentgem/insight";

// A Cline ui_messages entry whose text is the JSON-stringified tool payload.
const toolMsg = (payload: unknown, ts = 1_700_000_000_000) => ({ ts, type: "say", say: "tool", text: JSON.stringify(payload) });
const ui = (...msgs: unknown[]) => JSON.stringify(msgs);

describe("detectClineArtifacts", () => {
  it("reconstructs a full snapshot from a write with path + content", () => {
    const text = ui(toolMsg({ tool: "newFileCreated", path: "index.html", content: "<h1>cline</h1>" }));
    const v = detectClineArtifacts(text);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ path: "index.html", html: "<h1>cline</h1>", tool: "newFileCreated", version: 1, tsMs: 1_700_000_000_000 });
  });

  it("versions successive edits to the same path", () => {
    const text = ui(
      toolMsg({ tool: "newFileCreated", path: "a.html", content: "<h1>v1</h1>" }),
      toolMsg({ tool: "editedExistingFile", path: "a.html", content: "<h1>v2</h1>" }),
    );
    expect(detectClineArtifacts(text).map((x) => x.html)).toEqual(["<h1>v1</h1>", "<h1>v2</h1>"]);
  });

  it("de-duplicates the ask/say pair (identical consecutive content)", () => {
    const text = ui(
      { ts: 1, type: "ask", ask: "tool", text: JSON.stringify({ tool: "newFileCreated", path: "a.html", content: "<x/>" }) },
      { ts: 2, type: "say", say: "tool", text: JSON.stringify({ tool: "newFileCreated", path: "a.html", content: "<x/>" }) },
    );
    expect(detectClineArtifacts(text)).toHaveLength(1);
  });

  it("ignores non-html paths and writes with no content (diff-only)", () => {
    const text = ui(
      toolMsg({ tool: "editedExistingFile", path: "main.ts", content: "x" }),
      toolMsg({ tool: "editedExistingFile", path: "a.html", diff: "@@ -1 +1 @@" }), // no content
    );
    expect(detectClineArtifacts(text)).toEqual([]);
  });

  it("degrades on non-array / malformed json", () => {
    expect(detectClineArtifacts("{ not json")).toEqual([]);
    expect(detectClineArtifacts(JSON.stringify({ not: "an array" }))).toEqual([]);
  });
});

describe("cline Watch wiring", () => {
  it("is registered as a transcript-driven watchable source", () => {
    const cline = watchableSources().find((s) => s.id === "cline");
    expect(cline?.detectArtifacts).toBeTruthy();
    expect(cline?.watchFiles && cline?.parseMeta).toBeTruthy();
  });

  it("parseClineMeta uses the task dir name as the session id", () => {
    const text = ui({ ts: 1, type: "say", say: "text", text: "hi" });
    const stat = parseClineMeta(text, "/gs/tasks/task-123/ui_messages.json");
    expect(stat).toMatchObject({ agent: "cline", sessionId: "task-123" });
  });
});
