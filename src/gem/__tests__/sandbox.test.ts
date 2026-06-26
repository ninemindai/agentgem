// src/gem/__tests__/sandbox.test.ts
import { describe, it, expect } from "vitest";
import { selectRunBackend, envPermission, type SandboxBackend } from "../sandbox.js";

const fake = (id: string, isolated: boolean, available: boolean): SandboxBackend => ({
  id, isolated, available: () => available,
  connectFn: () => async () => ({ ctx: { open: async () => ({ setMode: async () => {}, prompt: async () => ({ text: "", toolCalls: [] }), dispose: () => {} }) }, close: () => {} }),
});

describe("selectRunBackend", () => {
  it("prefers the first available isolated backend", () => {
    const reg = [fake("iso-a", true, false), fake("iso-b", true, true), fake("child-spawn", false, true)];
    expect(selectRunBackend("/runs/g", reg).backend.id).toBe("iso-b");
  });

  it("falls back to child-spawn when no isolated backend is available", () => {
    const reg = [fake("iso-a", true, false), fake("child-spawn", false, true)];
    expect(selectRunBackend("/runs/g", reg).backend.id).toBe("child-spawn");
  });
});

describe("envPermission", () => {
  it("is deny by default and allow only when the opt-in flag is set", () => {
    expect(envPermission({})).toBe("deny");
    expect(envPermission({ AGENTGEM_GEM_RUN_AUTOALLOW: "1" })).toBe("allow");
  });
});
