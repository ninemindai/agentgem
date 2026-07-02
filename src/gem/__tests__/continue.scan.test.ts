import { describe, it, expect } from "vitest";
import { parseContinueSession } from "@agentgem/insight";

const session = JSON.stringify({
  sessionId: "s-1", title: "Refactor the parser", workspaceDirectory: "/home/u/my-proj",
  chatModelTitle: "Claude Sonnet 5",
  history: [
    { message: { role: "user", content: "hi" } },
    { message: { role: "assistant", content: "hello" } },
  ],
  usage: { promptTokens: 120, completionTokens: 45, promptTokensDetails: { cachedTokens: 20 }, totalCost: 0.01 },
});

describe("Continue session parse", () => {
  it("maps usage/model/timing into a SessionStat (title never leaks)", () => {
    const s = parseContinueSession(session, { dateCreated: "1751328000000", messageCount: 2, mtimeMs: 1751328600000 })!;
    expect(s).toMatchObject({ agent: "continue", sessionId: "s-1", project: "my-proj", model: "Claude Sonnet 5", msgs: 2 });
    expect(s.tokensIn).toBe(100);   // 120 - 20 cached
    expect(s.tokensOut).toBe(45);
    expect(s.tokensCache).toBe(20);
    expect(s.startMs).toBe(1751328000000);
    expect(s.endMs).toBe(1751328600000);         // file mtime proxy
    expect(JSON.stringify(s)).not.toContain("Refactor the parser"); // title is content-derived — never ingested
  });
  it("counts history when messageCount absent; zero tokens when usage absent; never throws on garbage", () => {
    const noUsage = JSON.stringify({ sessionId: "s-2", workspaceDirectory: "/p", history: [{ message: { role: "user", content: "x" } }] });
    const s = parseContinueSession(noUsage, { dateCreated: "1000", mtimeMs: 2000 })!;
    expect(s.msgs).toBe(1); expect(s.tokensIn).toBe(0); expect(s.tokensOut).toBe(0);
    expect(parseContinueSession("not json", { mtimeMs: 5 })).toBeNull();
  });
  it("falls back to mtime (not NaN) when dateCreated is a non-numeric string", () => {
    const s = parseContinueSession(session, { dateCreated: "not-a-number", messageCount: 2, mtimeMs: 2000 })!;
    expect(s.startMs).toBe(2000);
    expect(s.endMs).toBe(2000);
    expect(Number.isNaN(s.startMs)).toBe(false);
    expect(Number.isNaN(s.endMs)).toBe(false);
  });
  it("coerces a corrupted usage block to finite zero tokens instead of NaN", () => {
    const corrupted = JSON.stringify({
      sessionId: "s-3", workspaceDirectory: "/p",
      history: [{ message: { role: "user", content: "x" } }],
      usage: { promptTokens: "oops", completionTokens: "oops", promptTokensDetails: { cachedTokens: "oops" } },
    });
    const s = parseContinueSession(corrupted, { dateCreated: "1000", mtimeMs: 2000 })!;
    expect(s.tokensIn).toBe(0);
    expect(s.tokensOut).toBe(0);
    expect(s.tokensCache).toBe(0);
    expect(Number.isFinite(s.tokensIn)).toBe(true);
    expect(Number.isFinite(s.tokensOut)).toBe(true);
    expect(Number.isFinite(s.tokensCache)).toBe(true);
  });
});
