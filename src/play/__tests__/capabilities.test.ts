import { describe, it, expect } from "vitest";
import { CAP_TOOL, TOOL_CAP } from "@agentgem/play";

describe("capability <-> tool bijection", () => {
  it("maps every capability to its host tool", () => {
    expect(CAP_TOOL).toEqual({
      "session-data": "agentgem_get_session_data",
      "live-session-events": "agentgem_subscribe_sessions",
      "local-project-access": "agentgem_get_inventory",
      "invoke-agent": "agentgem_invoke_agent",
    });
  });

  it("TOOL_CAP is the exact inverse", () => {
    for (const [cap, tool] of Object.entries(CAP_TOOL)) expect(TOOL_CAP[tool]).toBe(cap);
    expect(Object.keys(TOOL_CAP)).toHaveLength(Object.keys(CAP_TOOL).length);
  });

  it("no tool name is a substring of another (the scan relies on this)", () => {
    const tools = Object.values(CAP_TOOL);
    for (const a of tools) for (const b of tools) if (a !== b) expect(b.includes(a)).toBe(false);
  });
});
