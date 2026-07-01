// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem.controller.ts
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { scanSessionsCached, aggregateObserve, loadSessionTranscript, resolveClaudeSession, dehomeDistilled, scrubText } from "@agentgem/insight";
import { scanArtifactUsageCached } from "@agentgem/insight";
import { buildOptimizePayload, buildDiscover, rerankCandidates, installSkill, type OptimizeRange } from "@agentgem/insight";

const ObserveQuerySchema = z.object({
  range: z.enum(["today", "7d", "30d", "all"]).optional(),
  agent: z.string().optional(),
  project: z.string().optional(),
  model: z.string().optional(),
  minMsgs: z.coerce.number().int().nonnegative().optional(),
  refresh: z.coerce.boolean().optional(),   // ?refresh=true forces a re-scan past the 15s scan cache
});
const ObservePayloadSchema = z.object({
  pulse: z.object({ sessions: z.number(), msgs: z.number(), tokens: z.number(), activeMs: z.number() }),
  daily: z.array(z.object({ date: z.string(), sessions: z.number(), msgs: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number() })),
  sessions: z.array(z.object({ agent: z.enum(["claude", "codex"]), sessionId: z.string(), project: z.string().nullable(), model: z.string().nullable(), startMs: z.number(), endMs: z.number(), durationMs: z.number(), msgs: z.number(), tokens: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(), gitBranch: z.string().nullable() })),
  models: z.array(z.object({ model: z.string(), agent: z.enum(["claude", "codex"]), sessions: z.number(), tokens: z.number() })),
  facets: z.object({ agents: z.array(z.string()), projects: z.array(z.string()), models: z.array(z.string()) }),
  range: z.enum(["today", "7d", "30d", "all"]),
});
// Raw scan output: the uncapped SessionStat[] the console fetches once, then
// aggregates per range/filter client-side (sharing @agentgem/insight's
// aggregateObserve). /observe still serves the server-aggregated payload.
const SessionStatSchema = z.object({
  agent: z.enum(["claude", "codex"]),
  sessionId: z.string(),
  project: z.string().nullable(),
  model: z.string().nullable(),
  gitBranch: z.string().nullable(),
  startMs: z.number(), endMs: z.number(), msgs: z.number(),
  tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(),
});
const ObserveRawQuerySchema = z.object({ refresh: z.coerce.boolean().optional() });
const ObserveRawSchema = z.object({ sessions: z.array(SessionStatSchema) });

// Per-session transcript: the on-demand drill-down read path (inspectSession.ts).
// Lazy + scrubbed, NOT part of the aggregate scan — preserves Inspect's
// metadata-only/one-shot properties.
const InspectSessionQuerySchema = z.object({
  id: z.string(),
  agent: z.enum(["claude", "codex"]),
});
const TokenBreakdownSchema = z.object({ in: z.number(), out: z.number(), cache: z.number() });
const TranscriptSpanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), role: z.enum(["user", "assistant"]), text: z.string() }),
  z.object({ kind: z.literal("tool_call"), name: z.string(), input: z.string(), output: z.string().optional(), error: z.boolean().optional() }),
]);
const TranscriptTurnSchema = z.object({
  id: z.string(), role: z.enum(["user", "assistant"]), tsMs: z.number(),
  spans: z.array(TranscriptSpanSchema), tokens: TokenBreakdownSchema,
});
const TranscriptViewSchema = z.object({
  sessionId: z.string(), agent: z.enum(["claude", "codex"]),
  meta: SessionStatSchema, turns: z.array(TranscriptTurnSchema),
});
// "Distill this session" (proposal phase 3): runs the EXISTING workflow scan +
// distill pipeline over a single session's transcript. Claude-only, like the
// project analyze flow (workflowScan reads Claude transcripts).
const InspectDistillBodySchema = z.object({ id: z.string(), agent: z.enum(["claude", "codex"]) });
const InspectDistillResponseSchema = z.object({ distilled: z.array(DistilledSkillSchema), lessons: z.array(DistilledLessonSchema), degraded: z.boolean() });
const OptimizeQuerySchema = z.object({ range: z.enum(["today", "7d", "30d", "all"]).optional(), refresh: z.coerce.boolean().optional() });
const DisableItemSchema = z.object({
  type: z.enum(["skill", "mcp", "plugin"]),
  name: z.string(),
  source: z.string(),
});
const DisableBodySchema = z.object({ artifacts: z.array(DisableItemSchema) });
const DisableResponseSchema = z.object({
  results: z.array(z.object({
    type: z.enum(["skill", "mcp", "plugin"]),
    name: z.string(),
    ok: z.boolean(),
    message: z.string(),
  })),
});
const OptimizeArtifactSchema = z.object({
  name: z.string(), type: z.enum(["skill", "mcp"]), source: z.string(),
  contextTokens: z.number(), uses: z.number(), lastUsedMs: z.number().nullable(),
  prune: z.boolean(), change: z.object({ file: z.string(), key: z.string() }),
});
const OptimizeInstructionSchema = z.object({
  name: z.string(), source: z.string(), contextTokens: z.number(), lines: z.number(),
  flags: z.array(z.enum(["oversized", "very-long", "duplicate-lines"])),
});
export const OptimizePayloadSchema = z.object({
  range: z.enum(["today", "7d", "30d", "all"]),
  artifacts: z.array(OptimizeArtifactSchema),
  instructions: z.array(OptimizeInstructionSchema),
  disabled: z.array(z.object({
    type: z.enum(["skill", "mcp", "plugin"]),
    name: z.string(),
    source: z.string(),
  })),
});
const DiscoverCandidateSchema = z.object({
  name: z.string(),
  source: z.string(),
  skillId: z.string(),
  registry: z.literal("skills.sh"),
  installs: z.number().optional(),
  url: z.string(),
  reason: z.string(),
  installCmd: z.string(),
});
export const DiscoverPayloadSchema = z.object({
  candidates: z.array(DiscoverCandidateSchema),
  topics: z.array(z.string()),
  reranked: z.boolean().optional(),
  degraded: z.object({ reason: z.string() }).optional(),
});
const RerankBodySchema = z.object({ candidates: z.array(DiscoverCandidateSchema), topics: z.array(z.string()) });
const InstallSkillBodySchema = z.object({ source: z.string(), skillId: z.string() });
export const InstallSkillResultSchema = z.object({ ok: z.boolean(), skill: z.string(), message: z.string() });
const ScorecardBuildRequestSchema = z.object({
  dir: z.string().optional(),
  name: z.string().optional(),
  selections: z.array(z.object({ root: z.string(), keys: z.array(z.string()).min(1) })).min(1),
});
const ScorecardWorkflowQuerySchema = z.object({ dir: z.string().optional(), root: z.string(), key: z.string() });
const WorkflowDetailSchema = z.object({
  key: z.string(), name: z.string(), description: z.string(),
  triggers: z.array(z.string()), tools: z.array(z.string()), mutating: z.boolean(),
  steps: z.array(z.string()), sessions: z.number(),
  confidence: z.enum(["high", "medium", "low"]), portable: z.boolean(),
});

const ScorecardSchema = z.object({
  breadth: z.number(),
  battleTested: z.number(),
  portable: z.number(),
  gaps: z.array(z.string()),
  projects: z.array(z.object({
    root: z.string(), label: z.string(),
    breadth: z.number(), battleTested: z.number(), portable: z.number(),
    workflows: z.array(z.object({ key: z.string(), name: z.string(), confidence: z.enum(["high", "medium", "low"]), portable: z.boolean() })),
  })),
  generatedAtMs: z.number(),
  degraded: z.boolean(),
}) satisfies z.ZodType<Scorecard>;
import { introspectConfig, introspectProject, disableArtifacts, enableArtifacts, listDisabled } from "@agentgem/capture";
import { buildGem } from "@agentgem/build";
import { InvalidInputError, scorecardFloor, loadOrCreateIdentity } from "@agentgem/model";
import { scaffoldChecks } from "@agentgem/build";
import { materialize, compatibility } from "@agentgem/model";
import type { TargetId } from "@agentgem/model";
import { DEPLOY_REGISTRY, deployTargetList } from "@agentgem/deploy";
import type { DeployTargetId } from "@agentgem/deploy";
import { createWorkspace, listWorkspaces, readWorkspace, renderTarget, deleteWorkspace } from "@agentgem/base";
import { writeGemArchive, readGemArchive } from "@agentgem/archive";
import type { GemLock } from "@agentgem/archive";
import { writeArchiveDir, readArchiveDir } from "@agentgem/archive";
import { packTar } from "@agentgem/archive";
import { exportGem, importGem } from "@agentgem/distribute";
import { fetchGemBytes } from "@agentgem/distribute";
import { sendBytes, receiveTicket, natsStoreFromEnv, assertConfigured, mintCredsFromEnv, fetchAndBurnCiphertext } from "@agentgem/transfer";
import type { Gem } from "@agentgem/model";
import { readDeployRecord, writeDeployRecord, clearDeployRecord } from "@agentgem/base";
import type { DeployBackend } from "@agentgem/base";
import { transcriptToken, readAnalysisCache, writeAnalysisCache } from "@agentgem/insight";
import { readGlobalUsageCache, writeGlobalUsageCache, readGlobalUsageCacheStale } from "@agentgem/capture";
import { computeGlobalUsage } from "@agentgem/capture";
import { undeployManagedAgent, anthropicPublishClient } from "@agentgem/deploy";
import { undeployAgentcoreHarness, realAgentcoreControlClient } from "@agentgem/deploy";

import type { ConfigInventory } from "@agentgem/model";
import {
  InventorySchema, GemSchema, GemRequestSchema, DirQuerySchema, PickQuerySchema, PickFolderSchema,
  ScaffoldChecksRequestSchema, ScaffoldChecksResponseSchema,
  MaterializeRequestSchema, MaterializeResponseSchema,
  TransferSendRequestSchema, TransferSendResponseSchema, TransferReceiveRequestSchema, TransferReceiveResponseSchema,
  TransferTokenRequestSchema, TransferTokenResponseSchema,
  TransferCiphertextRequestSchema, TransferCiphertextResponseSchema,
  PublishPreviewRequestSchema, PublishRequestSchema, PublishPreviewResponseSchema, PublishReadyResponseSchema, PublishResultSchema,
  DeployTargetsResponseSchema, DeployReadyQuerySchema,
  ArchiveRequestSchema, ArchiveResponseSchema,
  CreateWorkspaceRequestSchema, WorkspaceQuerySchema, RenderRequestSchema, WorkspaceNameRequestSchema, WorkspaceSummarySchema, WorkspaceDetailSchema, RenderResultSchema, ListWorkspacesResponseSchema, DeleteWorkspaceResponseSchema,
  RunReadyQuerySchema, RunReadyResponseSchema, RunRequestSchema, RunStatusQuerySchema, RunStateSchema, RunStopRequestSchema, RunStopResponseSchema,
  CredentialRequestSchema, CredentialResponseSchema,
  TestbedDetectQuerySchema, TestbedDetectResponseSchema,
  TestbedSuggestionQuerySchema, TestbedSuggestionResponseSchema,
  TestbedRecentsResponseSchema,
  TestbedProjectsQuerySchema, TestbedProjectsResponseSchema,
  TargetProjectsQuerySchema, TargetProjectsResponseSchema,
  TestbedScaffoldRequestSchema, TestbedScaffoldResponseSchema,
  TestbedImportRequestSchema, TestbedImportResponseSchema,
  GemApplyRequestSchema, GemApplyResponseSchema,
  AgentcoreReadyResponseSchema, AgentcoreDeployRequestSchema, AgentcoreStatusQuerySchema, AgentcoreDeployStateSchema,
  RegistryReadyResponseSchema, RegistryIndexResponseSchema,
  RegistrySearchQuerySchema, RegistrySearchResponseSchema, RegistryGemsResponseSchema,
  RegistryResolveRequestSchema, RegistryResolveResponseSchema,
  RegistryInstallRequestSchema, RegistryInstallResponseSchema,
  RegistryPublishRequestSchema, RegistryPublishResponseSchema,
  UndeployRequestSchema, UndeployResponseSchema, DeployRecordQuerySchema, DeployRecordResponseSchema,
  WorkflowAnalyzeRequestSchema, WorkflowAnalyzeResponseSchema,
  DistilledSkillSchema, DistilledLessonSchema, WorkflowDraftWriteResponseSchema,
  GemRunRequestSchema, GemRunResponseSchema,
  GemRunPrepareRequestSchema, GemRunPrepareResponseSchema,
  UsageSchema, UsageQuerySchema,
  PlaybookPrepareBodySchema, PlaybookPrepareResponseSchema,
  PlaybookPublishBodySchema, PlaybookPublishResponseSchema,
} from "./schemas.js";
import { collectScorecard, selectScorecardRoots, scorecardTranscriptPaths, defaultScorecardDeps, isPortable, type Scorecard } from "./gem/scorecard.js";
import { preparePlaybook } from "./gem/playbookPrepareCore.js";
import { publishPlaybookCore } from "./gem/playbookPublishCore.js";
import { createShareCard } from "./share/shareStore.js";
import { postCatalogShare, shareRejectedError } from "./gem/catalogShareClient.js";
import { sanitizeShareText } from "@agentgem/insight";
import { claudeTranscriptsForCwd, scanWorkflow, allClaudeTranscripts, bucketTranscriptsByCwd } from "@agentgem/insight";
import { distillWorkflow, distillSessionLessons, type DistilledSkill } from "@agentgem/insight";
import { computeWorkflowAnalysis } from "./workflowCore.js";
import { writeDistilledDraft, writeDistilledLesson, stageDraftsByEvidence, stageLessonsByEvidence } from "@agentgem/capture";
import { runReadiness, startLocal, stopLocal, getRunStatus, deployVercel, deployCloudflare, undeployVercel, undeployCloudflare } from "@agentgem/run";
import { setCredential } from "@agentgem/capture";
import { agentcoreReadiness, deployAgentcore, getAgentcoreStatus } from "@agentgem/deploy";
import { scaffoldTestbed, importArtifacts } from "@agentgem/testbed";
import { materializeAndRunGem, materializeGemToTestbed, registerRun, AGENT_ADAPTERS, type AgentId } from "@agentgem/run";
import { detectFlavor, suggestTestbed, discoverProjects } from "@agentgem/testbed";
import { discoverTargetProjects, scanRootsForTargets } from "@agentgem/testbed";
import type { TestbedFlavorId } from "@agentgem/testbed";
import { readRecents, upsertRecent } from "@agentgem/capture";
import { resolveInstall, publishGem } from "@agentgem/distribute";
import { searchIndex } from "@agentgem/distribute";
import { githubRegistrySource, githubRegistryPublisher, registryConfigFromEnv, registryReady } from "@agentgem/distribute";
import { createGemCache, safeDbGems, mergeGems } from "./gem/publicCatalog.js";
import { service, inject } from "@agentback/core";
import { RestBindings } from "@agentback/rest";
import { DrizzleBindings } from "@agentback/drizzle";
import type { AppDb } from "@agentgem/aggregator";
import { listCatalogGems } from "@agentgem/aggregator";
import { resolvePublishedBy } from "./registry/publishedBy.js";
import { GemTypeRegistry, defaultGemTypeRegistry, resolvePublishType } from "./gem/gemTypeRegistry.js";
import { resolveDirs, resolveProject, agentgemHome } from "@agentgem/model";
import { pickFolder } from "./pickFolder.js";
import { readShareAdoption, setShareAdoption } from "./agentgemConfig.js";
import { emitAdoption } from "./registry/emitAdoption.js";
import { bindConfig, startDeviceBind, completeDeviceBind, readBindingStatus, type StartDeps, type CompleteDeps } from "./bind/bindCore.js";

const BindStartSchema = z.object({
  configured: z.boolean(),
  userCode: z.string().optional(),
  verificationUri: z.string().optional(),
  deviceCode: z.string().optional(),
  interval: z.number().optional(),
});
const BindCompleteBodySchema = z.object({ deviceCode: z.string(), interval: z.number().optional() });
const BindCompleteSchema = z.object({
  bound: z.boolean(),
  provider: z.string().optional(),
  login: z.string().optional(),
  accountId: z.string().optional(),
  rejected: z.string().optional(),
});
const BindStatusSchema = z.object({ bound: z.boolean(), login: z.string().optional(), provider: z.string().optional() });

let globalUsageRefreshing = false;

// Public browse catalog: one shared 5-minute TTL cache so visitor traffic never hits GitHub per-request.
const publicGemCache = createGemCache(5 * 60 * 1000);

// Server-derived run directory for a Gem. NEVER taken from client input: a caller-controlled path is
// a path-injection sink, and the ACP agent then runs there with tool permissions. The gem name is
// sanitized to one path segment; the sanitizer keeps '.', so a name of ".." must not escape — we
// assert the resolved path stays inside the runs root.
function deriveRunDir(gemName: string): string {
  let safeName = gemName.replace(/[^A-Za-z0-9._-]/g, "-");
  if (safeName === "" || safeName === "." || safeName === "..") safeName = "gem";
  const runsRoot = resolve(agentgemHome(), ".agentgem", "runs");
  const runDir = resolve(runsRoot, safeName);
  if (!runDir.startsWith(runsRoot + sep)) throw new Error("derived run dir escaped the runs root");
  return runDir;
}

@api({ basePath: "/api" })
export class GemController {
  constructor(
    @service(GemTypeRegistry, { optional: true }) private gemTypes: GemTypeRegistry = defaultGemTypeRegistry,
    @inject(RestBindings.HTTP_REQUEST, { optional: true }) private req?: { headers: { cookie?: string } },
    @inject(DrizzleBindings.CLIENT, { optional: true }) private db?: AppDb,
  ) {}

  @get("/inventory", { query: DirQuerySchema, response: InventorySchema })
  async inventory(input: { query: z.infer<typeof DirQuerySchema> }): Promise<z.infer<typeof InventorySchema>> {
    return introspectAll(input.query.dir, parseProjectsQuery(input.query.projects));
  }

  @get("/usage", { query: UsageQuerySchema, response: UsageSchema })
  async usage(input: { query: z.infer<typeof UsageQuerySchema> }): Promise<z.infer<typeof UsageSchema>> {
    try {
      if (input.query.scope === "global") {
        const dirs = resolveDirs(input.query.dir);
        const paths = allClaudeTranscripts(dirs.claudeDir);
        const token = transcriptToken(paths);
        const exact = readGlobalUsageCache(token);
        if (exact) return exact as z.infer<typeof UsageSchema>;
        const stale = readGlobalUsageCacheStale(dirs.claudeDir);
        if (stale) {
          if (!globalUsageRefreshing) {
            globalUsageRefreshing = true;
            // Defer with a macrotask (setTimeout), NOT a microtask: a microtask
            // (Promise.then) drains before the HTTP response flushes, so the
            // synchronous ~4s scan would block this very response. setTimeout(0)
            // lets the stale response flush first, then the rescan runs.
            setTimeout(() => {
              try { writeGlobalUsageCache(token, computeGlobalUsage(dirs, paths), dirs.claudeDir); }
              catch (e) { console.error("[usage] bg refresh failed:", e); }
              finally { globalUsageRefreshing = false; }
            }, 0);
          }
          return stale as z.infer<typeof UsageSchema>;
        }
        const result = computeGlobalUsage(dirs, paths);
        writeGlobalUsageCache(token, result, dirs.claudeDir);
        return result;
      }
      const roots = parseProjectsQuery(input.query.projects);
      const root = roots[0];
      if (!root) return { artifacts: [] };
      const dirs = resolveDirs(input.query.dir);
      const project = introspectProject(resolveProject(root));
      const globalInv = introspectConfig(dirs);
      const scanInv = { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
      const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
      const signal = scanWorkflow(paths, scanInv);
      return { artifacts: signal.artifacts.map((a) => ({
        type: a.type, name: a.name, root: a.root,
        invocations: a.invocations, sessionsUsedIn: a.sessionsUsedIn, lastUsedMs: a.lastUsedMs,
      })) };
    } catch (e) {
      console.error("[usage] scan failed:", e);
      return { artifacts: [] };
    }
  }

  @get("/observe", { query: ObserveQuerySchema, response: ObservePayloadSchema })
  async observe(input: { query: z.infer<typeof ObserveQuerySchema> }): Promise<z.infer<typeof ObservePayloadSchema>> {
    const range = input.query.range ?? "7d";
    const { agent, project, model, minMsgs } = input.query;
    const refresh = input.query.refresh ?? false;
    return aggregateObserve(await scanSessionsCached(Date.now(), undefined, refresh), range, Date.now(), { agent, project, model, minMsgs });
  }

  @get("/observe/raw", { query: ObserveRawQuerySchema, response: ObserveRawSchema })
  async observeRaw(input: { query: z.infer<typeof ObserveRawQuerySchema> }): Promise<z.infer<typeof ObserveRawSchema>> {
    const refresh = input.query.refresh ?? false;
    return { sessions: await scanSessionsCached(Date.now(), undefined, refresh) };
  }

  @get("/inspect/session", { query: InspectSessionQuerySchema, response: TranscriptViewSchema })
  async inspectSession(input: { query: z.infer<typeof InspectSessionQuerySchema> }): Promise<z.infer<typeof TranscriptViewSchema>> {
    const view = await loadSessionTranscript(input.query.id, input.query.agent);
    if (!view) throw new InvalidInputError(`No ${input.query.agent} session '${input.query.id}' found.`);
    return view;
  }

  @post("/inspect/distill", { body: InspectDistillBodySchema, response: InspectDistillResponseSchema })
  async inspectDistill(input: { body: z.infer<typeof InspectDistillBodySchema> }): Promise<z.infer<typeof InspectDistillResponseSchema>> {
    if (input.body.agent !== "claude") throw new InvalidInputError("Distillation supports Claude sessions only.");
    const found = await resolveClaudeSession(input.body.id);
    if (!found || !found.cwd) throw new InvalidInputError(`No Claude session '${input.body.id}' found (or it has no recorded project).`);
    // Same pipeline as /workflow/analyze, scoped to this one transcript.
    const inventory = introspectAll(undefined, [found.cwd]);
    const project = (inventory.projects ?? []).find((p) => p.root === resolveProject(found.cwd!));
    if (!project) throw new InvalidInputError(`Project for session '${input.body.id}' not found in inventory.`);
    const scanInv = { project, global: { skills: inventory.skills, mcpServers: inventory.mcpServers, hooks: inventory.hooks } };
    const signal = scanWorkflow([found.path], scanInv, { retainSequences: true });
    const [distill, lessonsRes] = await Promise.all([
      distillWorkflow(signal, scanInv),
      distillSessionLessons(signal, scanInv),
    ]);
    // The client sent only a session id, so the derived absolute project path
    // (carries the OS username) must not leak back via evidence.root — mirror the
    // TranscriptView boundary. Skills AND lessons both carry evidence.root.
    const lessons = lessonsRes.lessons.map((l) => ({ ...l, evidence: { ...l.evidence, root: scrubText(l.evidence.root) } }));
    return { distilled: dehomeDistilled(distill.distilled), lessons, degraded: distill.degraded || lessonsRes.degraded };
  }

  @post("/playbook/prepare", { body: PlaybookPrepareBodySchema, response: PlaybookPrepareResponseSchema })
  async playbookPrepare(input: { body: z.infer<typeof PlaybookPrepareBodySchema> }): Promise<z.infer<typeof PlaybookPrepareResponseSchema>> {
    const root = input.body.root;
    const inventory = introspectAll(undefined, [root]);
    const project = (inventory.projects ?? []).find((p) => p.root === resolveProject(root));
    if (!project) throw new InvalidInputError(`Project '${root}' not found in inventory.`);
    const dirs = resolveDirs(undefined);
    const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
    const scanInv = { project, global: { skills: inventory.skills, mcpServers: inventory.mcpServers, hooks: inventory.hooks } };
    const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
    return preparePlaybook({
      root,
      distill: async () => {
        const [w, l] = await Promise.all([distillWorkflow(signal, scanInv), distillSessionLessons(signal, scanInv)]);
        return { skills: w.distilled, lessons: l.lessons, degraded: w.degraded || l.degraded };
      },
      persistSkill: (s) => { writeDistilledDraft(s); },
      persistLesson: (l) => { writeDistilledLesson(l); },
    });
  }

  @post("/playbook/publish", { body: PlaybookPublishBodySchema, response: PlaybookPublishResponseSchema })
  async playbookPublish(input: { body: z.infer<typeof PlaybookPublishBodySchema> }): Promise<z.infer<typeof PlaybookPublishResponseSchema>> {
    const b = input.body;
    return publishPlaybookCore({
      publish: async () => {
        const gem = readGemArchive(readWorkspace(b.workspace).files);
        const manifest = {
          gemKey: `${b.scope}/${b.name ?? b.workspace}`, version: b.version,
          description: b.description, tags: b.tags, grade: gem.grade,
          artifactKinds: gem.artifacts.map((a) => a.type),
        };
        const identity = loadOrCreateIdentity();
        const r = await postCatalogShare({ manifest, identity });
        if (!r.shared) throw shareRejectedError(r.rejected);
        return { ref: manifest.gemKey, version: b.version };
      },
      share: async () => createShareCard(this.db!, { kind: "gem", name: b.name ?? b.workspace, provenance: b.provenance, generatedAtMs: Date.now() }),
    });
  }

  @get("/optimize", { query: OptimizeQuerySchema, response: OptimizePayloadSchema })
  async optimize(input: { query: z.infer<typeof OptimizeQuerySchema> }): Promise<z.infer<typeof OptimizePayloadSchema>> {
    const range: OptimizeRange = input.query.range ?? "30d";
    const now = Date.now();
    const refresh = input.query.refresh ?? false;
    const inv = introspectConfig();
    const usage = await scanArtifactUsageCached(inv, now, undefined, refresh);
    const payload = buildOptimizePayload(inv, usage, range, now);
    return { ...payload, disabled: listDisabled() };
  }

  @get("/optimize/discover", { response: DiscoverPayloadSchema })
  async optimizeDiscover(): Promise<z.infer<typeof DiscoverPayloadSchema>> {
    const inv = introspectConfig();
    const usage = await scanArtifactUsageCached(inv, Date.now());
    return buildDiscover(usage, inv);
  }

  @post("/optimize/discover/rerank", { body: RerankBodySchema, response: DiscoverPayloadSchema })
  async optimizeDiscoverRerank(input: { body: z.infer<typeof RerankBodySchema> }): Promise<z.infer<typeof DiscoverPayloadSchema>> {
    return rerankCandidates(input.body);
  }

  // Install a recommended skill onto this machine by shelling out to the `skills`
  // CLI (--global, non-interactive). Protected by originGuard like every /api route
  // — the same boundary /gem/run relies on. Never throws: installSkill maps every
  // failure to { ok:false, message }.
  @post("/optimize/discover/install", { body: InstallSkillBodySchema, response: InstallSkillResultSchema })
  async optimizeDiscoverInstall(input: { body: z.infer<typeof InstallSkillBodySchema> }): Promise<z.infer<typeof InstallSkillResultSchema>> {
    return installSkill(input.body.source, input.body.skillId);
  }

  // Reversible deactivation of prune rows. originGuard-protected like every /api route.
  // Never throws: disableArtifacts/enableArtifacts map each item to { ok, message }.
  @post("/optimize/disable", { body: DisableBodySchema, response: DisableResponseSchema })
  async optimizeDisable(input: { body: z.infer<typeof DisableBodySchema> }): Promise<z.infer<typeof DisableResponseSchema>> {
    return { results: disableArtifacts(input.body.artifacts) };
  }

  @post("/optimize/enable", { body: DisableBodySchema, response: DisableResponseSchema })
  async optimizeEnable(input: { body: z.infer<typeof DisableBodySchema> }): Promise<z.infer<typeof DisableResponseSchema>> {
    return { results: enableArtifacts(input.body.artifacts) };
  }

  @get("/scorecard", { query: DirQuerySchema, response: ScorecardSchema })
  async scorecard(input: { query: z.infer<typeof DirQuerySchema> }): Promise<z.infer<typeof ScorecardSchema>> {
    const dir = input.query.dir;
    const projects = parseProjectsQuery(input.query.projects);
    const roots = selectScorecardRoots(dir, projects);
    const bucket = bucketTranscriptsByCwd(resolveDirs(dir).claudeDir);
    const token = transcriptToken(scorecardTranscriptPaths(roots, bucket));
    const cached = readAnalysisCache("__scorecard__", token) as z.infer<typeof ScorecardSchema> | null;
    if (cached) return cached;
    const sc = collectScorecard(dir, roots, Date.now(), { bucket });
    if (!sc.degraded) writeAnalysisCache("__scorecard__", token, sc, Date.now());
    return sc;
  }

  @post("/scorecard/build", { body: ScorecardBuildRequestSchema, response: GemSchema })
  async scorecardBuild(input: { body: z.infer<typeof ScorecardBuildRequestSchema> }): Promise<z.infer<typeof GemSchema>> {
    const dir = input.body.dir;
    const drafts: DistilledSkill[] = [];
    const projSel: Record<string, { skills: string[] }> = {};
    const roots: string[] = [];
    const keys = new Set<string>();
    let battleTested = 0, portable = 0;
    for (const sel of input.body.selections) {
      const canonRoot = resolveProject(sel.root);
      roots.push(canonRoot);
      const loaded = defaultScorecardDeps.loadProject(sel.root, dir);
      if (!loaded) throw new InvalidInputError(`Could not scan project '${sel.root}'.`);
      const chosen = loaded.candidates.filter((c) => sel.keys.includes(c.key));
      if (!chosen.length) throw new InvalidInputError(`No matching workflows in '${sel.root}' for the given keys.`);
      for (const c of chosen) {
        keys.add(c.key);
        if (c.priorConfidence === "high") battleTested++;
        if (isPortable(c)) portable++;
        drafts.push({ ...c.skeleton, description: sanitizeShareText(c.skeleton.description) });
        (projSel[c.skeleton.evidence.root] ??= { skills: [] }).skills.push(c.skeleton.name);
      }
    }
    const grade = scorecardFloor({ breadth: keys.size, battleTested, portable });
    const inventory = stageDraftsByEvidence(introspectAll(dir, roots), drafts);
    const gem = buildGem(inventory, { projects: projSel }, { name: input.body.name ?? "goldmine-gem", createdFrom: resolveDirs(dir).claudeDir, grade });
    return gem;
  }

  @get("/scorecard/workflow", { query: ScorecardWorkflowQuerySchema, response: WorkflowDetailSchema })
  async scorecardWorkflow(input: { query: z.infer<typeof ScorecardWorkflowQuerySchema> }): Promise<z.infer<typeof WorkflowDetailSchema>> {
    const { dir, root, key } = input.query;
    const loaded = defaultScorecardDeps.loadProject(root, dir);
    if (!loaded) throw new InvalidInputError(`Could not scan project '${root}'.`);
    const c = loaded.candidates.find((x) => x.key === key);
    if (!c) throw new InvalidInputError(`No workflow '${key}' in '${root}'.`);
    return { key: c.key, name: c.skeleton.name, description: sanitizeShareText(c.skeleton.description), triggers: c.skeleton.triggers, tools: c.skeleton.tools, mutating: c.skeleton.mutating, steps: c.verbs, sessions: c.sessions, confidence: c.priorConfidence, portable: isPortable(c) };
  }

  @post("/gem", { body: GemRequestSchema, response: GemSchema })
  async gem(input: { body: z.infer<typeof GemRequestSchema> }): Promise<z.infer<typeof GemSchema>> {
    const dirs = resolveDirs(input.body.dir);
    // Fold any accepted distilled drafts into the inventory (by evidence.root)
    // before resolution, so a selection can reference one by name (proposal §7b).
    const inventory = stageLessonsByEvidence(
      stageDraftsByEvidence(introspectAll(input.body.dir, input.body.projects), input.body.distilledDrafts ?? []),
      input.body.distilledLessons ?? [],
    );
    return buildGem(inventory, input.body.selection, {
      name: input.body.name ?? "gem",
      createdFrom: dirs.claudeDir,
      checks: input.body.checks,
      channels: input.body.channels,
    });
  }

  @post("/scaffold-checks", { body: ScaffoldChecksRequestSchema, response: ScaffoldChecksResponseSchema })
  async scaffoldChecks(input: { body: z.infer<typeof ScaffoldChecksRequestSchema> }): Promise<z.infer<typeof ScaffoldChecksResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = stageLessonsByEvidence(
      stageDraftsByEvidence(introspectAll(input.body.dir, input.body.projects), input.body.distilledDrafts ?? []),
      input.body.distilledLessons ?? [],
    );
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir });
    return { checks: scaffoldChecks(gem) };
  }

  @post("/materialize", { body: MaterializeRequestSchema, response: MaterializeResponseSchema })
  async materialize(input: { body: z.infer<typeof MaterializeRequestSchema> }): Promise<z.infer<typeof MaterializeResponseSchema>> {
    const target = input.body.target as TargetId;
    let gem: Gem;
    if (input.body.gemPath || input.body.gemUrl || input.body.bytesBase64) {
      const bytes = input.body.gemUrl
        ? await fetchGemBytes(input.body.gemUrl) // SSRF-guarded: rejects non-public hosts
        : input.body.bytesBase64
        ? Buffer.from(input.body.bytesBase64, "base64") // in-memory bytes (e.g. a redeemed ticket)
        : readFileSync(input.body.gemPath!);
      gem = importGem(bytes).gem; // unpack + verify gem.lock; throws on tampering
    } else if (input.body.archivePath) {
      gem = readGemArchive(readArchiveDir(input.body.archivePath));
    } else {
      const dirs = resolveDirs(input.body.dir);
      const inventory = introspectAll(input.body.dir, input.body.projects);
      gem = buildGem(inventory, input.body.selection!, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir, channels: input.body.channels });
    }
    return { target, ...materialize(gem, target, { a2aServer: input.body.a2aServer }), compatibility: compatibility(gem) };
  }

  @post("/transfer/send", { body: TransferSendRequestSchema, response: TransferSendResponseSchema })
  async transferSend(input: { body: z.infer<typeof TransferSendRequestSchema> }): Promise<z.infer<typeof TransferSendResponseSchema>> {
    assertConfigured(); // 400 before any filesystem/build work if NATS_URL is unset
    const dirs = resolveDirs(input.body.dir);
    const inventory = stageLessonsByEvidence(
      stageDraftsByEvidence(introspectAll(input.body.dir, input.body.projects), input.body.distilledDrafts ?? []),
      input.body.distilledLessons ?? [],
    );
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir, channels: input.body.channels });
    const { bytes } = exportGem(gem, { version: input.body.version });
    const { ticket } = await sendBytes(bytes, natsStoreFromEnv());
    return { ticket };
  }

  @post("/transfer/receive", { body: TransferReceiveRequestSchema, response: TransferReceiveResponseSchema })
  async transferReceive(input: { body: z.infer<typeof TransferReceiveRequestSchema> }): Promise<z.infer<typeof TransferReceiveResponseSchema>> {
    const { gem, meta, bytes } = await receiveTicket(input.body.ticket, natsStoreFromEnv());
    return { gem, meta, bytesBase64: bytes.toString("base64") };
  }

  // Apply a received .gem onto the local machine: unpack + lock-verify the archive bytes,
  // then materialize the gem into a user-picked testbed dir (a .claude-style layout). `dir`
  // is an explicit folder selection — the same trust model as /testbed/import — so it is
  // honored as-is, unlike /gem/run which derives its dir server-side.
  @post("/gem/apply", { body: GemApplyRequestSchema, response: GemApplyResponseSchema })
  async applyGem(input: { body: z.infer<typeof GemApplyRequestSchema> }): Promise<z.infer<typeof GemApplyResponseSchema>> {
    const { gem } = importGem(Buffer.from(input.body.bytesBase64, "base64")); // unpack + verify gem.lock; throws on tampering
    const dir = resolveProject(input.body.dir);
    const { written, skipped } = materializeGemToTestbed(gem, dir, (input.body.flavor ?? "claude") as TestbedFlavorId);
    return { dir, name: gem.name, written, skipped };
  }

  @post("/transfer/token", { body: TransferTokenRequestSchema, response: TransferTokenResponseSchema })
  async transferToken(input: { body: z.infer<typeof TransferTokenRequestSchema> }): Promise<z.infer<typeof TransferTokenResponseSchema>> {
    return mintCredsFromEnv(input.body.scope ?? "receive");
  }

  @post("/transfer/ciphertext", { body: TransferCiphertextRequestSchema, response: TransferCiphertextResponseSchema })
  async transferCiphertext(input: { body: z.infer<typeof TransferCiphertextRequestSchema> }): Promise<z.infer<typeof TransferCiphertextResponseSchema>> {
    const bytes = await fetchAndBurnCiphertext(input.body.object);
    return { ciphertextBase64: bytes.toString("base64") };
  }

  @post("/archive", { body: ArchiveRequestSchema, response: ArchiveResponseSchema })
  async archive(input: { body: z.infer<typeof ArchiveRequestSchema> }): Promise<z.infer<typeof ArchiveResponseSchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name ?? "gem", createdFrom: dirs.claudeDir, channels: input.body.channels });
    const { files, skipped } = writeGemArchive(gem, { version: input.body.version });
    const lock = JSON.parse(files["gem.lock"]) as GemLock;
    let path: string | null = null;
    if (input.body.outDir) { writeArchiveDir(input.body.outDir, files); path = input.body.outDir; }
    let gemFile: string | null = null;
    if (input.body.outFile) { writeFileSync(input.body.outFile, packTar(files)); gemFile = input.body.outFile; }
    const tarGz = input.body.tar ? packTar(files).toString("base64") : null;
    return { files, lock, skipped, path, gemFile, tarGz };
  }

  @post("/workspaces", { body: CreateWorkspaceRequestSchema, response: WorkspaceSummarySchema })
  async createWorkspace(input: { body: z.infer<typeof CreateWorkspaceRequestSchema> }): Promise<z.infer<typeof WorkspaceSummarySchema>> {
    const dirs = resolveDirs(input.body.dir);
    const inventory = introspectAll(input.body.dir, input.body.projects);
    const gem = buildGem(inventory, input.body.selection, { name: input.body.name, createdFrom: dirs.claudeDir, channels: input.body.channels });
    return createWorkspace(input.body.name, gem, { version: input.body.version });
  }

  @get("/workspaces", { query: PickQuerySchema, response: ListWorkspacesResponseSchema })
  async listWorkspaces(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof ListWorkspacesResponseSchema>> {
    return { workspaces: listWorkspaces() };
  }

  @get("/workspace", { query: WorkspaceQuerySchema, response: WorkspaceDetailSchema })
  async readWorkspace(input: { query: z.infer<typeof WorkspaceQuerySchema> }): Promise<z.infer<typeof WorkspaceDetailSchema>> {
    return readWorkspace(input.query.name);
  }

  @post("/workspace/render", { body: RenderRequestSchema, response: RenderResultSchema })
  async renderWorkspace(input: { body: z.infer<typeof RenderRequestSchema> }): Promise<z.infer<typeof RenderResultSchema>> {
    return renderTarget(input.body.name, input.body.target as TargetId, { a2aServer: input.body.a2aServer });
  }

  @post("/workspace/delete", { body: WorkspaceNameRequestSchema, response: DeleteWorkspaceResponseSchema })
  async deleteWorkspace(input: { body: z.infer<typeof WorkspaceNameRequestSchema> }): Promise<z.infer<typeof DeleteWorkspaceResponseSchema>> {
    deleteWorkspace(input.body.name);
    return { deleted: input.body.name };
  }

  // Whether the server is configured to run/deploy the rendered eve project. Booleans only.
  @get("/run-ready", { query: RunReadyQuerySchema, response: RunReadyResponseSchema })
  async runReady(_input: { query: z.infer<typeof RunReadyQuerySchema> }): Promise<z.infer<typeof RunReadyResponseSchema>> {
    return runReadiness();
  }

  // OUTWARD-FACING (local machine): set + persist a server-side deploy/publish credential
  // (allowlisted keys only) to ~/.agentgem/.env. The value is never logged or returned.
  @post("/credential", { body: CredentialRequestSchema, response: CredentialResponseSchema })
  async credential(input: { body: z.infer<typeof CredentialRequestSchema> }): Promise<z.infer<typeof CredentialResponseSchema>> {
    setCredential(input.body.key, input.body.value);
    return { ok: true };
  }

  // OUTWARD-FACING (local machine): run the rendered eve project locally or deploy it to Vercel.
  @post("/run", { body: RunRequestSchema, response: RunStateSchema })
  async run(input: { body: z.infer<typeof RunRequestSchema> }): Promise<z.infer<typeof RunStateSchema>> {
    const { name, mode } = input.body;
    const state = mode === "cloudflare" ? await deployCloudflare(name) : mode === "vercel" ? await deployVercel(name, undefined, { eveAuth: input.body.eveAuth }) : await startLocal(name);
    return state;
  }

  @get("/run-status", { query: RunStatusQuerySchema, response: RunStateSchema })
  async runStatus(input: { query: z.infer<typeof RunStatusQuerySchema> }): Promise<z.infer<typeof RunStateSchema>> {
    return getRunStatus(input.query.name, input.query.target);
  }

  @post("/run/stop", { body: RunStopRequestSchema, response: RunStopResponseSchema })
  async runStop(input: { body: z.infer<typeof RunStopRequestSchema> }): Promise<z.infer<typeof RunStopResponseSchema>> {
    return stopLocal(input.body.name, input.body.target);
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
    const result = await DEPLOY_REGISTRY[target].deploy(gem, input.body.requestId);
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

  @get("/testbed/detect", { query: TestbedDetectQuerySchema, response: TestbedDetectResponseSchema })
  async testbedDetect(input: { query: z.infer<typeof TestbedDetectQuerySchema> }): Promise<z.infer<typeof TestbedDetectResponseSchema>> {
    return { flavor: detectFlavor(resolveProject(input.query.root)) };
  }

  @get("/testbed/suggestion", { query: TestbedSuggestionQuerySchema, response: TestbedSuggestionResponseSchema })
  async testbedSuggestion(input: { query: z.infer<typeof TestbedSuggestionQuerySchema> }): Promise<z.infer<typeof TestbedSuggestionResponseSchema>> {
    const cwd = resolveProject(input.query.cwd ?? process.cwd());
    const { looksLikeProject, flavor } = suggestTestbed(cwd);
    return { cwd, looksLikeProject, flavor, name: basename(cwd) };
  }

  @get("/testbed/recents", { query: PickQuerySchema, response: TestbedRecentsResponseSchema })
  async testbedRecents(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof TestbedRecentsResponseSchema>> {
    const recents = readRecents(agentgemHome()).map((r) => ({ ...r, exists: existsSync(r.path) }));
    return { recents };
  }

  // Cross-repo discovery from Claude/Codex session history. Ungated — the front door
  // shows these under a "Discovered" section beneath the user's own recents.
  @get("/testbed/projects", { query: TestbedProjectsQuerySchema, response: TestbedProjectsResponseSchema })
  async testbedProjects(input: { query: z.infer<typeof TestbedProjectsQuerySchema> }): Promise<z.infer<typeof TestbedProjectsResponseSchema>> {
    return { projects: discoverProjects(resolveDirs(input.query.dir)) };
  }

  // Independently-existing target projects (eve/flue) on this machine: classified from Claude/Codex
  // session cwds, optionally augmented by scanning caller-supplied allowlisted roots (comma-separated).
  // Session candidates take precedence on a path collision (they carry real usage recency). Ungated.
  @get("/targets/projects", { query: TargetProjectsQuerySchema, response: TargetProjectsResponseSchema })
  async targetProjects(input: { query: z.infer<typeof TargetProjectsQuerySchema> }): Promise<z.infer<typeof TargetProjectsResponseSchema>> {
    const fromSessions = discoverTargetProjects(resolveDirs(input.query.dir));
    const roots = (input.query.roots ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const fromScan = roots.length ? await scanRootsForTargets(roots) : [];
    const byPath = new Map<string, z.infer<typeof TargetProjectsResponseSchema>["projects"][number]>();
    for (const p of [...fromSessions, ...fromScan]) if (!byPath.has(p.path)) byPath.set(p.path, p);
    return { projects: [...byPath.values()] };
  }

  @post("/testbed/scaffold", { body: TestbedScaffoldRequestSchema, response: TestbedScaffoldResponseSchema })
  async scaffoldTestbed(input: { body: z.infer<typeof TestbedScaffoldRequestSchema> }): Promise<z.infer<typeof TestbedScaffoldResponseSchema>> {
    const root = resolveProject(input.body.root);
    const flavor = (input.body.flavor ?? "claude") as TestbedFlavorId;
    const res = scaffoldTestbed(root, input.body.name, flavor);
    upsertRecent(agentgemHome(), { path: root, flavor, name: input.body.name });
    return res;
  }

  @post("/testbed/import", { body: TestbedImportRequestSchema, response: TestbedImportResponseSchema })
  async importTestbed(input: { body: z.infer<typeof TestbedImportRequestSchema> }): Promise<z.infer<typeof TestbedImportResponseSchema>> {
    const rawInv = introspectConfig({ ...resolveDirs(input.body.dir), redact: false });
    return importArtifacts(resolveProject(input.body.root), input.body.selection, rawInv, (input.body.flavor ?? "claude") as TestbedFlavorId);
  }

  // Test-run a Gem from a .gem archive with a locally-installed ACP coding agent:
  // materialize into a runnable testbed dir, drive the agent against the task,
  // and (when expectations are given) attach a verification report.
  @post("/gem/run", { body: GemRunRequestSchema, response: GemRunResponseSchema })
  async runGem(input: { body: z.infer<typeof GemRunRequestSchema> }): Promise<z.infer<typeof GemRunResponseSchema>> {
    const b = input.body;
    const gem: Gem = b.archivePath
      ? readGemArchive(readArchiveDir(b.archivePath))
      : buildGem(introspectAll(b.dir, b.projects), b.selection!, { name: b.name ?? "gem", createdFrom: resolveDirs(b.dir).claudeDir });
    const agent = (b.agent ?? "claude") as AgentId;
    const runDir = deriveRunDir(gem.name);
    const out = await materializeAndRunGem({ gem, dir: runDir, task: b.task, agent, expectations: b.expectations });
    return { dir: runDir, agent: out.agent, materialized: out.materialized, run: out.run, verification: out.verification };
  }

  // Step 1 of the streaming flow: materialize the Gem (carries the full selection
  // over POST) and hand back an opaque runId. GET /api/gem/run/stream then runs it.
  @post("/gem/run/prepare", { body: GemRunPrepareRequestSchema, response: GemRunPrepareResponseSchema })
  async prepareGemRun(input: { body: z.infer<typeof GemRunPrepareRequestSchema> }): Promise<z.infer<typeof GemRunPrepareResponseSchema>> {
    const b = input.body;
    const gem: Gem = b.archivePath
      ? readGemArchive(readArchiveDir(b.archivePath))
      : buildGem(introspectAll(b.dir, b.projects), b.selection!, { name: b.name ?? "gem", createdFrom: resolveDirs(b.dir).claudeDir });
    const agent = (b.agent ?? "claude") as AgentId;
    const runDir = deriveRunDir(gem.name);
    const materialized = materializeGemToTestbed(gem, runDir, AGENT_ADAPTERS[agent].flavor);
    const runId = registerRun(runDir, agent);
    return { runId, runDir, agent, materialized };
  }

  // Resolve the configured registry source, or throw a clear error the UI can surface.
  private registrySource() {
    const cfg = registryConfigFromEnv();
    if (!cfg) throw new Error("the registry is not configured — set AGENTGEM_REGISTRY_REPO");
    return { cfg, source: githubRegistrySource(cfg) };
  }

  @get("/registry/ready", { query: PickQuerySchema, response: RegistryReadyResponseSchema })
  async registryReady(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof RegistryReadyResponseSchema>> {
    return { ready: registryReady() };
  }

  @get("/registry/index", { query: PickQuerySchema, response: RegistryIndexResponseSchema })
  async registryIndex(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof RegistryIndexResponseSchema>> {
    return this.registrySource().source.getIndex();
  }

  @get("/registry/search", { query: RegistrySearchQuerySchema, response: RegistrySearchResponseSchema })
  async registrySearch(input: { query: z.infer<typeof RegistrySearchQuerySchema> }): Promise<z.infer<typeof RegistrySearchResponseSchema>> {
    const index = await this.registrySource().source.getIndex();
    return { results: searchIndex(index, input.query.q ?? "", { kind: input.query.kind, tag: input.query.tag, limit: input.query.limit }) };
  }

  // Public, CORS-open (see originGuard), browse-only gem list. Graceful: unconfigured or a fetch
  // error yields { gems: [] }. Uses the shared TTL cache to bound GitHub traffic.
  @get("/registry/gems", { query: PickQuerySchema, response: RegistryGemsResponseSchema })
  async registryGems(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof RegistryGemsResponseSchema>> {
    const cfg = registryConfigFromEnv();
    const getIndex = cfg ? () => githubRegistrySource(cfg).getIndex() : null;
    const indexGems = await publicGemCache.get(getIndex, Date.now());
    const dbGems = this.db ? await safeDbGems(() => listCatalogGems(this.db!)) : [];
    return { gems: mergeGems(dbGems, indexGems) };
  }

  @post("/registry/resolve", { body: RegistryResolveRequestSchema, response: RegistryResolveResponseSchema })
  async registryResolve(input: { body: z.infer<typeof RegistryResolveRequestSchema> }): Promise<z.infer<typeof RegistryResolveResponseSchema>> {
    const { source } = this.registrySource();
    const { plan } = await resolveInstall({ refs: input.body.refs, mode: input.body.mode, target: input.body.target as TargetId | undefined, source, a2aServer: input.body.a2aServer });
    return { plan };
  }

  // Apply: materialize into `dest`, or land the merged Gem in the workspace store.
  @post("/registry/install", { body: RegistryInstallRequestSchema, response: RegistryInstallResponseSchema })
  async registryInstall(input: { body: z.infer<typeof RegistryInstallRequestSchema> }): Promise<z.infer<typeof RegistryInstallResponseSchema>> {
    const { source } = this.registrySource();
    const { plan, gem } = await resolveInstall({ refs: input.body.refs, mode: input.body.mode, target: input.body.target as TargetId | undefined, source, a2aServer: input.body.a2aServer });
    // Adoption fires only AFTER the install actually lands (below), never on a resolve-then-fail.
    const installed = plan.items.map((it) => ({ gemKey: it.key, version: it.version, gemDigest: "" }));
    if (input.body.mode === "materialize") {
      if (!input.body.dest) throw new Error("materialize mode requires `dest`");
      writeArchiveDir(input.body.dest, plan.materialize!.files);
      void emitAdoption(installed);   // opt-in + fire-and-forget; never awaited, never throws
      return { plan, applied: { mode: "materialize", dest: input.body.dest, written: Object.keys(plan.materialize!.files) } };
    }
    const name = input.body.workspaceName ?? gem.name;
    createWorkspace(name, gem);
    void emitAdoption(installed);   // opt-in + fire-and-forget; never awaited, never throws
    return { plan, applied: { mode: "workspace", workspace: name } };
  }

  @get("/settings/adoption", { query: PickQuerySchema, response: z.object({ enabled: z.boolean() }) })
  async getAdoptionSetting(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<{ enabled: boolean }> {
    return { enabled: readShareAdoption() };
  }

  @post("/settings/adoption", { body: z.object({ enabled: z.boolean() }), response: z.object({ enabled: z.boolean() }) })
  async setAdoptionSetting(input: { body: { enabled: boolean } }): Promise<{ enabled: boolean }> {
    setShareAdoption(input.body.enabled);
    return { enabled: input.body.enabled };
  }

  // OUTWARD-FACING: gated network publish. Reads a Gem from the workspace, writes its archive +
  // updated index in one commit. Requires GITHUB_TOKEN (enforced by the publisher).
  @post("/registry/publish", { body: RegistryPublishRequestSchema, response: RegistryPublishResponseSchema })
  async registryPublish(input: { body: z.infer<typeof RegistryPublishRequestSchema> }): Promise<z.infer<typeof RegistryPublishResponseSchema>> {
    const { cfg, source } = this.registrySource();
    const gem = readGemArchive(readWorkspace(input.body.workspace).files); // WorkspaceDetail exposes .files, not .gem
    const type = resolvePublishType(this.gemTypes, input.body.type, gem);
    const index = await source.getIndex();
    const publishedBy = await resolvePublishedBy(this.req, this.db);
    return publishGem({
      gem, scope: input.body.scope, name: input.body.name, version: input.body.version,
      dependencies: input.body.dependencies, index, publisher: githubRegistryPublisher(cfg),
      description: input.body.description, tags: input.body.tags, type, publishedBy,
      grade: gem.grade,
    });
  }

  // Bind: start the GitHub device flow for sybil-hardening. Returns { configured: false } when the
  // server has no client ID set — the UI can gate on this without an error state.
  @post("/bind/start", { body: z.object({}), response: BindStartSchema })
  async bindStart(_input: { body: Record<string, never> }, deps: StartDeps = {}): Promise<z.infer<typeof BindStartSchema>> {
    const cfg = bindConfig();
    if (!cfg.clientId) return { configured: false };
    const dc = await startDeviceBind(cfg, deps);
    return { configured: true, ...dc };
  }

  // Bind: complete the device flow — poll GitHub, sign the token, POST to the aggregator.
  @post("/bind/complete", { body: BindCompleteBodySchema, response: BindCompleteSchema })
  async bindComplete(input: { body: z.infer<typeof BindCompleteBodySchema> }, deps: CompleteDeps = {}): Promise<z.infer<typeof BindCompleteSchema>> {
    return completeDeviceBind(bindConfig(), { deviceCode: input.body.deviceCode, interval: input.body.interval }, deps);
  }

  // Bind: read the local binding.json (bound/unbound, no secret).
  @get("/bind/status", { query: PickQuerySchema, response: BindStatusSchema })
  async bindStatus(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof BindStatusSchema>> {
    return readBindingStatus();
  }

  // Pop the OS-native folder picker and return the chosen absolute path (null if cancelled).
  @get("/pick-folder", { query: PickQuerySchema, response: PickFolderSchema })
  async pickFolder(_input: { query: z.infer<typeof PickQuerySchema> }): Promise<z.infer<typeof PickFolderSchema>> {
    return { path: await pickFolder() };
  }

  @post("/workflow/analyze", { body: WorkflowAnalyzeRequestSchema, response: WorkflowAnalyzeResponseSchema })
  async workflowAnalyze(input: { body: z.infer<typeof WorkflowAnalyzeRequestSchema> }): Promise<z.infer<typeof WorkflowAnalyzeResponseSchema>> {
    const { dir, root } = input.body;
    // Inventory for exactly this one project (project-namespaced selection target).
    const inventory = introspectAll(dir, [root]);
    // introspectAll canonicalizes roots via resolveProject (path.resolve); match the same way.
    const project = (inventory.projects ?? []).find((p) => p.root === resolveProject(root));
    if (!project) throw new Error(`Project '${root}' not found in inventory`);
    // Delegate to the cache-aware core (warm-precompute path reuses the same result).
    const { payload } = await computeWorkflowAnalysis(root, { dir });
    return payload as z.infer<typeof WorkflowAnalyzeResponseSchema>;
  }

  // Accept a distilled draft: persist it to .agentgem/distilled/<name>/SKILL.md for
  // the user to review/promote (proposal §7) — NOT into .claude/skills/. The name is
  // re-validated as a kebab slug here (defense in depth) since it composes a path.
  @post("/workflow/draft", { body: DistilledSkillSchema, response: WorkflowDraftWriteResponseSchema })
  async writeWorkflowDraft(input: { body: z.infer<typeof DistilledSkillSchema> }): Promise<z.infer<typeof WorkflowDraftWriteResponseSchema>> {
    const skill = input.body;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) throw new Error(`invalid draft name '${skill.name}'`);
    return { path: writeDistilledDraft(skill) };
  }

  // Accept a distilled LESSON: persist it to .agentgem/distilled/lessons/<name>.md for
  // review/promote (mirrors workflow/draft). The kebab name is re-validated here (defense
  // in depth) since it composes a path.
  @post("/workflow/lesson", { body: DistilledLessonSchema, response: WorkflowDraftWriteResponseSchema })
  async writeWorkflowLesson(input: { body: z.infer<typeof DistilledLessonSchema> }): Promise<z.infer<typeof WorkflowDraftWriteResponseSchema>> {
    const lesson = input.body;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lesson.name)) throw new Error(`invalid lesson name '${lesson.name}'`);
    return { path: writeDistilledLesson(lesson) };
  }
}

// Query params can't carry arrays cleanly, so `projects` arrives JSON-encoded.
function parseProjectsQuery(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Compose the global inventory with project sections. Each root is the user's explicit
// native-picker selection; we canonicalize to absolute paths and dedup.
function introspectAll(dir: string | undefined, projects: string[] | undefined): ConfigInventory {
  const inventory = introspectConfig(resolveDirs(dir));
  const roots = (projects ?? []).map(resolveProject).filter((r, i, a) => r.length > 0 && a.indexOf(r) === i);
  if (roots.length) inventory.projects = roots.map(introspectProject);
  return inventory;
}
