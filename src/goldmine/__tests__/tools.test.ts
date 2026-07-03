import { describe, it, expect } from "vitest";
import { searchSessions, getArtifactDetail } from "../tools.js";

const S = (o: Partial<any>) => ({ agent: "claude", sessionId: "s1", project: "/p/web", model: "opus", gitBranch: "main", startMs: 10, endMs: 20, msgs: 4, tokensIn: 0, tokensOut: 0, tokensCache: 0, ...o });

describe("searchSessions", () => {
  it("matches on project substring, newest first, honors limit", () => {
    const rows = [S({ sessionId: "a", project: "/p/web", startMs: 1 }), S({ sessionId: "b", project: "/p/api", startMs: 2 }), S({ sessionId: "c", project: "/p/webhook", startMs: 3 })];
    const out = searchSessions(rows, "web", 10);
    expect(out.map((m) => m.sessionId)).toEqual(["c", "a"]); // web + webhook, newest first
  });
  it("empty query returns newest N", () => {
    const rows = [S({ sessionId: "a", startMs: 1 }), S({ sessionId: "b", startMs: 2 })];
    expect(searchSessions(rows, "", 1).map((m) => m.sessionId)).toEqual(["b"]);
  });
});

describe("getArtifactDetail", () => {
  const global = { skills: [{ name: "brainstorm", description: "ideas", path: "/g/brainstorm" }], mcpServers: [], instructions: [], hooks: [] } as any;
  const project = { root: "/p/web", name: "web", skills: [{ name: "deploy", description: "ship it", path: "/p/web/deploy" }], mcpServers: [], instructions: [], hooks: [] } as any;
  it("prefers project scope, returns detail", () => {
    expect(getArtifactDetail(global, project, "skill", "deploy")).toMatchObject({ name: "deploy", root: "/p/web", description: "ship it" });
  });
  it("falls back to global (root null)", () => {
    expect(getArtifactDetail(global, project, "skill", "brainstorm")).toMatchObject({ name: "brainstorm", root: null });
  });
  it("returns null for unknown", () => {
    expect(getArtifactDetail(global, project, "skill", "nope")).toBeNull();
  });
});
