// src/play/__tests__/sessionRef.test.ts
import { describe, it, expect } from "vitest";
import { resolveSessionRef } from "@agentgem/play";
import type { GameSource } from "@agentgem/model";

const authored: GameSource = { kind: "session", agent: "claude", sessionId: "author-1", summary: "auth" };
const active = [{ id: "mine-1", agent: "codex" }, { id: "mine-2", agent: "claude" }];

describe("resolveSessionRef", () => {
  it("returns the miniapp's own session when there is no override", () => {
    expect(resolveSessionRef(authored, {}, active)).toEqual({ sessionId: "author-1", agent: "claude" });
  });

  it("returns a viewer override that names an available local session", () => {
    expect(resolveSessionRef(authored, { sessionId: "mine-1", agent: "codex" }, active)).toEqual({ sessionId: "mine-1", agent: "codex" });
  });

  it("rejects an override whose (sessionId, agent) is not in the active list", () => {
    expect(() => resolveSessionRef(authored, { sessionId: "mine-1", agent: "claude" }, active)).toThrow(/not an available local session/i);
    expect(() => resolveSessionRef(authored, { sessionId: "elsewhere", agent: "codex" }, active)).toThrow(/not an available local session/i);
  });

  it("ignores a partial override (only one of sessionId/agent) and falls back to the author session", () => {
    expect(resolveSessionRef(authored, { sessionId: "mine-1" }, active)).toEqual({ sessionId: "author-1", agent: "claude" });
  });

  it("throws when there is no override and the miniapp has no session source", () => {
    const blank: GameSource = { kind: "blank", title: "x" };
    expect(() => resolveSessionRef(blank, {}, active)).toThrow(/no session data/i);
  });
});
