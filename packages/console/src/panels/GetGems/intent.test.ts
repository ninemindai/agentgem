import { describe, it, expect, afterEach } from "vitest";
import { setPendingQuery, takePendingQuery } from "./intent.js";

afterEach(() => { takePendingQuery(); }); // drain between tests

describe("cross-panel intent", () => {
  it("returns null when nothing is pending", () => {
    expect(takePendingQuery()).toBeNull();
  });
  it("round-trips a pending query and clears it (one-shot)", () => {
    setPendingQuery("brainstorming");
    expect(takePendingQuery()).toBe("brainstorming");
    expect(takePendingQuery()).toBeNull();
  });
  it("keeps only the most recent pending query", () => {
    setPendingQuery("a");
    setPendingQuery("b");
    expect(takePendingQuery()).toBe("b");
  });
});
