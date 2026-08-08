// packages/insight/src/__tests__/reportChecks.test.ts
import { describe, it, expect } from "vitest";
import { runChecks, type RenderDigest, type Finding } from "@ninemind/miniapp-gate";
import { REPORT_CHECKS, reportTruncatedFinding } from "../reportChecks.js";

/** A digest describing a healthy report: the seam is present, parses, and holds facts. */
function digest(over: Partial<RenderDigest> = {}): RenderDigest {
  return {
    title: "Session report — agentgem",
    ids: ["report-data"],
    bodyElementCount: 40,
    controls: [],
    images: [],
    jsonBlocks: [{ id: "report-data", parses: true, empty: false, bytes: 900 }],
    attachedExternal: [],
    ariaRefs: [],
    hasCanvas: false,
    hasVectorOrImageContent: false,
    ...over,
  };
}

const run = (over: Partial<RenderDigest> = {}): Finding[] => runChecks(digest(over), REPORT_CHECKS);
const find = (f: Finding[], id: string): Finding | undefined => f.find((x) => x.id === id);

describe("report checks", () => {
  it("finds nothing wrong with a report whose seam is intact", () => {
    expect(run()).toEqual([]);
  });

  it("fails when the #report-data seam is absent", () => {
    // Without the seam every number on the page is prose the agent typed rather than a value read
    // from the facts — which is the single thing REPORT_BUILDER_BRIEF exists to prevent.
    const f = find(run({ jsonBlocks: [] }), "report-data-missing");
    expect(f?.severity).toBe("fail");
  });

  it("fails when the seam is present but the JSON is broken", () => {
    const f = find(run({ jsonBlocks: [{ id: "report-data", parses: false, empty: true, bytes: 40 }] }), "report-data-unparseable");
    expect(f?.severity).toBe("fail");
  });

  it("fails when the seam parses to nothing", () => {
    const f = find(run({ jsonBlocks: [{ id: "report-data", parses: true, empty: true, bytes: 2 }] }), "report-data-empty");
    expect(f?.severity).toBe("fail");
  });

  it("reports exactly one seam problem, not a cascade", () => {
    // A missing seam is not ALSO unparseable and ALSO empty. Three findings for one cause would make
    // the repair prompt argue with itself.
    const f = run({ jsonBlocks: [] });
    expect(f.filter((x) => x.id.startsWith("report-data-"))).toHaveLength(1);
  });

  it("ignores json blocks that are not the report seam", () => {
    // A report may bake other inert data. Only #report-data carries the anti-hallucination contract.
    const f = run({ jsonBlocks: [
      { id: "something-else", parses: false, empty: true, bytes: 10 },
      { id: "report-data", parses: true, empty: false, bytes: 900 },
    ] });
    expect(f).toEqual([]);
  });

  it("warns when the document has no title", () => {
    expect(find(run({ title: null }), "no-title")?.severity).toBe("warn");
    expect(find(run({ title: "   " }), "no-title")?.severity).toBe("warn");
  });
});

describe("reportTruncatedFinding", () => {
  // Not a digest check: truncation is a property of the RENDER, not of the DOM. It lives here so
  // every report finding is discoverable in one module.
  it("fails, because a slice can sever the seam mid-object", () => {
    const f = reportTruncatedFinding(150_000, 120_000);
    expect(f.severity).toBe("fail");
    expect(f.id).toBe("report-truncated");
  });

  it("names both sizes so the repair prompt knows how much to cut", () => {
    const f = reportTruncatedFinding(150_000, 120_000);
    expect(f.evidence).toContain("150000");
    expect(f.evidence).toContain("120000");
  });
});
