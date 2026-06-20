// src/gem/deploy.ts
// Deploy backends as a registry (mirrors TARGET_REGISTRY for materialize). Each DeployTarget renders
// a Gem offline (preview), reports whether the server is configured for it (ready), and performs the
// gated network deploy (deploy). Reuses the existing pure render + network orchestration unchanged.
import type { Gem, SecretRequirement } from "./types.js";
import { renderManagedAgent } from "./publish.js";
import type { ManagedAgentRender, ManagedAgentPayload, SkippedArtifact } from "./publish.js";
import { publishManagedAgent, publishManagedAgentOnce, anthropicPublishClient } from "../publish.js";
import type { PublishResult } from "../publish.js";
import { previewAgentcorePublish, deployAgentcorePublish, agentcorePublishReady } from "./agentcorePublish.js";

export type DeployTargetId = "claude-managed" | "agentcore-managed";

export type DeployPreview =
  | { kind: "managed-agent"; payload: ManagedAgentPayload; skillsToRegister: string[]; skipped: SkippedArtifact[]; vaultSecrets: SecretRequirement[] }
  | { kind: "agentcore-harness"; request: Record<string, unknown>; skipped: SkippedArtifact[]; vaultSecrets: SecretRequirement[] };

export type DeployResult =
  | ({ kind: "managed-agent" } & PublishResult)
  | { kind: "agentcore-harness"; harnessArn: string; harnessId: string; harnessName: string; harnessVersion: string; status: string; skipped: SkippedArtifact[]; vaultSecrets: SecretRequirement[] };

export interface DeployTarget {
  id: DeployTargetId;
  label: string;
  preview(gem: Gem): DeployPreview;   // wire-ready, pure, offline
  ready(): boolean;                    // server configured for this backend
  deploy(gem: Gem, requestId: string): Promise<DeployResult>;   // gated; throws if not ready
}

const managedAgentPreview = (gem: Gem): DeployPreview => {
  const r: ManagedAgentRender = renderManagedAgent(gem);
  return { kind: "managed-agent", payload: r.payload, skillsToRegister: r.skillsToRegister.map((s) => s.name), skipped: r.skipped, vaultSecrets: r.vaultSecrets };
};

export const DEPLOY_REGISTRY = {
  "claude-managed": {
    id: "claude-managed",
    label: "Claude Managed Agents",
    preview: managedAgentPreview,
    ready: () => !!process.env.ANTHROPIC_API_KEY,
    deploy: async (gem, requestId) => {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the server — cannot deploy to Claude Managed Agents.");
      // The idempotency fingerprint relies on buildGem's stable ordering: identical retries must
      // serialize to the same string, so don't make buildGem ordering non-deterministic.
      const r = await publishManagedAgentOnce(requestId, JSON.stringify(gem), () => publishManagedAgent(gem, anthropicPublishClient(key)));
      return { kind: "managed-agent", ...r };
    },
  },
  "agentcore-managed": {
    id: "agentcore-managed",
    label: "AgentCore Harness",
    preview: previewAgentcorePublish,
    ready: agentcorePublishReady,
    deploy: (gem, requestId) => deployAgentcorePublish(gem, requestId),
  },
} as const satisfies Record<DeployTargetId, DeployTarget>;

export const deployTargetIds = Object.keys(DEPLOY_REGISTRY) as [DeployTargetId, ...DeployTargetId[]];

export function deployTargetList(): { id: DeployTargetId; label: string; ready: boolean }[] {
  return deployTargetIds.map((id) => ({ id, label: DEPLOY_REGISTRY[id].label, ready: DEPLOY_REGISTRY[id].ready() }));
}
