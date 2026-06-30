#!/usr/bin/env node
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/distill/mcpServer.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import { MCPApplication, mcpServer, tool } from "@agentback/mcp";
import { isMain } from "@agentback/core";
import { GemSelectionSchema } from "../schemas.js";
import type { ConfigInventory, Gem, ProjectInventory } from "@agentgem/model";
import type { WorkflowSignal } from "@agentgem/insight";
import { buildGem, type GemSelection } from "@agentgem/build";
import { canonicalHarness, canonicalModel, canonicalMcpServer, canonicalSkill } from "@agentgem/model";
import { buildAttestation, signAttestation, canonicalJSON, type UsageAttestation } from "@agentgem/insight";
import { writeGemArchive, computeLock } from "@agentgem/archive";
import { writeAttestedArchive } from "@agentgem/insight";
import { loadOrCreateIdentity } from "@agentgem/model";
import { postAttestation } from "@agentgem/insight";

// ---- pure handlers (unit-tested) ----
export function inspectIngredientsTool(input: { inventory: ConfigInventory; signal: WorkflowSignal; salt: string }) {
  return {
    harness: canonicalHarness(input.signal.flavor),
    models: input.signal.models.map((m) => canonicalModel(m.id).id),
    skills: input.inventory.skills.map((s) => canonicalSkill(s, input.salt)),
    mcps: input.inventory.mcpServers.map((m) => canonicalMcpServer(m, input.salt)),
  };
}

export function buildAttestationTool(input: { inventory: ConfigInventory; signal: WorkflowSignal; selection: GemSelection; salt: string; account?: { provider: string; login: string } | null; facets?: SessionFacet[] }) {
  const gem: Gem = buildGem(input.inventory, input.selection, { createdFrom: input.signal.flavor });
  // attestation.gem.digest ties to the PUBLISHED archive: it is the pre-attestation archive
  // payload digest (computeLock over the gem archive WITHOUT attestation.json). writeAttestedArchive
  // later adds attestation.json and recomputes the FULL lock (= the archive digest); the two are
  // intentionally different and reconcilable — remove attestation.json, recompute computeLock.
  const { files } = writeGemArchive(gem);
  const gemDigest = computeLock(files).gemDigest;
  const attestation = buildAttestation({ gem, signal: input.signal, gemDigest, salt: input.salt, account: input.account ?? null, facets: input.facets });
  const ids = [...attestation.ingredients.skills, ...attestation.ingredients.mcps].map((i) => i.id);
  return { attestation, gemPreview: gem, willPublish: ids };
}

// ---- runtime context loader (real env) ----
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { scanWorkflow, claudeTranscriptsForCwd, judgeSessions } from "@agentgem/insight";
import type { SessionFacet } from "@agentgem/insight";

export interface ToolDeps {
  loadContext: (cwd: string) => { inventory: ConfigInventory; signal: WorkflowSignal };
  publish?: (gem: Gem, files: Record<string, string>) => Promise<{ ref: string }>;
  salt?: string; // fixed salt for reproducible builds/tests; else random per call
  token?: string;
  // Judge sessions into per-model outcomes (the ACP agent). Opt-in: only called
  // when a tool requests includeOutcomes, so the default publish stays agent-free.
  // Returns degraded:true when the agent fell back to neutral heuristics — those
  // outcomes must NOT be published, or they pollute the network benchmark.
  judge?: (signal: WorkflowSignal) => Promise<{ facets: SessionFacet[]; degraded: boolean }>;
}

// The scan resolves a Skill/mcp__ invocation against BOTH project-local and
// GLOBAL artifacts. Real usage is dominated by global skills/MCPs, so the scan
// MUST receive the global inventory or every global ingredient falls to
// `unresolved` and the attestation counts come back empty (mirrors workflowStream).
export function scanInventoryFor(globalInv: ConfigInventory, project: ProjectInventory) {
  return { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
}

export function realDeps(): ToolDeps {
  return {
    loadContext(cwd) {
      const inventory = introspectConfig();
      const scanInv = scanInventoryFor(inventory, introspectProject(cwd));
      const paths = claudeTranscriptsForCwd(join(homedir(), ".claude"), cwd);
      // retainSequences: the per-session model + mission hints feed the opt-in
      // outcome judge (the cross-model histogram); cheap when unused.
      return { inventory, signal: scanWorkflow(paths, scanInv, { retainSequences: true }) };
    },
    judge: (signal) => judgeSessions(signal),
    // Distribution-publish to the GitHub registry is intentionally NOT wired here yet.
    // It must first fetch the LIVE registry index — publishing against an empty index
    // would overwrite and erase other published gems (data loss). Until that lands,
    // sign_and_publish performs only the data-critical ingest POST; registry
    // distribution is a tracked follow-up.
    publish: undefined,
    token: process.env.AGENTGEM_INGEST_TOKEN,
  };
}

// Opt-in: judge sessions into per-model outcomes only when the tool asks for it
// (includeOutcomes) and a judge is wired. Keeps the default publish agent-free.
async function maybeJudge(args: Record<string, unknown>, signal: WorkflowSignal, deps: ToolDeps, defaultOn: boolean): Promise<SessionFacet[] | undefined> {
  // Publishing to the network defaults outcomes ON (defaultOn); preview/build stays
  // off. An explicit includeOutcomes flag always wins.
  const want = args.includeOutcomes === undefined ? defaultOn : args.includeOutcomes === true;
  if (!want || !deps.judge) return undefined;
  const { facets, degraded } = await deps.judge(signal);
  // A degraded judge yields neutral heuristic facets — publishing those would
  // pollute the network benchmark with fake "partially" outcomes. Omit them
  // (the attestation stays v1) so only real, agent-judged outcomes are shared.
  return degraded ? undefined : facets;
}

// ---- dispatch (unit-tested with injected deps) ----
export async function dispatchTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<unknown> {
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  switch (name) {
    case "scan_workflow": {
      const { signal } = deps.loadContext(cwd);
      return { signal, signalDigest: `sha256:${createHash("sha256").update(canonicalJSON(signal)).digest("hex")}` };
    }
    case "inspect_ingredients": {
      const salt = deps.salt ?? randomBytes(16).toString("hex");
      return inspectIngredientsTool({ ...deps.loadContext(cwd), salt });
    }
    case "build_attestation": {
      if (!args.selection) throw new Error("build_attestation requires an explicit selection");
      const { inventory, signal } = deps.loadContext(cwd);
      const salt = deps.salt ?? randomBytes(16).toString("hex");
      const facets = await maybeJudge(args, signal, deps, false);   // preview: opt-in only (stays fast)
      return buildAttestationTool({ inventory, signal, selection: args.selection as GemSelection, salt, account: (args.account as { provider: string; login: string } | null) ?? null, facets });
    }
    case "sign_and_publish": {
      if (!args.selection) throw new Error("sign_and_publish requires an explicit selection");
      const { inventory, signal } = deps.loadContext(cwd);
      const salt = deps.salt ?? randomBytes(16).toString("hex");
      const facets = await maybeJudge(args, signal, deps, true);    // network contribution: outcomes ON by default
      // Rebuild the attestation server-side from the real scan + the reviewed selection.
      // The caller does NOT author counts; any caller-supplied args.attestation is ignored.
      const { attestation, gemPreview } = buildAttestationTool({ inventory, signal, selection: args.selection as GemSelection, salt, account: (args.account as { provider: string; login: string } | null) ?? null, facets });
      return signAndPublishTool({ gem: gemPreview, attestation, token: deps.token }, { publish: deps.publish ? (files) => deps.publish!(gemPreview, files) : undefined });
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

// ---- MCP tool surface (AgentBack @tool: one Zod schema = validator + MCP input) ----
// Each tool delegates to the unit-tested dispatchTool over realDeps(); the class is
// just the transport adapter. `selection` reuses the REST GemSelectionSchema (single
// source of truth) instead of the old hand-written JSON Schema.
const CwdInput = z.object({ cwd: z.string().optional() });
const AccountInput = z.object({ provider: z.string(), login: z.string() }).nullable().optional();
const AttestInput = z.object({ selection: GemSelectionSchema, cwd: z.string().optional(), account: AccountInput, includeOutcomes: z.boolean().optional() });

@mcpServer()
export class DistillTools {
  private readonly deps: ToolDeps = realDeps();

  @tool("scan_workflow", { input: CwdInput, description: "Scan local transcripts into a redacted workflow signal." })
  async scanWorkflow(input: z.infer<typeof CwdInput>) {
    return dispatchTool("scan_workflow", input as Record<string, unknown>, this.deps);
  }

  @tool("inspect_ingredients", { input: CwdInput, description: "Canonical fingerprints of available harness/models/skills/mcps." })
  async inspectIngredients(input: z.infer<typeof CwdInput>) {
    return dispatchTool("inspect_ingredients", input as Record<string, unknown>, this.deps);
  }

  @tool("build_attestation", { input: AttestInput, description: "Build the unsigned usage attestation + a 'what will leave your machine' preview." })
  async buildAttestation(input: z.infer<typeof AttestInput>) {
    return dispatchTool("build_attestation", input as Record<string, unknown>, this.deps);
  }

  @tool("sign_and_publish", {
    input: AttestInput,
    description:
      "Sign + publish from the reviewed selection. The attestation is REBUILT server-side from the local scan; the host agent supplies only the selection, never the counts (any caller-supplied attestation is ignored). Embeds it in the Gem archive and POSTs to the ingest endpoint (skipped if unconfigured). Registry distribution is currently disabled; do not report a published distribution unless a publishedRef is returned. By default it also judges the sessions and contributes per-model success rates to the public cross-model benchmark (degraded judgements are withheld, never published); pass includeOutcomes:false to publish without contributing outcomes.",
  })
  async signAndPublish(input: z.infer<typeof AttestInput>) {
    return dispatchTool("sign_and_publish", input as Record<string, unknown>, this.deps);
  }
}

export async function main(): Promise<void> {
  const app = new MCPApplication();
  app.configure("servers.MCPServer").to({ name: "agentgem-distill", version: "0.1.0" });
  app.service(DistillTools);
  await app.start(); // stdio transport; blocks until stdin closes
}

// sign_and_publish is environment-touching; export it for integration tests with injected deps.
export async function signAndPublishTool(
  input: { gem: Gem; attestation: UsageAttestation; identityDir?: string; token?: string },
  deps: { publish?: (files: Record<string, string>) => Promise<{ ref: string }>; ingestHttp?: Parameters<typeof postAttestation>[0]["http"] } = {},
): Promise<{ publishedRef?: string; gemDigest: string; signature: string; ingestId?: string }> {
  const identity = loadOrCreateIdentity(input.identityDir);
  const signed = signAttestation(input.attestation, identity, Date.now());
  const { files } = writeAttestedArchive(input.gem, signed, identity);
  const lock = JSON.parse(files["gem.lock"]) as { gemDigest: string; signature: string };
  const published = deps.publish ? await deps.publish(files) : undefined;
  const ingest = await postAttestation({ attestation: signed, token: input.token, http: deps.ingestHttp });
  return { publishedRef: published?.ref, gemDigest: lock.gemDigest, signature: lock.signature, ingestId: "ingestId" in ingest ? ingest.ingestId : undefined };
}

if (isMain(import.meta)) void main();
