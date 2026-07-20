import { describe, it, expect } from "vitest";
import { warmEnabled } from "@agentgem/app/appCommon";

describe("warmEnabled", () => {
  it("warms by default", () => {
    expect(warmEnabled({})).toBe(true);
  });

  it("never warms on the hosted api, which does not serve the console", () => {
    expect(warmEnabled({ SERVE_CONSOLE: "false" })).toBe(false);
  });

  it("lets AGENTGEM_WARM=off disable warming while still serving the console", () => {
    expect(warmEnabled({ AGENTGEM_WARM: "off" })).toBe(false);
    expect(warmEnabled({ AGENTGEM_WARM: "on" })).toBe(true);
    expect(warmEnabled({ AGENTGEM_WARM: "" })).toBe(true);
  });
});
