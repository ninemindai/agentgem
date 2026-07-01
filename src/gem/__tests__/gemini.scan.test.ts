import { describe, it, expect } from "vitest";
import { parseGeminiSession } from "@agentgem/insight";

const L = (o: unknown) => JSON.stringify(o);
// header, user m1, gemini m2 (tokens), gemini m2 RE-SET (updated tokens overwrite in place),
// user m3, gemini m4, then $rewindTo m3 (drops m3 AND m4).
const jsonl = [
  L({ sessionId: "sess-123", projectHash: "abc", startTime: "2026-07-01T00:00:00Z", lastUpdated: "2026-07-01T00:10:00Z", kind: "main" }),
  L({ id: "m1", timestamp: "2026-07-01T00:00:01Z", type: "user", content: "hi" }),
  L({ id: "m2", timestamp: "2026-07-01T00:00:02Z", type: "gemini", model: "gemini-2.5-pro", content: "x", tokens: { input: 5, output: 3, cached: 0, thoughts: 0, total: 8 } }),
  L({ id: "m2", timestamp: "2026-07-01T00:00:03Z", type: "gemini", model: "gemini-2.5-pro", content: "x", tokens: { input: 100, output: 40, cached: 10, thoughts: 4, total: 154 } }),
  L({ id: "m3", timestamp: "2026-07-01T00:05:00Z", type: "user", content: "again" }),
  L({ id: "m4", timestamp: "2026-07-01T00:05:01Z", type: "gemini", model: "gemini-2.5-pro", content: "y", tokens: { input: 999, output: 999, cached: 0, total: 1998 } }),
  L({ $rewindTo: "m3" }),
].join("\n");

describe("Gemini session fold", () => {
  it("folds re-set (overwrite) + $rewindTo (drop inclusive)", () => {
    const s = parseGeminiSession(jsonl, "fallback", "my-repo")!;
    expect(s).toMatchObject({ agent: "gemini", sessionId: "sess-123", project: "my-repo", model: "gemini-2.5-pro" });
    // survivors after rewind: m1 (user) + m2 (gemini, the RE-SET values). m3/m4 dropped.
    expect(s.msgs).toBe(2);
    expect(s.tokensIn).toBe(90);   // max(0, 100-10)
    expect(s.tokensOut).toBe(44);  // 40 + 4 thoughts
    expect(s.tokensCache).toBe(10);
    expect(s.startMs).toBe(Date.parse("2026-07-01T00:00:01Z"));
    expect(s.endMs).toBe(Date.parse("2026-07-01T00:00:03Z")); // m2's re-set ts (m3/m4 rewound away)
  });
  it("returns null for empty/malformed", () => {
    expect(parseGeminiSession("", "f", null)).toBeNull();
    expect(parseGeminiSession("not json\n{bad", "f", null)).toBeNull();
  });
  it("derives model from surviving messages, not a message later dropped by $rewindTo", () => {
    // header, user m1, gemini m2 (survivor, model gemini-2.5-pro), user m3, gemini m4 (model
    // gemini-OLD), then $rewindTo m4 (drops m4). The raw fold sees m4 LAST, so a naive
    // last-write-wins over ALL records would wrongly report "gemini-OLD"; the survivors
    // (m1, m2, m3) are model "gemini-2.5-pro".
    const rewoundJsonl = [
      L({ sessionId: "sess-456", projectHash: "abc", startTime: "2026-07-01T00:00:00Z", lastUpdated: "2026-07-01T00:10:00Z", kind: "main" }),
      L({ id: "m1", timestamp: "2026-07-01T00:00:01Z", type: "user", content: "hi" }),
      L({ id: "m2", timestamp: "2026-07-01T00:00:02Z", type: "gemini", model: "gemini-2.5-pro", content: "x", tokens: { input: 5, output: 3, cached: 0, total: 8 } }),
      L({ id: "m3", timestamp: "2026-07-01T00:05:00Z", type: "user", content: "again" }),
      L({ id: "m4", timestamp: "2026-07-01T00:05:01Z", type: "gemini", model: "gemini-OLD", content: "y", tokens: { input: 999, output: 999, cached: 0, total: 1998 } }),
      L({ $rewindTo: "m4" }),
    ].join("\n");
    const s = parseGeminiSession(rewoundJsonl, "fallback", "my-repo")!;
    expect(s.msgs).toBe(3);
    expect(s.model).toBe("gemini-2.5-pro");
  });
});
