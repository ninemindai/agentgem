// src/gem/agentcorePublish.ts
// Publish a gem as a Bedrock AgentCore harness via CreateHarness. The control-plane client is injected
// so the network call is unit-testable with a fake (no live AWS). Skills are skip-and-reported: the API
// takes git/s3 sources, not the local skill files a gem carries.
import type { Gem, SecretRequirement } from "@agentgem/model";
import { buildAgentcoreHarness } from "@agentgem/model";
import type { SkippedArtifact } from "@agentgem/distribute";
import type { DeployPreview, DeployResult } from "./deploy.js";
import type { DeployRecord } from "@agentgem/base";

export interface AgentcoreControlClient {
  createHarness(req: Record<string, unknown>): Promise<{ arn: string; harnessId: string; harnessName: string; harnessVersion: string; status: string; failureReason?: string }>;
  getHarness(harnessId: string): Promise<{ status: string; harnessVersion: string; failureReason?: string }>;
  deleteHarness(harnessId: string): Promise<void>;
}

// CreateHarness returns while the harness is still CREATING; these gate the poll-to-terminal loop.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 40;
const isTerminalHarnessStatus = (s: string): boolean => /ready|fail/i.test(s);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// CreateHarness harnessName pattern: [a-zA-Z][a-zA-Z0-9_]{0,39}
export function harnessNameFor(gem: Gem): string {
  let n = (gem.name || "agent").replace(/[^a-zA-Z0-9_]/g, "");
  if (!/^[a-zA-Z]/.test(n)) n = "a" + n;
  return n.slice(0, 40) || "agent";
}

export function buildCreateHarnessRequest(gem: Gem, opts: { executionRoleArn: string }): { request: Record<string, unknown>; skipped: SkippedArtifact[]; vaultSecrets: SecretRequirement[] } {
  const { harness, skipped } = buildAgentcoreHarness(gem); // systemPrompt + tools + (path) skills + model
  const skills = gem.artifacts.filter((a) => a.type === "skill");
  for (const s of skills) skipped.push({ artifact: s.name, type: "skill", reason: "AgentCore publish needs a git/s3 skill source; local skill not carried by the gem" });
  const request: Record<string, unknown> = {
    harnessName: harnessNameFor(gem),
    executionRoleArn: opts.executionRoleArn,
    model: harness.model,
  };
  if (harness.systemPrompt) request.systemPrompt = harness.systemPrompt;
  if (harness.tools) request.tools = harness.tools;
  // NOTE: harness.skills (local path-skills) are intentionally NOT forwarded — publish can't upload files.
  return { request, skipped, vaultSecrets: gem.requiredSecrets };
}

export function agentcorePublishReady(): boolean {
  const hasId = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
  const hasRegion = !!(process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION);
  return hasId && hasRegion && !!process.env.AGENTCORE_EXECUTION_ROLE_ARN;
}

export function realAgentcoreControlClient(): AgentcoreControlClient {
  return {
    async createHarness(req) {
      // Lazy import so the SDK isn't loaded unless a real publish runs.
      const { BedrockAgentCoreControlClient, CreateHarnessCommand } = await import("@aws-sdk/client-bedrock-agentcore-control");
      const client = new BedrockAgentCoreControlClient({});
      const out = await client.send(new CreateHarnessCommand(req as never));
      const h = (out as { harness?: Record<string, unknown> }).harness ?? {};
      return {
        arn: String(h.arn ?? ""), harnessId: String(h.harnessId ?? ""), harnessName: String(h.harnessName ?? ""),
        harnessVersion: String(h.harnessVersion ?? ""), status: String(h.status ?? ""), failureReason: h.failureReason as string | undefined,
      };
    },
    async getHarness(harnessId) {
      const { BedrockAgentCoreControlClient, GetHarnessCommand } = await import("@aws-sdk/client-bedrock-agentcore-control");
      const client = new BedrockAgentCoreControlClient({});
      const out = await client.send(new GetHarnessCommand({ harnessId } as never));
      const h = (out as { harness?: Record<string, unknown> }).harness ?? {};
      return { status: String(h.status ?? ""), harnessVersion: String(h.harnessVersion ?? ""), failureReason: h.failureReason as string | undefined };
    },
    async deleteHarness(harnessId) {
      const { BedrockAgentCoreControlClient, DeleteHarnessCommand } = await import("@aws-sdk/client-bedrock-agentcore-control");
      const c = new BedrockAgentCoreControlClient({});
      await c.send(new DeleteHarnessCommand({ harnessId } as never));
    },
  };
}

export async function undeployAgentcoreHarness(rec: DeployRecord, client: AgentcoreControlClient): Promise<void> {
  if (rec.harnessId) await client.deleteHarness(rec.harnessId);
}

export function previewAgentcorePublish(gem: Gem): DeployPreview {
  const roleArn = process.env.AGENTCORE_EXECUTION_ROLE_ARN || "arn:aws:iam::ACCOUNT:role/REPLACE_WITH_HARNESS_ROLE";
  const { request, skipped, vaultSecrets } = buildCreateHarnessRequest(gem, { executionRoleArn: roleArn });
  return { kind: "agentcore-harness", request, skipped, vaultSecrets };
}

export async function deployAgentcorePublish(gem: Gem, _requestId: string, client: AgentcoreControlClient = realAgentcoreControlClient()): Promise<DeployResult> {
  const roleArn = process.env.AGENTCORE_EXECUTION_ROLE_ARN;
  if (!roleArn) throw new Error("AGENTCORE_EXECUTION_ROLE_ARN is not set — cannot create an AgentCore harness (execution role required).");
  const { request, skipped, vaultSecrets } = buildCreateHarnessRequest(gem, { executionRoleArn: roleArn });
  const h = await client.createHarness(request);
  // Poll GetHarness until the harness reaches a terminal state (READY or *FAILED*); CreateHarness
  // returns while still CREATING. Polls immediately (no leading sleep) and stops on terminal/attempts.
  let status = h.status;
  let harnessVersion = h.harnessVersion;
  for (let i = 0; i < POLL_MAX_ATTEMPTS && !isTerminalHarnessStatus(status); i++) {
    const g = await client.getHarness(h.harnessId);
    status = g.status;
    harnessVersion = g.harnessVersion || harnessVersion;
    if (isTerminalHarnessStatus(status)) break;
    await sleep(POLL_INTERVAL_MS);
  }
  return { kind: "agentcore-harness", harnessArn: h.arn, harnessId: h.harnessId, harnessName: h.harnessName, harnessVersion, status, skipped, vaultSecrets };
}
