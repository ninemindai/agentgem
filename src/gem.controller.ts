// src/gem.controller.ts
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { introspectConfig, introspectProject } from "./gem/introspect.js";
import { buildGem } from "./gem/buildGem.js";
import { scaffoldChecks } from "./gem/checks.js";
import { materialize, compatibility } from "./gem/targets.js";
import type { TargetId } from "./gem/targets.js";
import { DEPLOY_REGISTRY, deployTargetList } from "./gem/deploy.js";
import type { DeployTargetId } from "./gem/deploy.js";
import { createWorkspace, listWorkspaces, readWorkspace, renderTarget, deleteWorkspace } from "./gem/workspaces.js";
import { writeGemArchive, readGemArchive } from "./gem/archive.js";
import type { GemLock } from "./gem/archive.js";
import { writeArchiveDir, readArchiveDir } from "./gem/archiveFs.js";
import { packTar } from "./gem/archiveTar.js";
import { exportGem, importGem } from "./gem/share.js";
import { fetchGemBytes } from "./gem/safeFetch.js";
import { sendBytes, receiveTicket, natsStoreFromEnv, assertConfigured, mintCredsFromEnv, fetchAndBurnCiphertext } from "./transfer/service.js";
import type { Gem } from "./gem/types.js";
import { readDeployRecord, writeDeployRecord, clearDeployRecord } from "./gem/deployRecord.js";
import type { DeployBackend } from "./gem/deployRecord.js";
import { undeployManagedAgent, anthropicPublishClient } from "./publish.js";
import { undeployAgentcoreHarness, realAgentcoreControlClient } from "./gem/agentcorePublish.js";

import type { ConfigInventory } from "./gem/types.js";
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
  TestbedScaffoldRequestSchema, TestbedScaffoldResponseSchema,
  TestbedImportRequestSchema, TestbedImportResponseSchema,
  AgentcoreReadyResponseSchema, AgentcoreDeployRequestSchema, AgentcoreStatusQuerySchema, AgentcoreDeployStateSchema,
  RegistryReadyResponseSchema, RegistryIndexResponseSchema,
  RegistrySearchQuerySchema, RegistrySearchResponseSchema,
  RegistryResolveRequestSchema, RegistryResolveResponseSchema,
  RegistryInstallRequestSchema, RegistryInstallResponseSchema,
  RegistryPublishRequestSchema, RegistryPublishResponseSchema,
  UndeployRequestSchema, UndeployResponseSchema, DeployRecordQuerySchema, DeployRecordResponseSchema,
  WorkflowAnalyzeRequestSchema, WorkflowAnalyzeResponseSchema,
  DistilledSkillSchema, WorkflowDraftWriteResponseSchema,
  GemRunRequestSchema, GemRunResponseSchema,
  GemRunPrepareRequestSchema, GemRunPrepareResponseSchema,
} from "./schemas.js";
import { claudeTranscriptsForCwd, scanWorkflow } from "./gem/workflowScan.js";
import { recommendWorkflow, recommendationToSelection } from "./gem/acpRecommender.js";
import { distillWorkflow } from "./gem/distill.js";
import { writeDistilledDraft, stageDraftsByEvidence } from "./gem/draftStage.js";
import { runReadiness, startLocal, stopLocal, getRunStatus, deployVercel, deployCloudflare, undeployVercel, undeployCloudflare } from "./gem/run.js";
import { setCredential } from "./gem/credentials.js";
import { agentcoreReadiness, deployAgentcore, getAgentcoreStatus } from "./gem/agentcoreRun.js";
import { scaffoldTestbed, importArtifacts } from "./gem/testbed.js";
import { materializeAndRunGem, materializeGemToTestbed, registerRun, AGENT_ADAPTERS, type AgentId } from "./gem/runGem.js";
import { detectFlavor, suggestTestbed, discoverProjects } from "./gem/testbedFlavors.js";
import type { TestbedFlavorId } from "./gem/testbedFlavors.js";
import { readRecents, upsertRecent } from "./gem/recents.js";
import { resolveInstall, publishGem } from "./gem/registry.js";
import { searchIndex } from "./gem/search.js";
import { githubRegistrySource, githubRegistryPublisher, registryConfigFromEnv, registryReady } from "./gem/registryGithub.js";
import { resolveDirs, resolveProject, agentgemHome } from "./resolveDir.js";
import { pickFolder } from "./pickFolder.js";

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
  @get("/inventory", { query: DirQuerySchema, response: InventorySchema })
  async inventory(input: { query: z.infer<typeof DirQuerySchema> }): Promise<z.infer<typeof InventorySchema>> {
    return introspectAll(input.query.dir, parseProjectsQuery(input.query.projects));
  }

  @post("/gem", { body: GemRequestSchema, response: GemSchema })
  async gem(input: { body: z.infer<typeof GemRequestSchema> }): Promise<z.infer<typeof GemSchema>> {
    const dirs = resolveDirs(input.body.dir);
    // Fold any accepted distilled drafts into the inventory (by evidence.root)
    // before resolution, so a selection can reference one by name (proposal §7b).
    const inventory = stageDraftsByEvidence(introspectAll(input.body.dir, input.body.projects), input.body.distilledDrafts ?? []);
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
    const inventory = stageDraftsByEvidence(introspectAll(input.body.dir, input.body.projects), input.body.distilledDrafts ?? []);
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
    const inventory = stageDraftsByEvidence(introspectAll(input.body.dir, input.body.projects), input.body.distilledDrafts ?? []);
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
    if (input.body.mode === "materialize") {
      if (!input.body.dest) throw new Error("materialize mode requires `dest`");
      writeArchiveDir(input.body.dest, plan.materialize!.files);
      return { plan, applied: { mode: "materialize", dest: input.body.dest, written: Object.keys(plan.materialize!.files) } };
    }
    const name = input.body.workspaceName ?? gem.name;
    createWorkspace(name, gem);
    return { plan, applied: { mode: "workspace", workspace: name } };
  }

  // OUTWARD-FACING: gated network publish. Reads a Gem from the workspace, writes its archive +
  // updated index in one commit. Requires GITHUB_TOKEN (enforced by the publisher).
  @post("/registry/publish", { body: RegistryPublishRequestSchema, response: RegistryPublishResponseSchema })
  async registryPublish(input: { body: z.infer<typeof RegistryPublishRequestSchema> }): Promise<z.infer<typeof RegistryPublishResponseSchema>> {
    const { cfg, source } = this.registrySource();
    const gem = readGemArchive(readWorkspace(input.body.workspace).files); // WorkspaceDetail exposes .files, not .gem
    const index = await source.getIndex();
    return publishGem({
      gem, scope: input.body.scope, name: input.body.name, version: input.body.version,
      dependencies: input.body.dependencies, index, publisher: githubRegistryPublisher(cfg),
      description: input.body.description, tags: input.body.tags,
    });
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

    const dirs = resolveDirs(dir);
    const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
    // The top-level inventory IS the global/plugin inventory; the project section
    // is namespaced separately. Scan + recommend over both.
    const scanInv = { project, global: { skills: inventory.skills, mcpServers: inventory.mcpServers, hooks: inventory.hooks } };
    const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
    // Selective recommendation + skill distillation run concurrently — both
    // never throw, so wall-clock stays max(...) not sum (proposal §5).
    const [{ analysis, degraded }, distill] = await Promise.all([
      recommendWorkflow(signal, scanInv),
      distillWorkflow(signal, scanInv),
    ]);
    const candidates = analysis.candidates.map((c) => ({ ...c, selection: recommendationToSelection(c) as Record<string, unknown> }));
    return {
      candidates,
      gaps: analysis.gaps,
      distilled: distill.distilled,
      signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
      degraded,
    };
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
