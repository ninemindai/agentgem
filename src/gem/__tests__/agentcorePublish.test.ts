import { describe, it, expect, afterEach } from "vitest";
import type { Gem } from "../types.js";
import {
  harnessNameFor, buildCreateHarnessRequest, agentcorePublishReady,
  previewAgentcorePublish, deployAgentcorePublish, undeployAgentcoreHarness, type AgentcoreControlClient,
} from "../agentcorePublish.js";

const gem = (over: Partial<Gem> = {}): Gem => ({
  name: "research agent!", createdFrom: "/d",
  artifacts: [
    { type: "skill", name: "scrape", source: "standalone", content: "# body" },
    { type: "mcp_server", name: "exa", transport: "http", config: { url: "https://mcp.x/sse" }, secretRefs: [{ name: "X_TOKEN", location: "headers.Authorization" }] },
    { type: "instructions", name: "CLAUDE.md", content: "be terse" },
  ],
  checks: [], requiredSecrets: [{ name: "X_TOKEN", artifact: "exa", location: "headers.Authorization" }], ...over,
});
const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe("agentcore publish helpers", () => {
  it("harnessNameFor sanitizes to the CreateHarness pattern", () => {
    expect(harnessNameFor(gem())).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
  });
  it("buildCreateHarnessRequest sets required fields, maps tools, skips local skills, no raw secret", () => {
    const { request, skipped, vaultSecrets } = buildCreateHarnessRequest(gem(), { executionRoleArn: "arn:aws:iam::123456789012:role/HarnessRole" });
    expect(request.executionRoleArn).toBe("arn:aws:iam::123456789012:role/HarnessRole");
    expect(request.harnessName).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
    expect(request.systemPrompt).toEqual([{ text: expect.stringContaining("be terse") }]);
    expect((request.tools as Array<{ name: string }>)[0].name).toBe("exa");
    expect(request.skills).toBeUndefined();                                  // local skills not carried
    expect(skipped.some((s) => s.artifact === "scrape" && /git\/s3/.test(s.reason))).toBe(true);
    expect(vaultSecrets).toContainEqual({ name: "X_TOKEN", artifact: "exa", location: "headers.Authorization" });
    expect(JSON.stringify(request)).not.toContain("<redacted>");
  });
  it("agentcorePublishReady requires creds AND an execution role arn", () => {
    delete process.env.AWS_PROFILE; delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AGENTCORE_EXECUTION_ROLE_ARN;
    expect(agentcorePublishReady()).toBe(false);
    process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    expect(agentcorePublishReady()).toBe(false);                            // role still missing
    process.env.AGENTCORE_EXECUTION_ROLE_ARN = "arn:aws:iam::123456789012:role/HarnessRole";
    expect(agentcorePublishReady()).toBe(true);
  });
});

describe("deployAgentcorePublish", () => {
  it("throws without an execution role", async () => {
    delete process.env.AGENTCORE_EXECUTION_ROLE_ARN;
    process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    const fake: AgentcoreControlClient = { createHarness: async () => { throw new Error("should not be called"); }, getHarness: async () => ({ status: "READY", harnessVersion: "1" }), deleteHarness: async () => {} };
    await expect(deployAgentcorePublish(gem(), "req-abcdefghijklmnopqrstuvwxyz123456", fake)).rejects.toThrow(/execution role/i);
  });
  it("calls the injected client and returns a kind=agentcore-harness result", async () => {
    process.env.AGENTCORE_EXECUTION_ROLE_ARN = "arn:aws:iam::123456789012:role/HarnessRole";
    process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    let seen: Record<string, unknown> | null = null;
    const fake: AgentcoreControlClient = {
      createHarness: async (req) => { seen = req; return { arn: "arn:aws:bedrock-agentcore:us-west-2:123:harness/Researchagent-Ab12", harnessId: "Researchagent-Ab12", harnessName: "Researchagent", harnessVersion: "1", status: "READY" }; },
      getHarness: async () => ({ status: "READY", harnessVersion: "1" }),
      deleteHarness: async () => {},
    };
    const res = await deployAgentcorePublish(gem(), "req-abcdefghijklmnopqrstuvwxyz123456", fake);
    expect(seen!.harnessName).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/);
    expect(res.kind).toBe("agentcore-harness");
    if (res.kind === "agentcore-harness") { expect(res.harnessArn).toContain("harness/"); expect(res.status).toBe("READY"); }
  });
  it("undeployAgentcoreHarness calls deleteHarness with the recorded id", async () => {
    let deleted = "";
    const client = { deleteHarness: async (id: string) => { deleted = id; } } as any;
    await undeployAgentcoreHarness({ backend: "agentcore", harnessId: "h1" }, client);
    expect(deleted).toBe("h1");
  });
  it("polls GetHarness until terminal when CreateHarness returns CREATING (no GetHarness call when already terminal)", async () => {
    process.env.AGENTCORE_EXECUTION_ROLE_ARN = "arn:aws:iam::123456789012:role/HarnessRole";
    process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    let getCalls = 0;
    const fake: AgentcoreControlClient = {
      createHarness: async () => ({ arn: "arn:aws:bedrock-agentcore:us-west-2:123:harness/G-Ab12", harnessId: "G-Ab12", harnessName: "G", harnessVersion: "1", status: "CREATING" }),
      getHarness: async () => { getCalls++; return { status: "READY", harnessVersion: "2" }; },
      deleteHarness: async () => {},
    };
    const res = await deployAgentcorePublish(gem(), "req-abcdefghijklmnopqrstuvwxyz123456", fake);
    expect(getCalls).toBe(1);                       // polled once, then terminal -> stop (no sleep)
    if (res.kind === "agentcore-harness") { expect(res.status).toBe("READY"); expect(res.harnessVersion).toBe("2"); }
  });
});
