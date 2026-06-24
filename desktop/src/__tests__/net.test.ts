import { describe, it, expect } from "vitest";
import { getFreePort } from "../net.js";

describe("getFreePort", () => {
  it("returns a usable TCP port number", async () => {
    const port = await getFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(1023);
    expect(port).toBeLessThan(65536);
  });
});
