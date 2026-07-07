import { describe, it, expect } from "vitest";
import { buildGoldmineBrief } from "@agentgem/insight";

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
  it("renders the behavior teaser only when provided", () => {
    const base = { scorecard: { breadth: 0, battleTested: 0, portable: 0, gaps: [] }, topArtifacts: [], skillCount: 0 };
    expect(buildGoldmineBrief(base)).not.toContain("Behavior:");
    const brief = buildGoldmineBrief({ ...base, behavior: { patterns: 2, topTitle: "Same command repeated back-to-back" } });
    expect(brief).toContain(`Behavior: 2 recurring pattern(s)`);
    expect(brief).toContain("Same command repeated back-to-back");
    expect(brief).toContain("get_behavior_findings");
  });
  it("steers to summarize_session and ask_session, not the removed raw-dump tool", () => {
    const brief = buildGoldmineBrief({ scorecard: { breadth: 0, battleTested: 0, portable: 0, gaps: [] }, topArtifacts: [], skillCount: 0 });
    expect(brief).toContain("summarize_session");
    expect(brief).toContain("ask_session");
    expect(brief).not.toContain("get_session_transcript");
  });
});
