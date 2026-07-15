import { describe, it, expect } from "vitest";
import { CAP_TOOL, TOOL_CAP, CAP_METHOD, AUTO_CAPS } from "@agentgem/play";

describe("capability <-> tool bijection", () => {
  it("maps every capability to its host tool", () => {
    expect(CAP_TOOL).toEqual({
      "session-data": "agentgem_get_session_data",
      "live-session-events": "agentgem_subscribe_sessions",
      "local-project-access": "agentgem_get_inventory",
      "invoke-agent": "agentgem_invoke_agent",
      "context-hygiene": "agentgem_subscribe_hygiene",
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

  it("session-data is the sole auto-approved capability; action caps stay consent-gated", () => {
    // Security invariant: only session-data bypasses the runtime consent prompt (implicit consent at
    // seed). importStudio's auto-declaration and the console's consent Runner both key off this — an
    // action cap like open-link must never be auto-approved.
    expect([...AUTO_CAPS]).toEqual(["session-data"]);
    const auto = new Set<string>(AUTO_CAPS);
    for (const cap of Object.keys(CAP_METHOD)) expect(auto.has(cap)).toBe(false);
  });
});
