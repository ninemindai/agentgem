// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Cloud-deploy routes (Vercel / Cloudflare / Claude-managed / AgentCore) and the credential
// sink they use. Split out of the gem controller so the gem controller carries no deploy deps.
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import type { RestApplication } from "@agentback/rest";
import { DEPLOY_REGISTRY, deployGem, deployTargetList } from "@agentgem/deploy";
import type { DeployTargetId } from "@agentgem/deploy";
import { undeployManagedAgent, anthropicPublishClient } from "@agentgem/deploy";
import { undeployAgentcoreHarness, realAgentcoreControlClient } from "@agentgem/deploy";
import { agentcoreReadiness, deployAgentcore, getAgentcoreStatus } from "@agentgem/deploy";
import { deployVercel, deployCloudflare, undeployVercel, undeployCloudflare } from "@agentgem/run";
import { readDeployRecord, writeDeployRecord, clearDeployRecord } from "@agentgem/base";
import type { DeployBackend } from "@agentgem/base";
import { setCredential } from "@agentgem/capture";
import { buildGem } from "@agentgem/build";
import { resolveDirs } from "@agentgem/model";
import { introspectAll } from "./introspectAll.js";
import { RUN_CLOUD_DISPATCH, type RunCloudDispatch } from "./hostedBindings.js";
import {
  CredentialRequestSchema, CredentialResponseSchema,
  AgentcoreReadyResponseSchema, AgentcoreDeployRequestSchema, AgentcoreDeployStateSchema, AgentcoreStatusQuerySchema,
  PickQuerySchema, DeployTargetsResponseSchema,
  PublishPreviewRequestSchema, PublishPreviewResponseSchema,
  DeployReadyQuerySchema, PublishReadyResponseSchema,
  PublishRequestSchema, PublishResultSchema,
  UndeployRequestSchema, UndeployResponseSchema,
  DeployRecordQuerySchema, DeployRecordResponseSchema,
} from "./schemas.js";

// The cloud branches of POST /api/run, wrapped behind the RUN_CLOUD_DISPATCH binding so the
// gem controller's /run can delegate without importing the deploy fns.
export const runCloudDispatch: RunCloudDispatch = (mode, name, opts) =>
  mode === "cloudflare" ? deployCloudflare(name) : deployVercel(name, undefined, { eveAuth: opts.eveAuth });

@api({ basePath: "/api" })
export class DeployController {
  // OUTWARD-FACING (local machine): set + persist a server-side deploy/publish credential
  // (allowlisted keys only) to ~/.agentgem/.env. The value is never logged or returned.
  @post("/credential", { body: CredentialRequestSchema, response: CredentialResponseSchema })
  async credential(input: { body: z.infer<typeof CredentialRequestSchema> }): Promise<z.infer<typeof CredentialResponseSchema>> {
    setCredential(input.body.key, input.body.value);
    return { ok: true };
  }

  @get("/agentcore/deploy-ready", { query: PickQuerySchema, response: AgentcoreReadyResponseSchema })
  async agentcoreDeployReady(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof AgentcoreReadyResponseSchema>> {
    return agentcoreReadiness();
  }

  // OUTWARD-FACING: shells the agentcore CLI to deploy the workspace's rendered project to AWS.
  @post("/agentcore/deploy", { body: AgentcoreDeployRequestSchema, response: AgentcoreDeployStateSchema })
  async agentcoreDeploy(input: { body: z.infer<typeof AgentcoreDeployRequestSchema> }): Promise<z.infer<typeof AgentcoreDeployStateSchema>> {
    return deployAgentcore(input.body.name);
  }

  @get("/agentcore/deploy-status", { query: AgentcoreStatusQuerySchema, response: AgentcoreDeployStateSchema })
  async agentcoreDeployStatus(input: { query: z.infer<typeof AgentcoreStatusQuerySchema> }): Promise<z.infer<typeof AgentcoreDeployStateSchema>> {
    return getAgentcoreStatus(input.query.name);
  }

  @get("/deploy-targets", { query: PickQuerySchema, response: DeployTargetsResponseSchema })
  async deployTargets(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof DeployTargetsResponseSchema>> {
    return { targets: deployTargetList() };
  }

  // Offline render of the deploy payload + skip/secret/skill lists. No network.
  @post("/publish-preview", { body: PublishPreviewRequestSchema, response: PublishPreviewResponseSchema })
  async publishPreview(input: { body: z.infer<typeof PublishPreviewRequestSchema> }): Promise<z.infer<typeof PublishPreviewResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir, channels: input.body.channels });
    const target = (input.body.target ?? "claude-managed") as DeployTargetId;
    return DEPLOY_REGISTRY[target].preview(gem);
  }

  // Whether the server is configured for the deploy backend (the UI gates on this). Boolean only.
  @get("/publish-ready", { query: DeployReadyQuerySchema, response: PublishReadyResponseSchema })
  async publishReady(input: { query: z.infer<typeof DeployReadyQuerySchema> }): Promise<z.infer<typeof PublishReadyResponseSchema>> {
    const target = (input.query.target ?? "claude-managed") as DeployTargetId;
    return { ready: DEPLOY_REGISTRY[target].ready() };
  }

  // OUTWARD-FACING: gated network deploy through the selected backend. The key is read server-side
  // (inside the registry's deploy) and never returned; only the redacted gem payload is sent.
  @post("/publish", { body: PublishRequestSchema, response: PublishResultSchema })
  async publish(input: { body: z.infer<typeof PublishRequestSchema> }): Promise<z.infer<typeof PublishResultSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir, channels: input.body.channels });
    const target = (input.body.target ?? "claude-managed") as DeployTargetId;
    const result = await deployGem(target, gem, input.body.requestId);
    if (input.body.wsName) {
      const at = new Date().toISOString();
      if (result.kind === "managed-agent") {
        writeDeployRecord(input.body.wsName, {
          backend: "claude-managed", at,
          agentId: result.agentId, environmentId: result.environmentId,
          skillIds: result.registeredSkills.map((s) => s.skillId),
        });
      } else if (result.kind === "agentcore-harness") {
        writeDeployRecord(input.body.wsName, { backend: "agentcore", at, harnessId: result.harnessId });
      }
    }
    return result;
  }

  @post("/undeploy", { body: UndeployRequestSchema, response: UndeployResponseSchema })
  async undeploy(input: { body: z.infer<typeof UndeployRequestSchema> }): Promise<z.infer<typeof UndeployResponseSchema>> {
    const { name, target } = input.body;
    if (target === "eve") {
      const r = await undeployVercel(name);
      if (!r.removed) throw new Error(`Vercel undeploy failed for "${name}". Check logs.`);
      return { removed: true, logTail: r.logTail };
    }
    if (target === "flue") {
      const r = await undeployCloudflare(name);
      if (!r.removed) throw new Error(`Cloudflare undeploy failed for "${name}". Check logs.`);
      return { removed: true, logTail: r.logTail };
    }
    if (target === "claude-managed") {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set — cannot undeploy from Claude Managed Agents.");
      const rec = readDeployRecord(name, "claude-managed");
      if (!rec) throw new Error(`No claude-managed deploy record for workspace "${name}".`);
      await undeployManagedAgent(rec, anthropicPublishClient(key));
      clearDeployRecord(name, "claude-managed");
      return { removed: true };
    }
    // agentcore
    const rec = readDeployRecord(name, "agentcore");
    if (!rec) throw new Error(`No agentcore deploy record for workspace "${name}".`);
    await undeployAgentcoreHarness(rec, realAgentcoreControlClient());
    clearDeployRecord(name, "agentcore");
    return { removed: true };
  }

  @get("/deploy-record", { query: DeployRecordQuerySchema, response: DeployRecordResponseSchema })
  async deployRecord(input: { query: z.infer<typeof DeployRecordQuerySchema> }): Promise<z.infer<typeof DeployRecordResponseSchema>> {
    const rec = readDeployRecord(input.query.name, input.query.backend as DeployBackend);
    return { record: rec as Record<string, unknown> | null };
  }
}

export function registerDeploy(app: RestApplication): void {
  app.restController(DeployController);
  app.bind(RUN_CLOUD_DISPATCH).to(runCloudDispatch);
}
