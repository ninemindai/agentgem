import { z } from "zod";
import { createClient, defineRoute, type Client } from "@agentback/client";

// Minimal client-side schemas: validate ONLY what the UI reads. Zod strips the
// server's extra artifact fields. When a shared browser-safe contract package is
// extracted later, replace these with imports from it.
const ArtifactSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  content: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  source: z.string().optional(), // "standalone", a plugin name, "user"/"project", …
});
export const InventorySchema = z.object({
  skills: z.array(ArtifactSchema),
  mcpServers: z.array(ArtifactSchema),
  instructions: z.array(ArtifactSchema),
  hooks: z.array(ArtifactSchema),
  projects: z.array(z.unknown()).optional(),
});
const UsageItemSchema = z.object({
  type: z.string(),
  name: z.string(),
  invocations: z.number(),
  lastUsedMs: z.number().nullable().optional(),
});
export const UsageSchema = z.object({ artifacts: z.array(UsageItemSchema) });

export type Artifact = z.infer<typeof ArtifactSchema>;
export type Inventory = z.infer<typeof InventorySchema>;
export type UsageItem = z.infer<typeof UsageItemSchema>;
export type Usage = z.infer<typeof UsageSchema>;

export const inventoryRoute = defineRoute("GET", "/api/inventory", { response: InventorySchema });
export const usageRoute = defineRoute("GET", "/api/usage", {
  query: z.object({ scope: z.enum(["global"]).optional() }),
  response: UsageSchema,
});

// Selection shape shared by build/archive/materialize/run/workspace routes.
const GemSelectionSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    includeInstructions: z.boolean().optional(),
    instructions: z.array(z.string()).optional(),
    hooks: z.array(z.string()).optional(),
  }),
]);

const WorkspaceSummarySchema = z.object({
  name: z.string(),
  gemName: z.string(),
  version: z.string(),
  artifactCounts: z.object({
    skill: z.number(),
    mcp_server: z.number(),
    instructions: z.number(),
    hook: z.number(),
  }),
  // (type, name) of each artifact — lets "Open" restore the gem's selection.
  artifacts: z.array(z.object({ type: z.string(), name: z.string() })),
  modifiedMs: z.number(), // dir mtime — recency ordering for the switcher dropdown
  checks: z.number(),
  renderedTargets: z.array(z.string()),
});
export const WorkspacesSchema = z.object({ workspaces: z.array(WorkspaceSummarySchema) });
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export const workspacesRoute = defineRoute("GET", "/api/workspaces", { response: WorkspacesSchema });
export const createWorkspaceRoute = defineRoute("POST", "/api/workspaces", {
  body: z.object({ name: z.string(), selection: GemSelectionSchema }),
  response: z.object({ name: z.string() }),
});
export const deleteWorkspaceRoute = defineRoute("POST", "/api/workspace/delete", {
  body: z.object({ name: z.string() }),
  response: z.object({ deleted: z.string() }),
});
export const renderWorkspaceRoute = defineRoute("POST", "/api/workspace/render", {
  body: z.object({ name: z.string(), target: z.string() }),
  response: z.object({ target: z.string(), path: z.string() }),
});

// Run / deploy a rendered workspace target (local / vercel / cloudflare).
export const runReadyRoute = defineRoute("GET", "/api/run-ready", {
  query: z.object({ name: z.string(), target: z.string() }),
  response: z.object({ local: z.boolean(), vercel: z.boolean(), cloudflare: z.boolean() }),
});
const RunStateSchema = z.object({
  mode: z.enum(["local", "vercel", "cloudflare"]),
  state: z.enum(["idle", "installing", "building", "running", "deploying", "failed"]),
  url: z.string().optional(),
  logTail: z.array(z.string()),
});
export type RunState = z.infer<typeof RunStateSchema>;
export const runRoute = defineRoute("POST", "/api/run", {
  body: z.object({ name: z.string(), target: z.string(), mode: z.enum(["local", "vercel", "cloudflare"]) }),
  response: RunStateSchema,
});
export const runStatusRoute = defineRoute("GET", "/api/run-status", {
  query: z.object({ name: z.string(), target: z.string() }),
  response: RunStateSchema,
});
export const runStopRoute = defineRoute("POST", "/api/run/stop", {
  body: z.object({ name: z.string(), target: z.string() }),
  response: z.object({ stopped: z.boolean() }),
});

// POST /api/gem — build a gem from a selection. Request mirrors the server's
// A gem check, kept loose so the full object round-trips back into the build
// unchanged (the server validates it strictly).
export const GemCheckSchema = z.looseObject({ kind: z.string(), name: z.string() });
export type GemCheck = z.infer<typeof GemCheckSchema>;

export const GemRequestSchema = z.object({
  selection: GemSelectionSchema,
  name: z.string().optional(),
  checks: z.array(GemCheckSchema).optional(),
});
const GemArtifactSchema = z.object({ type: z.string(), name: z.string() });
const SecretRequirementSchema = z.object({ name: z.string() });
export const GemSchema = z.object({
  name: z.string(),
  createdFrom: z.string(),
  artifacts: z.array(GemArtifactSchema),
  checks: z.array(z.unknown()),
  requiredSecrets: z.array(SecretRequirementSchema),
});
export type Gem = z.infer<typeof GemSchema>;

export const buildGemRoute = defineRoute("POST", "/api/gem", {
  body: GemRequestSchema,
  response: GemSchema,
});

export const ScorecardBuildRequestSchema = z.object({
  dir: z.string().optional(),
  name: z.string().optional(),
  selections: z.array(z.object({ root: z.string(), keys: z.array(z.string()) })),
});
export const scorecardBuildRoute = defineRoute("POST", "/api/scorecard/build", {
  body: ScorecardBuildRequestSchema,
  response: GemSchema,
});

// POST /api/archive — with `tar:true` the server returns the portable .gem
// (tar.gz) as base64 in `tarGz`. We only send/read those fields.
export const ArchiveRequestSchema = z.object({
  selection: GemSelectionSchema,
  name: z.string().optional(),
  tar: z.boolean().optional(),
});
const ArchiveResponseSchema = z.object({ tarGz: z.string().nullable() });
export const archiveRoute = defineRoute("POST", "/api/archive", {
  body: ArchiveRequestSchema,
  response: ArchiveResponseSchema,
});

// Materialize targets (registry keys on the server). Stable enum; mirrors the
// vanilla UI's target select.
export const TARGET_IDS = [
  "claude", "codex", "agents", "hermes", "eve", "flue", "openai-sandbox", "agentcore", "a2a",
] as const;
export type TargetId = (typeof TARGET_IDS)[number];

const MaterializeRequestSchema = z.object({
  selection: GemSelectionSchema,
  target: z.string(),
  name: z.string().optional(),
});
export const MaterializeResponseSchema = z.object({
  target: z.string(),
  files: z.record(z.string(), z.string()),
  skipped: z.array(z.object({ artifact: z.string(), type: z.string(), reason: z.string() })),
  compatibility: z.record(z.string(), z.object({ supported: z.number(), skipped: z.number() })),
});
export type MaterializeResult = z.infer<typeof MaterializeResponseSchema>;

export const materializeRoute = defineRoute("POST", "/api/materialize", {
  body: MaterializeRequestSchema,
  response: MaterializeResponseSchema,
});

// POST /api/gem/run/prepare — stage a run (materialize into a server-derived
// runDir) and get an opaque runId; the SSE GET /api/gem/run/stream then runs it.
const PrepareRunRequestSchema = z.object({
  selection: GemSelectionSchema,
  name: z.string().optional(),
  agent: z.enum(["claude", "codex"]).optional(),
});
const PrepareRunResponseSchema = z.object({ runId: z.string(), agent: z.string() });
export const prepareRunRoute = defineRoute("POST", "/api/gem/run/prepare", {
  body: PrepareRunRequestSchema,
  response: PrepareRunResponseSchema,
});

// POST /api/scaffold-checks — suggest behavioral/external checks for a selection.
export const scaffoldChecksRoute = defineRoute("POST", "/api/scaffold-checks", {
  body: z.object({ selection: GemSelectionSchema, name: z.string().optional() }),
  response: z.object({ checks: z.array(GemCheckSchema) }),
});

// Registry (GitHub-backed). ready → search → install-to-workspace.
export const registryReadyRoute = defineRoute("GET", "/api/registry/ready", {
  response: z.object({ ready: z.boolean() }),
});
const RegistryResultSchema = z.object({
  key: z.string(),
  latest: z.string(),
  score: z.number(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  author: z.string().optional(),
  artifactKinds: z.array(z.string()).optional(),
});
export type RegistryResult = z.infer<typeof RegistryResultSchema>;
export const registrySearchRoute = defineRoute("GET", "/api/registry/search", {
  query: z.object({ q: z.string().optional() }),
  response: z.object({ results: z.array(RegistryResultSchema) }),
});
export const registryInstallRoute = defineRoute("POST", "/api/registry/install", {
  body: z.object({
    refs: z.array(z.string()).min(1),
    mode: z.enum(["materialize", "workspace"]),
    workspaceName: z.string().optional(),
  }),
  response: z.object({
    applied: z.object({ mode: z.string(), workspace: z.string().optional(), dest: z.string().optional() }),
  }),
});
export const registryPublishRoute = defineRoute("POST", "/api/registry/publish", {
  body: z.object({
    workspace: z.string(),
    scope: z.string(),
    name: z.string().optional(),
    version: z.string(),
    dependencies: z.array(z.string()).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    type: z.string().optional(),
  }),
  response: z.object({ ref: z.string(), version: z.string(), gemDigest: z.string(), commit: z.string(), path: z.string() }),
});

// Testbed: discovery (recents + project candidates) + scaffold a new one.
const RecentEntrySchema = z.object({
  path: z.string(),
  flavor: z.string(),
  name: z.string(),
  lastUsed: z.string(),
  exists: z.boolean(),
});
export type RecentEntry = z.infer<typeof RecentEntrySchema>;
export const testbedRecentsRoute = defineRoute("GET", "/api/testbed/recents", {
  response: z.object({ recents: z.array(RecentEntrySchema) }),
});
const ProjectCandidateSchema = z.object({
  path: z.string(),
  flavor: z.string(),
  lastUsed: z.string().nullable(),
  exists: z.boolean(),
});
export type ProjectCandidate = z.infer<typeof ProjectCandidateSchema>;
export const testbedProjectsRoute = defineRoute("GET", "/api/testbed/projects", {
  response: z.object({ projects: z.array(ProjectCandidateSchema) }),
});
export const testbedScaffoldRoute = defineRoute("POST", "/api/testbed/scaffold", {
  body: z.object({ root: z.string(), name: z.string() }),
  response: z.object({ root: z.string(), created: z.array(z.string()) }),
});
// Import selected machine configs into a testbed dir.
const TestbedImportSelectionSchema = z.object({
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  hooks: z.array(z.string()).optional(),
  includeInstructions: z.boolean().optional(),
});
export const testbedImportRoute = defineRoute("POST", "/api/testbed/import", {
  body: z.object({ root: z.string(), selection: TestbedImportSelectionSchema }),
  response: z.object({ written: z.array(z.unknown()), skipped: z.array(z.unknown()) }),
});

// Publish a selection to a managed backend (claude-managed / agentcore-managed),
// then undeploy by the workspace-record name.
export const PUBLISH_TARGETS = ["claude-managed", "agentcore-managed"] as const;
export const publishReadyRoute = defineRoute("GET", "/api/publish-ready", {
  query: z.object({ target: z.string() }),
  response: z.object({ ready: z.boolean() }),
});
export const publishRoute = defineRoute("POST", "/api/publish", {
  body: z.object({
    selection: GemSelectionSchema,
    name: z.string().optional(),
    target: z.enum(PUBLISH_TARGETS),
    requestId: z.string().min(8).max(128),
    wsName: z.string().optional(),
  }),
  response: z.looseObject({
    kind: z.string(),
    agentId: z.string().optional(),
    environmentId: z.string().optional(),
    version: z.string().optional(),
    harnessId: z.string().optional(),
  }),
});
export const undeployRoute = defineRoute("POST", "/api/undeploy", {
  body: z.object({ name: z.string(), target: z.enum(["eve", "flue", "claude-managed", "agentcore"]) }),
  response: z.object({ removed: z.boolean() }),
});

// Deploy: backend readiness + credential management.
export const CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "VERCEL_TOKEN", "CLOUDFLARE_API_TOKEN"] as const;
export const deployTargetsRoute = defineRoute("GET", "/api/deploy-targets", {
  response: z.object({
    targets: z.array(z.object({ id: z.string(), label: z.string(), ready: z.boolean() })),
  }),
});
export const setCredentialRoute = defineRoute("POST", "/api/credential", {
  body: z.object({ key: z.enum(CREDENTIAL_KEYS), value: z.string().min(1) }),
  response: z.object({ ok: z.boolean() }),
});

// Transfer: send a selection (returns an opaque ticket), receive a gem by ticket,
// and encrypt an object (returns ciphertextBase64 for the transfer payload).
export const transferSendRoute = defineRoute("POST", "/api/transfer/send", {
  body: z.object({ selection: GemSelectionSchema, name: z.string().optional() }),
  response: z.object({ ticket: z.string() }),
});
export const transferReceiveRoute = defineRoute("POST", "/api/transfer/receive", {
  body: z.object({ ticket: z.string() }),
  response: z.object({
    gem: z.looseObject({ name: z.string() }),
    meta: z.looseObject({ name: z.string(), version: z.string() }),
    bytesBase64: z.string(),
  }),
});
export const transferCiphertextRoute = defineRoute("POST", "/api/transfer/ciphertext", {
  body: z.object({ object: z.string() }),
  response: z.object({ ciphertextBase64: z.string() }),
});
export const gemApplyRoute = defineRoute("POST", "/api/gem/apply", {
  body: z.object({ bytesBase64: z.string(), dir: z.string(), flavor: z.string().optional() }),
  response: z.object({
    dir: z.string(),
    name: z.string(),
    written: z.array(z.looseObject({ type: z.string(), name: z.string(), overwritten: z.boolean() })),
    skipped: z.array(z.looseObject({ artifact: z.string(), reason: z.string() })),
  }),
});

// Observe: session telemetry from the local aggregator.
const ObservePayloadSchema = z.object({
  pulse: z.object({ sessions: z.number(), msgs: z.number(), tokens: z.number(), activeMs: z.number() }),
  daily: z.array(z.object({ date: z.string(), sessions: z.number(), msgs: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number() })),
  sessions: z.array(z.object({ agent: z.enum(["claude", "codex"]), sessionId: z.string(), project: z.string().nullable(), model: z.string().nullable(), startMs: z.number(), endMs: z.number(), durationMs: z.number(), msgs: z.number(), tokens: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(), gitBranch: z.string().nullable() })),
  models: z.array(z.object({ model: z.string(), agent: z.enum(["claude", "codex"]), sessions: z.number(), tokens: z.number() })),
  facets: z.object({ agents: z.array(z.string()), projects: z.array(z.string()), models: z.array(z.string()) }),
  range: z.enum(["today", "7d", "30d", "all"]),
});
export type ObservePayload = z.infer<typeof ObservePayloadSchema>;
export type ObserveRange = ObservePayload["range"];
export type SessionRow = ObservePayload["sessions"][number];
export type DailyPoint = ObservePayload["daily"][number];
export type ModelSlice = ObservePayload["models"][number];
export type ObserveFacets = ObservePayload["facets"];

export type ObserveFilter = { agent?: string; project?: string; model?: string; minMsgs?: number };

export const observeRoute = defineRoute("GET", "/api/observe", {
  query: z.object({
    range: z.enum(["today", "7d", "30d", "all"]).optional(),
    agent: z.string().optional(),
    project: z.string().optional(),
    model: z.string().optional(),
    minMsgs: z.number().optional(),
    refresh: z.boolean().optional(),   // ?refresh=true forces a re-scan past the 15s server cache
  }),
  response: ObservePayloadSchema,
});

// Raw uncapped scan: the console fetches this ONCE (and on Refresh) and derives
// every range/filter view client-side via @agentgem/insight's aggregateObserve —
// so range/filter toggles cost zero API calls. Shape mirrors insight's SessionStat.
export const ObserveRawSchema = z.object({
  sessions: z.array(z.object({
    agent: z.enum(["claude", "codex"]),
    sessionId: z.string(),
    project: z.string().nullable(),
    model: z.string().nullable(),
    gitBranch: z.string().nullable(),
    startMs: z.number(), endMs: z.number(), msgs: z.number(),
    tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(),
  })),
});
export const observeRawRoute = defineRoute("GET", "/api/observe/raw", {
  query: z.object({ refresh: z.boolean().optional() }),
  response: ObserveRawSchema,
});

// Per-session transcript drill-down: lazy, scrubbed, fetched only when a session
// is opened. Mirrors the insight TranscriptView shape.
const TokenBreakdownSchema = z.object({ in: z.number(), out: z.number(), cache: z.number() });
const TranscriptSpanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), role: z.enum(["user", "assistant"]), text: z.string() }),
  z.object({ kind: z.literal("tool_call"), name: z.string(), input: z.string(), output: z.string().optional(), error: z.boolean().optional() }),
]);
export const TranscriptViewSchema = z.object({
  sessionId: z.string(),
  agent: z.enum(["claude", "codex"]),
  meta: ObserveRawSchema.shape.sessions.element,
  turns: z.array(z.object({
    id: z.string(), role: z.enum(["user", "assistant"]), tsMs: z.number(),
    spans: z.array(TranscriptSpanSchema), tokens: TokenBreakdownSchema,
  })),
});
export type TranscriptView = z.infer<typeof TranscriptViewSchema>;
export type TranscriptTurn = TranscriptView["turns"][number];
export type TranscriptSpan = TranscriptTurn["spans"][number];
export const inspectSessionRoute = defineRoute("GET", "/api/inspect/session", {
  query: z.object({ id: z.string(), agent: z.enum(["claude", "codex"]) }),
  response: TranscriptViewSchema,
});

// "Distill this session" (phase 3): runs the workflow scan + distill pipeline over
// one session, returning draft skills. Mirrors the server DistilledSkillSchema so a
// draft round-trips back to /workflow/draft unchanged.
const OccurrenceSchema = z.object({ sessionId: z.string(), transcript: z.string(), messageIndices: z.array(z.number()), atMs: z.number() });
export const DistilledSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  triggers: z.array(z.string()),
  tools: z.array(z.string()),
  mutating: z.boolean(),
  body: z.string(),
  evidence: z.object({
    sessions: z.number(), exampleSequence: z.array(z.string()), root: z.string(),
    provenance: z.object({ occurrences: z.array(OccurrenceSchema) }),
  }),
  status: z.literal("draft"),
  confidence: z.enum(["high", "medium", "low"]),
  origin: z.enum(["llm", "heuristic"]),
});
export type DistilledSkill = z.infer<typeof DistilledSkillSchema>;
export const DistilledLessonSchema = z.object({
  name: z.string(), body: z.string(), importance: z.enum(["high", "medium"]), status: z.literal("draft"),
  evidence: z.object({ sessions: z.number(), root: z.string(), provenance: z.object({ occurrences: z.array(z.unknown()) }) }),
});
export type DistilledLesson = z.infer<typeof DistilledLessonSchema>;
export const inspectDistillRoute = defineRoute("POST", "/api/inspect/distill", {
  body: z.object({ id: z.string(), agent: z.enum(["claude", "codex"]) }),
  response: z.object({ distilled: z.array(DistilledSkillSchema), lessons: z.array(DistilledLessonSchema), degraded: z.boolean() }),
});
export const workflowDraftRoute = defineRoute("POST", "/api/workflow/draft", {
  body: DistilledSkillSchema,
  response: z.object({ path: z.string() }),
});
export const workflowLessonRoute = defineRoute("POST", "/api/workflow/lesson", {
  body: DistilledLessonSchema,
  response: z.object({ path: z.string() }),
});

export const ScorecardSchema = z.object({
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
});
export type Scorecard = z.infer<typeof ScorecardSchema>;
export type ProjectGoldmine = Scorecard["projects"][number];

export const scorecardRoute = defineRoute("GET", "/api/scorecard", {
  query: z.object({ dir: z.string().optional(), projects: z.string().optional() }),
  response: ScorecardSchema,
});

export const WorkflowDetailSchema = z.object({
  key: z.string(), name: z.string(), description: z.string(),
  triggers: z.array(z.string()), tools: z.array(z.string()), mutating: z.boolean(),
  steps: z.array(z.string()), sessions: z.number(),
  confidence: z.enum(["high", "medium", "low"]), portable: z.boolean(),
});
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>;
export const scorecardWorkflowRoute = defineRoute("GET", "/api/scorecard/workflow", {
  query: z.object({ dir: z.string().optional(), root: z.string(), key: z.string() }),
  response: WorkflowDetailSchema,
});

export const createShareRoute = defineRoute("POST", "/api/share", {
  body: z.object({
    kind: z.literal("certificate"),
    counts: z.object({ breadth: z.number(), battleTested: z.number(), portable: z.number() }),
    generatedAtMs: z.number(),
  }),
  response: z.object({ id: z.string(), url: z.string() }),
});
export const createGemShareRoute = defineRoute("POST", "/api/share", {
  body: z.object({ kind: z.literal("gem"), name: z.string(), provenance: z.string(), generatedAtMs: z.number() }),
  response: z.object({ id: z.string(), url: z.string() }),
});

// ── Optimize (Plan 1: local prune + instructions health) ──
const OptimizeArtifactSchema = z.object({
  name: z.string(),
  type: z.enum(["skill", "mcp"]),
  source: z.string(),
  contextTokens: z.number(),
  uses: z.number(),
  lastUsedMs: z.number().nullable(),
  prune: z.boolean(),
  change: z.object({ file: z.string(), key: z.string() }),
});
const OptimizeInstructionSchema = z.object({
  name: z.string(),
  source: z.string(),
  contextTokens: z.number(),
  lines: z.number(),
  flags: z.array(z.enum(["oversized", "very-long", "duplicate-lines"])),
});
const OptimizePayloadSchema = z.object({
  range: z.enum(["today", "7d", "30d", "all"]),
  artifacts: z.array(OptimizeArtifactSchema),
  instructions: z.array(OptimizeInstructionSchema),
});
export type OptimizeArtifact = z.infer<typeof OptimizeArtifactSchema>;
export type OptimizeInstruction = z.infer<typeof OptimizeInstructionSchema>;
export type OptimizePayload = z.infer<typeof OptimizePayloadSchema>;
export type OptimizeRange = OptimizePayload["range"];

export const optimizeRoute = defineRoute("GET", "/api/optimize", {
  query: z.object({ range: z.enum(["today", "7d", "30d", "all"]).optional(), refresh: z.boolean().optional() }),
  response: OptimizePayloadSchema,
});

// ── Optimize ▸ Discover (Plan 2: registry recommendations) ──
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
export type DiscoverCandidate = z.infer<typeof DiscoverCandidateSchema>;
export type DiscoverPayload = z.infer<typeof DiscoverPayloadSchema>;

export const discoverRoute = defineRoute("GET", "/api/optimize/discover", {
  response: DiscoverPayloadSchema,
});
export const rerankDiscoverRoute = defineRoute("POST", "/api/optimize/discover/rerank", {
  body: z.object({ candidates: z.array(DiscoverCandidateSchema), topics: z.array(z.string()) }),
  response: DiscoverPayloadSchema,
});
export const InstallSkillResultSchema = z.object({ ok: z.boolean(), skill: z.string(), message: z.string() });
export type InstallSkillResult = z.infer<typeof InstallSkillResultSchema>;
export const installSkillRoute = defineRoute("POST", "/api/optimize/discover/install", {
  body: z.object({ source: z.string(), skillId: z.string() }),
  response: InstallSkillResultSchema,
});

// Playbook: distill a project's sessions into a draft playbook, then publish to Explore.
export const playbookPrepareRoute = defineRoute("POST", "/api/playbook/prepare", {
  body: z.object({ root: z.string() }),
  response: z.object({ skills: z.array(z.string()), lessons: z.array(z.string()), root: z.string(), degraded: z.boolean() }),
});
export const playbookPublishRoute = defineRoute("POST", "/api/playbook/publish", {
  body: z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), description: z.string().optional(), tags: z.array(z.string()).optional(), provenance: z.string() }),
  response: z.object({ exploreRef: z.string(), version: z.string(), shareUrl: z.string() }),
});

// Network cross-model benchmark (aggregator, k-anonymised). Per-model outcome
// counts across producers; success rate = mostly / (mostly + partially + notAchieved).
export const BenchmarkSchema = z.array(z.object({
  model: z.string(), mostly: z.number(), partially: z.number(), notAchieved: z.number(),
  producers: z.number(), verifiedProducers: z.number(),
}));
export type BenchmarkRow = z.infer<typeof BenchmarkSchema>[number];
export const benchmarksRoute = defineRoute("GET", "/api/aggregator/benchmarks", {
  query: z.object({ gemDigest: z.string().optional() }),
  response: BenchmarkSchema,
});

// Identity binding: link the local key to a GitHub account via device-flow OAuth.
export const bindStatusRoute = defineRoute("GET", "/api/bind/status", {
  response: z.object({ bound: z.boolean(), login: z.string().optional(), provider: z.string().optional() }),
});
export const bindStartRoute = defineRoute("POST", "/api/bind/start", {
  response: z.object({ configured: z.boolean(), userCode: z.string().optional(), verificationUri: z.string().optional(), deviceCode: z.string().optional(), interval: z.number().optional() }),
});
export const bindCompleteRoute = defineRoute("POST", "/api/bind/complete", {
  body: z.object({ deviceCode: z.string(), interval: z.number().optional() }),
  response: z.object({ bound: z.boolean(), login: z.string().optional(), rejected: z.string().optional() }),
});

export const makeClient = (apiBase: string): Client => createClient({ baseURL: apiBase });
