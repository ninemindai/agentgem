import { describe, it, expect } from "vitest";
import { searchSessions, getArtifactDetail, windowTranscript } from "../tools.js";
import type { TranscriptView } from "@agentgem/insight";

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
  it("null project/model/gitBranch do not match the query 'null'", () => {
    const nullSession = S({ sessionId: "null-fields", project: null, model: null, gitBranch: null, startMs: 5 });
    const other = S({ sessionId: "normal", project: "/p/web", startMs: 3 });
    // querying "null" must NOT match a session whose fields happen to be null
    expect(searchSessions([nullSession, other], "null", 10).map((m) => m.sessionId)).toEqual([]);
    // empty query still returns both (newest first)
    expect(searchSessions([nullSession, other], "", 10).map((m) => m.sessionId)).toEqual(["null-fields", "normal"]);
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

describe("windowTranscript", () => {
  const turn = (id: string): TranscriptView["turns"][number] =>
    ({ id, role: "user", tsMs: 0, spans: [{ kind: "message", role: "user", text: id }], tokens: { in: 0, out: 0, cache: 0 } });
  const view = (n: number): TranscriptView => ({
    sessionId: "s1",
    agent: "claude",
    meta: { agent: "claude", sessionId: "s1", project: null, model: null, gitBranch: null, startMs: 0, endMs: 0, msgs: n, tokensIn: 0, tokensOut: 0, tokensCache: 0 },
    turns: Array.from({ length: n }, (_, i) => turn(`t${i}`)),
  });

  it("returns the requested window and reports hasMore", () => {
    const w = windowTranscript(view(10), 0, 3);
    expect(w.turns.map((t) => t.id)).toEqual(["t0", "t1", "t2"]);
    expect(w.total).toBe(10);
    expect(w.from).toBe(0);
    expect(w.hasMore).toBe(true);
  });
  it("last partial page reports hasMore=false", () => {
    const w = windowTranscript(view(5), 3, 10);
    expect(w.turns.map((t) => t.id)).toEqual(["t3", "t4"]);
    expect(w.hasMore).toBe(false);
  });
  it("exact-boundary window has no off-by-one (hasMore=false)", () => {
    const w = windowTranscript(view(6), 0, 6);
    expect(w.turns).toHaveLength(6);
    expect(w.hasMore).toBe(false);
  });
  it("clamps a from past the end to an empty window", () => {
    const w = windowTranscript(view(4), 99, 10);
    expect(w.turns).toEqual([]);
    expect(w.from).toBe(4);
    expect(w.hasMore).toBe(false);
  });
  it("carries session token meta through the window", () => {
    const v = view(2);
    v.meta.tokensOut = 1234;
    expect(windowTranscript(v, 0, 1).meta.tokensOut).toBe(1234);
  });
});
