// src/gem/__tests__/deploy.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { DEPLOY_REGISTRY, deployTargetIds, deployTargetList } from "@agentgem/deploy";
import { renderManagedAgent } from "@agentgem/distribute";
import type { Gem, GemArtifact } from "@agentgem/model";

const gem = (artifacts: GemArtifact[]): Gem => ({ name: "p", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [] });
const skill = (n: string): GemArtifact => ({ type: "skill", name: n, source: "standalone", content: "# body" });

const savedKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });

describe("deploy registry", () => {
  it("exposes claude-managed", () => {
    expect(deployTargetIds).toContain("claude-managed");
    expect(DEPLOY_REGISTRY["claude-managed"].label).toBe("Claude Managed Agents");
  });

  it("preview is a wire-ready tagged DeployPreview (kind=managed-agent)", () => {
    const p = gem([skill("review")]);
    const preview = DEPLOY_REGISTRY["claude-managed"].preview(p);
    const render = renderManagedAgent(p);
    expect(preview.kind).toBe("managed-agent");
    expect(preview.skipped).toEqual(render.skipped);
    expect(preview.vaultSecrets).toEqual(render.vaultSecrets);
    if (preview.kind === "managed-agent") {
      expect(preview.payload).toEqual(render.payload);
      expect(preview.skillsToRegister).toEqual(render.skillsToRegister.map((s) => s.name));
    }
  });

  it("ready reflects ANTHROPIC_API_KEY; deployTargetList carries it", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(DEPLOY_REGISTRY["claude-managed"].ready()).toBe(false);
    expect(deployTargetList()).toEqual([
      { id: "claude-managed", label: "Claude Managed Agents", ready: false },
      { id: "agentcore-managed", label: "AgentCore Harness", ready: false },
    ]);
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(DEPLOY_REGISTRY["claude-managed"].ready()).toBe(true);
  });

  it("deploy throws (no network) when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(DEPLOY_REGISTRY["claude-managed"].deploy(gem([skill("a")]), "req-12345678")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
