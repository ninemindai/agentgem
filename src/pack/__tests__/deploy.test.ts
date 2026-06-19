// src/pack/__tests__/deploy.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { DEPLOY_REGISTRY, deployTargetIds, deployTargetList } from "../deploy.js";
import { renderManagedAgent } from "../publish.js";
import type { Pack, PackArtifact } from "../types.js";

const pack = (artifacts: PackArtifact[]): Pack => ({ name: "p", createdFrom: "/d", artifacts, checks: [], requiredSecrets: [] });
const skill = (n: string): PackArtifact => ({ type: "skill", name: n, source: "standalone", content: "# body" });

const savedKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });

describe("deploy registry", () => {
  it("exposes claude-managed", () => {
    expect(deployTargetIds).toContain("claude-managed");
    expect(DEPLOY_REGISTRY["claude-managed"].label).toBe("Claude Managed Agents");
  });

  it("preview equals renderManagedAgent", () => {
    const p = pack([skill("review")]);
    expect(DEPLOY_REGISTRY["claude-managed"].preview(p)).toEqual(renderManagedAgent(p));
  });

  it("ready reflects ANTHROPIC_API_KEY; deployTargetList carries it", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(DEPLOY_REGISTRY["claude-managed"].ready()).toBe(false);
    expect(deployTargetList()).toEqual([{ id: "claude-managed", label: "Claude Managed Agents", ready: false }]);
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(DEPLOY_REGISTRY["claude-managed"].ready()).toBe(true);
  });

  it("deploy throws (no network) when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(DEPLOY_REGISTRY["claude-managed"].deploy(pack([skill("a")]), "req-12345678")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
