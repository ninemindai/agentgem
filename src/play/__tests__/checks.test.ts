// src/play/__tests__/checks.test.ts
//
// Checks are pure functions over a RenderDigest, which is the whole point of producing a digest
// instead of baking check logic into the eval'd worker string: these run in microseconds against a
// literal, with no worker, no jsdom, and full typechecking.
import { describe, it, expect } from "vitest";
import { runChecks, SHARED_CHECKS, type RenderDigest, type Finding } from "@agentgem/play";

/** A digest describing a perfectly ordinary, healthy document. Each test perturbs ONE field. */
function digest(over: Partial<RenderDigest> = {}): RenderDigest {
  return {
    title: "A report",
    ids: ["a", "b"],
    bodyElementCount: 12,
    controls: [{ tag: "button", nameHint: "Save" }],
    images: [{ hasAlt: true, src: "data:image/png;base64,AAAA" }],
    jsonBlocks: [{ id: "report-data", parses: true, empty: false, bytes: 120 }],
    attachedExternal: [],
    ariaRefs: [{ attr: "aria-describedby", target: "b", resolves: true }],
    hasCanvas: false,
    hasVectorOrImageContent: false,
    ...over,
  };
}

const run = (over: Partial<RenderDigest> = {}): Finding[] => runChecks(digest(over), SHARED_CHECKS);
const ids = (f: Finding[]): string[] => f.map((x) => x.id);
const find = (f: Finding[], id: string): Finding | undefined => f.find((x) => x.id === id);

describe("shared checks", () => {
  it("finds nothing wrong with a healthy document", () => {
    expect(run()).toEqual([]);
  });

  describe("duplicate-id", () => {
    it("fails on a repeated id and names it", () => {
      const f = find(run({ ids: ["a", "dup", "b", "dup"] }), "duplicate-id");
      expect(f?.severity).toBe("fail");
      // Naming the offender is the difference between an actionable failure and a scavenger hunt —
      // these strings go back to the authoring agent as the repair loop's error signal.
      expect(f?.evidence).toContain("dup");
    });

    it("passes when every id is unique", () => {
      expect(ids(run({ ids: ["a", "b", "c"] }))).not.toContain("duplicate-id");
    });
  });

  describe("attached-external-resource", () => {
    it("fails and names the URL", () => {
      const f = find(run({ attachedExternal: ["https://cdn.example/x.png"] }), "attached-external-resource");
      expect(f?.severity).toBe("fail");
      expect(f?.evidence).toContain("cdn.example");
    });
  });

  describe("blank-render", () => {
    // WARN, not fail, and deliberately. The digest is taken after two setTimeout(0) ticks, which is
    // what the load-smoke needs but is NOT a rendering contract: a document that paints on
    // requestAnimationFrame or a delayed timer has not finished when the snapshot is taken. Gating on
    // this would block legitimate saves and burn repair turns on documents that are fine.
    it("warns rather than fails, so a slow-painting document is never blocked", () => {
      expect(find(run({ bodyElementCount: 0 }), "blank-render")?.severity).toBe("warn");
    });

    it("stays quiet for a canvas app, which legitimately has no DOM content", () => {
      expect(ids(run({ bodyElementCount: 0, hasCanvas: true, hasVectorOrImageContent: true })))
        .not.toContain("blank-render");
    });

    it("stays quiet for an SVG- or image-only document", () => {
      // "no text" wrongly condemns a valid chart or illustration. Element count plus a vector/image
      // escape hatch is the honest version of the question.
      expect(ids(run({ bodyElementCount: 0, hasVectorOrImageContent: true }))).not.toContain("blank-render");
    });
  });

  describe("unnamed-control", () => {
    it("warns when a control has no name a screen reader could announce", () => {
      const f = find(run({ controls: [{ tag: "button", nameHint: "" }] }), "unnamed-control");
      expect(f?.severity).toBe("warn");
    });

    it("accepts whitespace-only as unnamed but a real hint as named", () => {
      expect(ids(run({ controls: [{ tag: "button", nameHint: "   " }] }))).toContain("unnamed-control");
      expect(ids(run({ controls: [{ tag: "a", nameHint: "Docs" }] }))).not.toContain("unnamed-control");
    });
  });

  describe("missing-alt", () => {
    it("warns for an image with no alt attribute", () => {
      expect(find(run({ images: [{ hasAlt: false, src: "data:," }] }), "missing-alt")?.severity).toBe("warn");
    });
  });

  describe("broken-aria-ref", () => {
    it("warns and names the unresolved target", () => {
      const f = find(run({ ariaRefs: [{ attr: "aria-labelledby", target: "ghost", resolves: false }] }), "broken-aria-ref");
      expect(f?.severity).toBe("warn");
      expect(f?.evidence).toContain("ghost");
    });
  });

  describe("runChecks", () => {
    it("orders fail before warn so the blocking reason reads first", () => {
      const f = runChecks(digest({ ids: ["d", "d"], images: [{ hasAlt: false, src: "data:," }] }), SHARED_CHECKS);
      expect(f[0]?.severity).toBe("fail");
      expect(f.map((x) => x.severity)).toEqual([...f.map((x) => x.severity)].sort((a, b) => (a === b ? 0 : a === "fail" ? -1 : 1)));
    });

    it("reports every distinct problem rather than stopping at the first", () => {
      const f = runChecks(digest({
        ids: ["d", "d"],
        attachedExternal: ["https://cdn.example/x.png"],
        images: [{ hasAlt: false, src: "data:," }],
      }), SHARED_CHECKS);
      expect(ids(f)).toEqual(expect.arrayContaining(["duplicate-id", "attached-external-resource", "missing-alt"]));
    });

    it("returns nothing for an empty check list", () => {
      expect(runChecks(digest(), [])).toEqual([]);
    });
  });
});
