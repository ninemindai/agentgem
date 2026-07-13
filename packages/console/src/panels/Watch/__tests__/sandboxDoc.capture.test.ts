// packages/console/src/panels/Watch/__tests__/sandboxDoc.capture.test.ts
import { describe, it, expect } from "vitest";
import { sandboxDoc } from "../sandboxDoc.js";
import { pickCaptureCanvas } from "../captureCanvas.js";

describe("capture shim wiring", () => {
  it("injects the capture shim + its message contract into the sealed doc", () => {
    const doc = sandboxDoc("<canvas></canvas>");
    expect(doc).toContain("agentgem:capture");
    expect(doc).toContain("agentgem:capture-result");
  });
});

describe("pickCaptureCanvas", () => {
  const c = (w: number, h: number) => ({ getBoundingClientRect: () => ({ width: w, height: h }) }) as unknown as HTMLCanvasElement;
  it("picks the largest-area canvas", () => {
    const small = c(10, 10), big = c(400, 300);
    expect(pickCaptureCanvas([small, big])).toBe(big);
  });
  it("returns null for an empty list", () => {
    expect(pickCaptureCanvas([])).toBeNull();
  });
  it("ignores zero-area canvases", () => {
    expect(pickCaptureCanvas([c(0, 0)])).toBeNull();
  });
});
