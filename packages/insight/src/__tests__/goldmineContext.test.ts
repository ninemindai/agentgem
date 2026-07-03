import { describe, it, expect } from "vitest";
import { buildGoldmineBrief } from "../goldmineContext.js";

describe("buildGoldmineBrief", () => {
  it("produces a compact brief with headline + top artifacts", () => {
    const brief = buildGoldmineBrief({
      scorecard: { breadth: 12, battleTested: 5, portable: 3, gaps: ["playwright"] },
      topArtifacts: [{ type: "skill", name: "brainstorm", invocations: 9 }, { type: "mcp_server", name: "github", invocations: 4 }],
      skillCount: 20,
    });
    expect(brief).toContain("breadth 12");
    expect(brief).toContain("brainstorm");
    expect(brief).toContain("github");
    expect(brief).toContain("playwright"); // gap surfaced
    expect(brief.length).toBeLessThan(2000); // stays compact
  });
  it("handles an empty goldmine without throwing", () => {
    expect(buildGoldmineBrief({ scorecard: { breadth: 0, battleTested: 0, portable: 0, gaps: [] }, topArtifacts: [], skillCount: 0 })).toContain("breadth 0");
  });
});
