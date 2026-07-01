import { describe, it, expect } from "vitest";
import { parseClineTask } from "@agentgem/insight";

// ui_messages.json: array of ClineMessage; usage lives in say:"api_req_started" whose .text is JSON-stringified.
const ui = JSON.stringify([
  { ts: 1751328000000, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 100, tokensOut: 40, cacheReads: 10, cacheWrites: 5, cost: 0.01 }) },
  { ts: 1751328000000, type: "say", say: "text", text: "hello" },
  { ts: 1751328600000, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 50, tokensOut: 20 }) },
]);

describe("Cline task parsing", () => {
  it("sums api_req_started token fields and derives timing", () => {
    const s = parseClineTask(ui, "1751328000000")!;
    expect(s).toMatchObject({ agent: "cline", sessionId: "1751328000000", tokensIn: 150, tokensOut: 60, tokensCache: 15 });
    expect(s.startMs).toBe(1751328000000);
    expect(s.endMs).toBe(1751328600000);
  });
  it("returns null for an empty/malformed task", () => {
    expect(parseClineTask("not json", "x")).toBeNull();
    expect(parseClineTask("[]", "x")).toBeNull();
  });
});
