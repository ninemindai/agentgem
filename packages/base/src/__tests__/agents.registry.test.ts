// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { AGENTS } from "../agents.js";

describe("AGENTS registry provenance", () => {
  it("every agent carries an npm package and a pinned version", () => {
    for (const a of AGENTS) {
      expect(a.package, `${a.id} package`).toMatch(/^@agentclientprotocol\//);
      expect(a.version, `${a.id} version`).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
  it("codex + claude-code are pinned to the vetted versions", () => {
    expect(AGENTS.find((a) => a.id === "codex")?.version).toBe("1.1.0");
    expect(AGENTS.find((a) => a.id === "claude-code")?.version).toBe("0.51.0");
  });
});
