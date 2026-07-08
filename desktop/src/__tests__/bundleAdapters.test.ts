import { describe, it, expect } from "vitest";
import { adapterInstallPlan } from "../../scripts/bundle-adapters.mjs";

describe("adapterInstallPlan", () => {
  it("produces one npm install per registry agent into its own prefix", () => {
    const agents = [
      { id: "claude-code", package: "@agentclientprotocol/claude-agent-acp", version: "0.51.0" },
      { id: "codex", package: "@agentclientprotocol/codex-acp", version: "1.1.0" },
    ];
    const plan = adapterInstallPlan(agents, "/out");
    expect(plan).toEqual([
      { prefix: "/out/claude-code", spec: "@agentclientprotocol/claude-agent-acp@0.51.0" },
      { prefix: "/out/codex", spec: "@agentclientprotocol/codex-acp@1.1.0" },
    ]);
  });
});
