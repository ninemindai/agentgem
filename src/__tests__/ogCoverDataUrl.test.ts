import { describe, it, expect } from "vitest";
import { parseImageDataUrl, toDataUrl, COVER_MAX_BYTES } from "../og/coverDataUrl.js";

const b64 = (b: number[]) => Buffer.from(b).toString("base64");

describe("parseImageDataUrl", () => {
  it("parses an allowed image data URL to {contentType, bytes}", () => {
    const r = parseImageDataUrl(`data:image/png;base64,${b64([0x89, 0x50, 1])}`);
    expect(r?.contentType).toBe("image/png");
    expect(r ? [...r.bytes] : null).toEqual([0x89, 0x50, 1]);
  });
  it("rejects a disallowed content type", () => {
    expect(parseImageDataUrl(`data:image/svg+xml;base64,${b64([1])}`)).toBeNull();
    expect(parseImageDataUrl(`data:text/html;base64,${b64([1])}`)).toBeNull();
  });
  it("rejects a non-data / malformed string", () => {
    expect(parseImageDataUrl("https://x/y.png")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64,")).toBeNull();
    expect(parseImageDataUrl("")).toBeNull();
  });
  it("rejects an oversized payload", () => {
    const big = Buffer.alloc(COVER_MAX_BYTES + 1).toString("base64");
    expect(parseImageDataUrl(`data:image/png;base64,${big}`)).toBeNull();
  });
  it("rejects a grossly-oversized base64 string via the pre-decode guard (no full decode)", () => {
    // ~2x the cap in base64 chars — must be rejected on length before any Buffer allocation.
    const huge = "A".repeat(COVER_MAX_BYTES * 2);
    expect(parseImageDataUrl(`data:image/png;base64,${huge}`)).toBeNull();
  });
  it("still accepts a payload right at the cap", () => {
    const atCap = Buffer.alloc(COVER_MAX_BYTES).toString("base64");
    const r = parseImageDataUrl(`data:image/png;base64,${atCap}`);
    expect(r?.bytes.length).toBe(COVER_MAX_BYTES);
  });
});

describe("toDataUrl", () => {
  it("round-trips with parseImageDataUrl", () => {
    const url = toDataUrl("image/webp", new Uint8Array([1, 2, 3]));
    expect(url.startsWith("data:image/webp;base64,")).toBe(true);
    expect(parseImageDataUrl(url)).toEqual({ contentType: "image/webp", bytes: new Uint8Array([1, 2, 3]) });
  });
});
