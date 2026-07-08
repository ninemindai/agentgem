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
  subagents: z.array(ArtifactSchema),
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

// Rubrics catalog (built-in + user rubrics) for the picker + library panels.
export const RubricSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  target: z.string(),
  naturalScope: z.enum(["session", "project", "all"]).optional(),
  factors: z.array(z.object({ factor: z.string(), weight: z.number().optional() })),
  criteria: z.array(z.looseObject({ id: z.string() })).optional(),
  builtin: z.boolean().optional(),   // built-in rubrics can't be edited/deleted
});
export type RubricSummary = z.infer<typeof RubricSummarySchema>;
export const rubricsRoute = defineRoute("GET", "/api/rubrics", {
  response: z.object({ rubrics: z.array(RubricSummarySchema) }),
});

// Authoring: validate (live preview) / save / delete user rubrics. The request body
// is the candidate rubric object (arbitrary — the server validates and reports errors).
export const RubricValidationSchema = z.object({
  valid: z.boolean(),
  error: z.string().optional(),
  rubric: RubricSummarySchema.optional(),
  factors: z.array(z.object({ factor: z.string(), kind: z.enum(["detector", "rule", "criterion", "unknown"]) })).optional(),
  unknownFactors: z.array(z.string()).optional(),
  saved: z.boolean().optional(),
});
export type RubricValidation = z.infer<typeof RubricValidationSchema>;
export const validateRubricRoute = defineRoute("POST", "/api/rubrics/validate", { body: z.looseObject({}), response: RubricValidationSchema });
export const saveRubricRoute = defineRoute("POST", "/api/rubrics", { body: z.looseObject({}), response: RubricValidationSchema });
export const deleteRubricRoute = defineRoute("POST", "/api/rubrics/delete", {
  body: z.object({ id: z.string() }),
  response: z.object({ deleted: z.boolean(), error: z.string().optional() }),
});
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
    subagents: z.array(z.string()).optional(),
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
    subagent: z.number(),
    game: z.number(),
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
  "cline", "gemini", "continue", "cursor",
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

// POST /api/gem/verify/prepare — stage a streaming cross-agent verify (contract-only;
// the server rejects contract-less gems here so failures never reach the stream).
const PrepareVerifyRequestSchema = z.object({
  selection: GemSelectionSchema,
  name: z.string().optional(),
});
const PrepareVerifyResponseSchema = z.object({
  verifyId: z.string(),
  gemName: z.string(),
  gemDigest: z.string(),
  agents: z.array(z.string()),
});
export const prepareVerifyRoute = defineRoute("POST", "/api/gem/verify/prepare", {
  body: PrepareVerifyRequestSchema,
  response: PrepareVerifyResponseSchema,
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
  publishedBy: z.string().optional(),
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
  sessions: z.array(z.object({ agent: z.string(), sessionId: z.string(), project: z.string().nullable(), model: z.string().nullable(), startMs: z.number(), endMs: z.number(), durationMs: z.number(), msgs: z.number(), tokens: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(), gitBranch: z.string().nullable() })),
  models: z.array(z.object({ model: z.string(), agent: z.string(), sessions: z.number(), tokens: z.number() })),
  byTool: z.array(z.object({ name: z.string(), count: z.number() })),
  bySkill: z.array(z.object({ name: z.string(), count: z.number() })),
  bySubagent: z.array(z.object({ name: z.string(), count: z.number() })),
  usageDaily: z.array(z.object({
    date: z.string(),
    tools: z.record(z.string(), z.number()),
    skills: z.record(z.string(), z.number()),
    subagents: z.record(z.string(), z.number()),
  })),
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
    agent: z.string(),
    sessionId: z.string(),
    project: z.string().nullable(),
    model: z.string().nullable(),
    gitBranch: z.string().nullable(),
    startMs: z.number(), endMs: z.number(), msgs: z.number(),
    tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(),
    // Per-session usage counts (optional — absent for tool-free sessions / older scans).
    tools: z.record(z.string(), z.number()).optional(),
    skills: z.record(z.string(), z.number()).optional(),
    subagents: z.record(z.string(), z.number()).optional(),
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
  agent: z.string(),
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

// Per-session context-hygiene report: the five hygiene detectors + score over
// one scanned transcript, shown alongside the transcript in Inspect → Session.
// Mirrors the server HygieneReportSchema (src/gem.controller.ts) exactly.
export const HygieneReportSchema = z.object({
  meta: z.object({ sessionId: z.string(), transcript: z.string(), model: z.string().nullable(), cap: z.number() }),
  curve: z.array(z.object({ turn: z.number(), msgIndex: z.number(), ctxTokens: z.number(), cacheCreation: z.number(), outTokens: z.number() })),
  events: z.array(z.object({ msgIndex: z.number(), kind: z.enum(["skill", "agent"]), name: z.string() })),
  factors: z.array(z.object({ id: z.string(), title: z.string(), advice: z.string(), severity: z.enum(["info", "warn"]), count: z.number(), sessions: z.number() })),
  hygiene: z.object({ score: z.number(), verdict: z.enum(["bounded", "mixed", "bloated"]) }),
  boundary: z.object({
    segments: z.array(z.object({ fromTurn: z.number(), toTurn: z.number(), label: z.string() })),
    cutTurn: z.number().nullable(),
  }).optional(),
});
export const hygieneRoute = defineRoute("GET", "/api/inspect/session/hygiene", {
  query: z.object({ id: z.string(), agent: z.enum(["claude", "codex"]) }),
  response: HygieneReportSchema,
});
export type HygieneReport = z.infer<typeof HygieneReportSchema>;

// Mirrors the server SessionSummarySchema (src/gem.controller.ts) exactly.
export const SessionSummarySchema = z.object({
  sessionId: z.string(), agent: z.string(),
  project: z.string().nullable(), model: z.string().nullable(), gitBranch: z.string().nullable(),
  startMs: z.number(), endMs: z.number(), durationMs: z.number(),
  msgs: z.number(), tokensIn: z.number(), tokensOut: z.number(), tokensCache: z.number(),
  process: z.object({ score: z.number(), label: z.enum(["disciplined", "loose", "chaotic"]),
    stages: z.object({ exploration: z.number(), implementation: z.number(), verification: z.number(), orchestration: z.number(), other: z.number() }) }).nullable(),
  findings: z.array(z.object({ id: z.string(), title: z.string(), advice: z.string(), severity: z.enum(["info", "warn"]), count: z.number(), sessions: z.number() })),
  events: z.object({ toolCalls: z.array(z.object({ name: z.string(), count: z.number() })), filesTouched: z.number(), edits: z.number(), verifications: z.number() }).nullable(),
});
export const processRoute = defineRoute("GET", "/api/inspect/session/process", {
  query: z.object({ id: z.string(), agent: z.enum(["claude", "codex"]) }),
  response: SessionSummarySchema,
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

// Recall tab: instant BM25 search over the goldmine index + the capped
// ask_session funnel run. Mirrors src/goldmine/recallRoutes.ts exactly.
export const MomentHitSchema = z.object({
  sessionId: z.string(), agent: z.string(), turn: z.number(),
  project: z.string().nullable(), branch: z.string().nullable(), startMs: z.number(),
  snippet: z.string(), score: z.number(), turnsMatched: z.number(),
});
export type MomentHit = z.infer<typeof MomentHitSchema>;
export const recallSearchRoute = defineRoute("GET", "/api/recall/search", {
  query: z.object({
    q: z.string(), project: z.string().optional(), agent: z.string().optional(),
    since: z.number().optional(), limit: z.number().optional(),
  }),
  response: z.object({ moments: z.array(MomentHitSchema) }),
});
export const recallStatusRoute = defineRoute("GET", "/api/recall/status", {
  response: z.object({
    ready: z.boolean(), indexed: z.number(), total: z.number(),
    facets: z.object({ projects: z.array(z.string()), agents: z.array(z.string()) }),
  }),
});
export const recallRunRoute = defineRoute("POST", "/api/recall/run", {
  body: z.object({
    sessionIds: z.array(z.object({ sessionId: z.string(), agent: z.string() })),
    prompt: z.string(), mode: z.enum(["chat", "extract"]),
  }),
  response: z.object({ jobId: z.string() }),
});
export const recallCancelRoute = defineRoute("DELETE", "/api/recall/{jobId}", {
  path: z.object({ jobId: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

// "Distill this session" (phase 3): runs the workflow scan + distill pipeline over
// one session, returning draft skills. Mirrors the server DistilledSkillSchema so a
// draft round-trips back to /workflow/draft unchanged.
const OccurrenceSchema = z.object({ sessionId: z.string(), transcript: z.string(), messageIndices: z.array(z.number()), atMs: z.number() });
const TriggerContractSchema = z.object({
  intent: z.string(),
  triggers: z.array(z.string()),
  antiTriggers: z.array(z.string()),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
});
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
  triggerContract: TriggerContractSchema.optional(),
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
const DisabledArtifactSchema = z.object({
  type: z.enum(["skill", "mcp", "plugin"]),
  name: z.string(),
  source: z.string(),
});
export type DisabledArtifact = z.infer<typeof DisabledArtifactSchema>;

const OptimizePayloadSchema = z.object({
  range: z.enum(["today", "7d", "30d", "all"]),
  artifacts: z.array(OptimizeArtifactSchema),
  instructions: z.array(OptimizeInstructionSchema),
  disabled: z.array(DisabledArtifactSchema),
});
export type OptimizeArtifact = z.infer<typeof OptimizeArtifactSchema>;
export type OptimizeInstruction = z.infer<typeof OptimizeInstructionSchema>;
export type OptimizePayload = z.infer<typeof OptimizePayloadSchema>;
export type OptimizeRange = OptimizePayload["range"];

export const optimizeRoute = defineRoute("GET", "/api/optimize", {
  query: z.object({ range: z.enum(["today", "7d", "30d", "all"]).optional(), refresh: z.boolean().optional() }),
  response: OptimizePayloadSchema,
});

const DisableItemSchema = z.object({
  type: z.enum(["skill", "mcp", "plugin"]),
  name: z.string(),
  source: z.string(),
});
const DisableResultSchema = z.object({
  type: z.enum(["skill", "mcp", "plugin"]),
  name: z.string(),
  ok: z.boolean(),
  message: z.string(),
});
export type DisableItem = z.infer<typeof DisableItemSchema>;
export type DisableResult = z.infer<typeof DisableResultSchema>;

export const disableArtifactsRoute = defineRoute("POST", "/api/optimize/disable", {
  body: z.object({ artifacts: z.array(DisableItemSchema) }),
  response: z.object({ results: z.array(DisableResultSchema) }),
});
// Enable returns the freshly-analyzed rows for the re-enabled artifacts so the client
// repaints them into the prune table without a Refresh (works for prior-session rows,
// which the client can't reconstruct). `range` scopes usage to the panel's view.
export const enableArtifactsRoute = defineRoute("POST", "/api/optimize/enable", {
  body: z.object({ artifacts: z.array(DisableItemSchema), range: z.enum(["today", "7d", "30d", "all"]).optional() }),
  response: z.object({ results: z.array(DisableResultSchema), artifacts: z.array(OptimizeArtifactSchema) }),
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
  response: z.object({ skills: z.array(z.string()), lessons: z.array(z.string()), root: z.string(), degraded: z.boolean(), preparing: z.boolean() }),
});
export const playbookPublishRoute = defineRoute("POST", "/api/playbook/publish", {
  body: z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), description: z.string().optional(), tags: z.array(z.string()).optional(), provenance: z.string() }),
  response: z.object({ exploreRef: z.string(), version: z.string(), shareUrl: z.string() }),
});
// Installable publish: same body as playbook/publish, but the server uploads the .gem archive so
// the shared setup is installable by others (not a browse-only teaser).
export const publishSetupRoute = defineRoute("POST", "/api/publish-setup", {
  body: z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), description: z.string().optional(), tags: z.array(z.string()).optional(), provenance: z.string() }),
  response: z.object({ exploreRef: z.string(), version: z.string(), shareUrl: z.string() }),
});
// Zero-config install of a hosted (shared) gem: the server downloads the archive from the hosted
// aggregator and materializes it. consent=true is required when the gem has executable artifacts.
export const installHostedRoute = defineRoute("POST", "/api/install-hosted", {
  body: z.object({ key: z.string(), version: z.string(), consent: z.boolean().optional() }),
  response: z.object({ workspace: z.string(), executables: z.object({ mcp: z.array(z.string()), hooks: z.array(z.string()) }) }),
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

// Per-gem effectiveness leaderboard (aggregator, k-anonymised): confidence-weighted
// success rate over judged sessions, summed across models/versions of a gem.
export const EffectivenessSchema = z.array(z.object({
  gemName: z.string(), mostly: z.number(), partially: z.number(), notAchieved: z.number(), judged: z.number(),
  producers: z.number(), verifiedProducers: z.number(), organic: z.number(), confidence: z.number(), score: z.number(),
}));
export type EffectivenessRow = z.infer<typeof EffectivenessSchema>[number];
export const effectivenessRoute = defineRoute("GET", "/api/aggregator/effectiveness", {
  query: z.object({ gemName: z.string().optional(), sort: z.enum(["producers", "score"]).optional(), minConfidence: z.coerce.number().optional() }),
  response: EffectivenessSchema,
});

// Identity binding: link the local key to a GitHub account via device-flow OAuth.
export const bindStatusRoute = defineRoute("GET", "/api/bind/status", {
  response: z.object({ bound: z.boolean(), login: z.string().optional(), provider: z.string().optional(), avatarUrl: z.string().optional(), sessionActive: z.boolean().optional() }),
});
export const bindStartRoute = defineRoute("POST", "/api/bind/start", {
  // The server requires an (empty) object body; without a body schema the client
  // would POST nothing and the server rejects it with 422 invalid_body.
  body: z.object({}),
  response: z.object({ configured: z.boolean(), userCode: z.string().optional(), verificationUri: z.string().optional(), verificationUriComplete: z.string().optional(), deviceCode: z.string().optional(), interval: z.number().optional() }),
});
export const bindCompleteRoute = defineRoute("POST", "/api/bind/complete", {
  body: z.object({ deviceCode: z.string(), interval: z.number().optional() }),
  response: z.object({ bound: z.boolean(), login: z.string().optional(), avatarUrl: z.string().optional(), rejected: z.string().optional(), sessionToken: z.string().optional(), expiresAt: z.string().optional() }),
});
// Disconnect: clear the local binding so this machine is no longer verified.
// Returns the fresh (unbound) status; reconnect via the device flow re-links.
export const bindDisconnectRoute = defineRoute("POST", "/api/bind/disconnect", {
  body: z.object({}),
  response: z.object({ bound: z.boolean(), login: z.string().optional(), provider: z.string().optional(), avatarUrl: z.string().optional() }),
});
// Desktop→web SSO: mint a handoff URL from the local session; open it to land signed in on the web.
export const webHandoffRoute = defineRoute("POST", "/api/auth/web-handoff", {
  body: z.object({}),
  response: z.object({ authenticated: z.boolean(), url: z.string().optional() }),
});

// Curated import sources (bootstrap the Gem registry from trusted external repos).
const CuratedSourceSchema = z.object({
  id: z.string(), label: z.string(), description: z.string(),
  repo: z.string(), ref: z.string(), kind: z.string(),
  license: z.string().optional(), homepage: z.string().optional(),
});
export type CuratedSource = z.infer<typeof CuratedSourceSchema>;
const SourceDivisionSchema = z.object({ key: z.string(), label: z.string(), icon: z.string().optional(), color: z.string().optional() });
export type SourceDivision = z.infer<typeof SourceDivisionSchema>;
const SourceAgentRefSchema = z.object({ division: z.string(), slug: z.string(), name: z.string(), path: z.string() });
export type SourceAgentRef = z.infer<typeof SourceAgentRefSchema>;
const SourceAgentEntrySchema = z.object({
  division: z.string(), slug: z.string(), name: z.string(), path: z.string(),
  description: z.string().optional(), vibe: z.string().optional(), color: z.string().optional(), emoji: z.string().optional(),
});
export type SourceAgentEntry = z.infer<typeof SourceAgentEntrySchema>;

export const sourcesListRoute = defineRoute("GET", "/api/sources", { response: z.object({ sources: z.array(CuratedSourceSchema) }) });
export const sourceDivisionsRoute = defineRoute("GET", "/api/sources/divisions", {
  query: z.object({ source: z.string() }), response: z.object({ divisions: z.array(SourceDivisionSchema) }),
});
export const sourceAgentsRoute = defineRoute("GET", "/api/sources/agents", {
  query: z.object({ source: z.string(), division: z.string() }), response: z.object({ agents: z.array(SourceAgentRefSchema) }),
});
export const sourceAgentRoute = defineRoute("GET", "/api/sources/agent", {
  query: z.object({ source: z.string(), path: z.string() }), response: SourceAgentEntrySchema,
});
export const sourceInstallRoute = defineRoute("POST", "/api/sources/install", {
  body: z.object({ source: z.string(), path: z.string() }),
  response: z.object({ ok: z.boolean(), skill: z.string(), dir: z.string() }),
});
// Build the skill from a persona WITHOUT writing it to disk — lets the user read the
// exact SKILL.md before committing to Install (a local-machine, trust-sensitive action).
const ImportedSkillSchema = z.object({
  type: z.string().optional(), name: z.string(), description: z.string().optional(),
  source: z.string().optional(), content: z.string(),
});
export type ImportedSkill = z.infer<typeof ImportedSkillSchema>;
export const sourceImportRoute = defineRoute("POST", "/api/sources/import", {
  body: z.object({ source: z.string(), path: z.string() }), response: ImportedSkillSchema,
});

// ---- Play (miniapps) — client mirrors of the server /api/play/* routes ----
const PlayNeedsSchema = z.array(z.enum(["session-data", "live-session-events", "local-project-access", "invoke-agent"])).optional();
const PlaySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), agent: z.string(), project: z.string().optional(), sessionId: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("skill"), skillName: z.string(), sourceId: z.string().optional() }),
  z.object({ kind: z.literal("project"), path: z.string(), flavor: z.string() }),
  z.object({ kind: z.literal("html"), title: z.string() }),
  z.object({ kind: z.literal("blank"), title: z.string() }),
]);
const PlayMetaSchema = z.object({
  title: z.string(), genre: z.enum(["replay", "skill-run", "project-fun"]),
  createdFrom: PlaySourceSchema, engineVersion: z.string().default("1"), needs: PlayNeedsSchema,
});

export const playMiniappsRoute = defineRoute("GET", "/api/play/miniapps", {
  response: z.object({ miniapps: z.array(z.object({ name: z.string(), title: z.string(), genre: z.string(), needs: PlayNeedsSchema })) }),
});
export const playMiniappRoute = defineRoute("GET", "/api/play/miniapp", {
  query: z.object({ name: z.string() }),
  response: z.object({ name: z.string(), html: z.string(), meta: z.object({ title: z.string(), genre: z.string(), createdFrom: PlaySourceSchema, engineVersion: z.string(), needs: PlayNeedsSchema }) }),
});
export const playStudioRoute = defineRoute("POST", "/api/play/studio", {
  body: z.object({ source: PlaySourceSchema }), response: z.object({ name: z.string() }),
});
export const playImportRoute = defineRoute("POST", "/api/play/import", {
  body: z.object({ title: z.string(), html: z.string() }), response: z.object({ name: z.string() }),
});
export const playBlankRoute = defineRoute("POST", "/api/play/blank", {
  body: z.object({ title: z.string(), prompt: z.string().optional() }), response: z.object({ name: z.string() }),
});
export const playSaveRoute = defineRoute("POST", "/api/play/save", {
  body: z.object({ name: z.string(), html: z.string(), meta: PlayMetaSchema }),
  response: z.object({ name: z.string(), commit: z.string().nullable() }),
});
export const playPublishRoute = defineRoute("POST", "/api/play/publish", {
  body: z.object({ remote: z.string().url().optional() }), response: z.object({ ok: z.boolean() }),
});
// Host-brokered feed: a replay miniapp's source-session transcript, fetched on demand and postMessaged
// into the sealed iframe by the Runner.
export const playSessionDataRoute = defineRoute("GET", "/api/play/session-data", {
  query: z.object({ name: z.string(), sessionId: z.string().optional(), agent: z.string().optional() }),
  response: z.object({ meta: z.record(z.string(), z.unknown()), timeline: z.array(z.object({ role: z.string(), tsMs: z.number(), text: z.string() })) }),
});

export const makeClient = (apiBase: string): Client => createClient({ baseURL: apiBase });
