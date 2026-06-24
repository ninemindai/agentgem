import { describe, it, expect } from "vitest";
import { DESKTOP_NAME } from "../version.js";

describe("version", () => {
  it("exposes the desktop name", () => {
    expect(DESKTOP_NAME).toBe("AgentGem");
  });
});
