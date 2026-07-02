// src/gem/__tests__/contract.registry.test.ts
import { describe, it, expect } from "vitest";
import { registerRun, resolveRun, contractToExpectations } from "@agentgem/run";
import type { GemContract } from "@agentgem/model";

describe("run-registry meta", () => {
  it("round-trips gem meta through registerRun → resolveRun", () => {
    const contract: GemContract = { task: "t", expect: { tools: ["qa"] } };
    const id = registerRun("/tmp/x", "claude", { gemName: "g", gemDigest: "sha256:d", contract });
    const reg = resolveRun(id);
    expect(reg?.meta?.gemName).toBe("g");
    expect(reg?.meta?.gemDigest).toBe("sha256:d");
    expect(reg?.meta?.contract).toEqual(contract);
  });

  it("meta stays optional — bare registration still resolves", () => {
    const id = registerRun("/tmp/y", "codex");
    expect(resolveRun(id)).toEqual({ dir: "/tmp/y", agent: "codex" });
  });
});

describe("contractToExpectations", () => {
  it("maps every contract field onto GemExpectations", () => {
    expect(contractToExpectations({ task: "t", expect: { tools: ["a"], text: "ok", forbidToolFailures: false } }))
      .toEqual({ expectTools: ["a"], expectText: "ok", forbidToolFailures: false });
  });

  it("omits absent fields so verifyGemRun's defaults apply", () => {
    expect(contractToExpectations({ task: "t", expect: {} })).toEqual({});
  });
});
