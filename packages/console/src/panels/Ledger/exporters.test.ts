import { describe, it, expect } from "vitest";
import { base64ToBytes } from "./exporters.js";

describe("base64ToBytes", () => {
  it("decodes base64 to the original bytes", () => {
    const bytes = base64ToBytes(btoa("hello"));
    expect(Array.from(bytes)).toEqual([..."hello"].map((c) => c.charCodeAt(0)));
  });

  it("handles binary bytes (0x00..0xff)", () => {
    const b64 = btoa(String.fromCharCode(0, 1, 254, 255));
    expect(Array.from(base64ToBytes(b64))).toEqual([0, 1, 254, 255]);
  });
});
