// packages/console/src/panels/Play/__tests__/capTool.drift.test.ts
// The console cannot import @agentgem/play's barrel at RUNTIME — it is bundled for the browser and the
// barrel pulls node:os/node:path. So consent.ts keeps a browser-safe mirror of the canonical map. This
// test runs in Node, where the import is free, and fails the moment the two drift apart.
import { describe, it, expect } from "vitest";
import { CAP_TOOL as CANONICAL, CAP_METHOD, AUTO_CAPS as CANONICAL_AUTO } from "@agentgem/play";
import { CAP_TOOL, TOOL_CAP, CONSENT_CAPS, AUTO_CAPS } from "../consent.js";

describe("console CAP_TOOL mirrors @agentgem/model's canonical map", () => {
  it("has identical entries", () => {
    expect(CAP_TOOL).toEqual(CANONICAL);
  });
  it("TOOL_CAP is its exact inverse", () => {
    for (const [cap, tool] of Object.entries(CAP_TOOL)) expect(TOOL_CAP[tool]).toBe(cap);
    expect(Object.keys(TOOL_CAP)).toHaveLength(Object.keys(CAP_TOOL).length);
  });
  it("CONSENT_CAPS covers every ActionCapability", () => {
    for (const cap of Object.keys(CAP_METHOD)) expect(CONSENT_CAPS).toContain(cap);
  });
  it("AUTO_CAPS mirrors the canonical auto-approved set", () => {
    expect([...AUTO_CAPS].sort()).toEqual([...CANONICAL_AUTO].sort());
  });
});
