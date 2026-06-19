// src/gem/deploy.ts
// Deploy backends as a registry (mirrors TARGET_REGISTRY for materialize). Each DeployTarget renders
// a Gem offline (preview), reports whether the server is configured for it (ready), and performs the
// gated network deploy (deploy). Reuses the existing pure render + network orchestration unchanged.
import type { Gem } from "./types.js";
import { renderManagedAgent } from "./publish.js";
import type { ManagedAgentRender } from "./publish.js";
import { publishManagedAgent, publishManagedAgentOnce, anthropicPublishClient } from "../publish.js";
import type { PublishResult } from "../publish.js";

export type DeployTargetId = "claude-managed";

export interface DeployTarget {
  id: DeployTargetId;
  label: string;
  preview(pack: Gem): ManagedAgentRender;                          // pure, offline
  ready(): boolean;                                                 // server configured for this backend
  deploy(pack: Gem, requestId: string): Promise<PublishResult>;   // gated; throws if not ready
}

export const DEPLOY_REGISTRY: Record<DeployTargetId, DeployTarget> = {
  "claude-managed": {
    id: "claude-managed",
    label: "Claude Managed Agents",
    preview: (pack) => renderManagedAgent(pack),
    ready: () => !!process.env.ANTHROPIC_API_KEY,
    deploy: async (pack, requestId) => {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set on the server — cannot deploy to Claude Managed Agents.");
      // The idempotency fingerprint relies on buildPack's stable ordering: identical retries must
      // serialize to the same string, so don't make buildPack ordering non-deterministic.
      return publishManagedAgentOnce(requestId, JSON.stringify(pack), () => publishManagedAgent(pack, anthropicPublishClient(key)));
    },
  },
};

export const deployTargetIds = Object.keys(DEPLOY_REGISTRY) as [DeployTargetId, ...DeployTargetId[]];

export function deployTargetList(): { id: DeployTargetId; label: string; ready: boolean }[] {
  return deployTargetIds.map((id) => ({ id, label: DEPLOY_REGISTRY[id].label, ready: DEPLOY_REGISTRY[id].ready() }));
}
