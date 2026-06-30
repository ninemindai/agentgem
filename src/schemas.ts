// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/schemas.ts
import { z } from "zod";
import { RUNNER_REGISTRY } from "@agentgem/build";
import { TARGET_REGISTRY } from "@agentgem/model";
import { deployTargetIds } from "@agentgem/deploy";
import { flavorIds } from "@agentgem/testbed";
import { CREDENTIAL_KEYS } from "@agentgem/capture";

export const SkillArtifactSchema = z.object({
  type: z.literal("skill"),
  name: z.string(),
  description: z.string().optional(),
  source: z.string(),
  content: z.string(),
});

export const McpServerArtifactSchema = z.object({
  type: z.literal("mcp_server"),
  name: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  config: z.record(z.string(), z.unknown()),
  source: z.string().optional(),
  secretRefs: z.array(z.object({ name: z.string(), location: z.string() })).optional(),
});

export const InstructionsArtifactSchema = z.object({
  type: z.literal("instructions"),
  name: z.string(),
  content: z.string(),
});

export const HookArtifactSchema = z.object({
  type: z.literal("hook"),
  name: z.string(),
  event: z.string(),
  matcher: z.string().optional(),
  config: z.record(z.string(), z.unknown()),
  source: z.string().optional(),
  secretRefs: z.array(z.object({ name: z.string(), location: z.string() })).optional(),
});

export const ChannelPlatformSchema = z.enum(["slack", "telegram", "discord", "teams", "twilio", "github"]);

export const ChannelArtifactSchema = z.object({
  type: z.literal("channel"),
  name: z.string(),
  platform: ChannelPlatformSchema,
  secretRefs: z.array(z.object({ name: z.string(), location: z.string() })),
  description: z.string().optional(),
});

// Declared channels on a request body. Shared by every endpoint that builds a Gem from a selection
// (gem preview, materialize, archive, create-workspace, publish) so channels are never dropped on one
// path while present on another. Each platform entry becomes a channel artifact via buildGem.
export const ChannelDeclSchema = z.array(z.object({ platform: ChannelPlatformSchema, name: z.string().optional() })).optional();

export const GemArtifactSchema = z.discriminatedUnion("type", [
  SkillArtifactSchema,
  McpServerArtifactSchema,
  InstructionsArtifactSchema,
  HookArtifactSchema,
  ChannelArtifactSchema,
]);

export const SecretRequirementSchema = z.object({
  name: z.string(),
  artifact: z.string(),
  location: z.string(),
});

export const EvalAssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file_exists"), path: z.string() }),
  z.object({ type: z.literal("file_contains"), path: z.string(), substring: z.string() }),
  z.object({ type: z.literal("command_succeeds"), command: z.string() }),
  z.object({ type: z.literal("output_contains"), substring: z.string() }),
  z.object({ type: z.literal("tool_called"), tool: z.string() }),
]);

export const BehavioralCheckSchema = z.object({
  kind: z.literal("behavioral"),
  name: z.string(),
  description: z.string().optional(),
  task: z.string(),
  setup: z.object({ files: z.array(z.object({ path: z.string(), content: z.string() })).optional() }).optional(),
  assertions: z.array(EvalAssertionSchema),
  judge: z.object({ rubric: z.string(), passThreshold: z.number().min(0).max(1).optional() }).optional(),
  timeoutSec: z.number().optional(),
});

// runner validates against the registry keys, so a gem can't declare a check no runner can run.
const RUNNER_IDS = Object.keys(RUNNER_REGISTRY) as [string, ...string[]];
export const ExternalCheckSchema = z.object({
  kind: z.literal("external"),
  name: z.string(),
  description: z.string().optional(),
  runner: z.enum(RUNNER_IDS),
  with: z.record(z.string(), z.unknown()).optional(),
});

export const GemCheckSchema = z.discriminatedUnion("kind", [BehavioralCheckSchema, ExternalCheckSchema]);

export const ProjectInventorySchema = z.object({
  root: z.string(),
  name: z.string(),
  skills: z.array(SkillArtifactSchema),
  mcpServers: z.array(McpServerArtifactSchema),
  instructions: z.array(InstructionsArtifactSchema),
  hooks: z.array(HookArtifactSchema),
});

export const InventorySchema = z.object({
  skills: z.array(SkillArtifactSchema),
  mcpServers: z.array(McpServerArtifactSchema),
  instructions: z.array(InstructionsArtifactSchema),
  hooks: z.array(HookArtifactSchema),
  projects: z.array(ProjectInventorySchema).optional(),
});

export const UsageItemSchema = z.object({
  type: z.string(),
  name: z.string(),
  root: z.string().nullable(),
  invocations: z.number(),
  sessionsUsedIn: z.number(),
  lastUsedMs: z.number().nullable(),
});
export const UsageSchema = z.object({ artifacts: z.array(UsageItemSchema) });

// Per-project selection is keyed by the project's root path so a same-named artifact in
// two projects never collides.
const ProjectSelectionSchema = z.record(
  z.string(),
  z.object({
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    includeInstructions: z.boolean().optional(),
    hooks: z.array(z.string()).optional(),
  }),
);

export const GemSelectionSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    includeInstructions: z.boolean().optional(),
    hooks: z.array(z.string()).optional(),
    projects: ProjectSelectionSchema.optional(),
  }),
]);

// Coordinates-only source location for a distilled skill (privacy boundary).
const OccurrenceSchema = z.object({
  sessionId: z.string(),
  transcript: z.string(),
  messageIndices: z.array(z.number()),
  atMs: z.number(),
});
const ProvenanceSchema = z.object({ occurrences: z.array(OccurrenceSchema) });

// A draft skill distilled from the builtin procedure (proposal §2). status is
// always "draft" — never installed by this pipeline. Defined before the build
// request schemas that reference it (module load order).
export const DistilledSkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  triggers: z.array(z.string()),
  tools: z.array(z.string()),
  mutating: z.boolean(),
  body: z.string(),
  evidence: z.object({
    sessions: z.number(),
    exampleSequence: z.array(z.string()),
    root: z.string(),
    provenance: ProvenanceSchema,
  }),
  status: z.literal("draft"),
  confidence: z.enum(["high", "medium", "low"]),
  origin: z.enum(["llm", "heuristic"]),
});

export const ReflectionSchema = z.object({
  kind: z.enum(["unresolved-task", "recurring-pattern", "recurring-decision"]),
  detail: z.string(),
  importance: z.enum(["high", "medium"]),
  provenance: ProvenanceSchema,
});

export const DistilledLessonSchema = z.object({
  name: z.string(),
  body: z.string(),
  importance: z.enum(["high", "medium"]),
  status: z.literal("draft"),
  evidence: z.object({
    sessions: z.number(),
    root: z.string(),
    provenance: ProvenanceSchema,
  }),
});

export const GemRequestSchema = z.object({
  selection: GemSelectionSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  checks: z.array(GemCheckSchema).optional(),
  channels: ChannelDeclSchema,
  // Accepted distilled drafts to fold into the build — staged into the inventory
  // (by evidence.root) before resolution, so a selection can reference one by name.
  distilledDrafts: z.array(DistilledSkillSchema).optional(),
  distilledLessons: z.array(DistilledLessonSchema).optional(),
});

export const ScaffoldChecksRequestSchema = z.object({
  selection: GemSelectionSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  distilledDrafts: z.array(DistilledSkillSchema).optional(),
  distilledLessons: z.array(DistilledLessonSchema).optional(),
});

export const ScaffoldChecksResponseSchema = z.object({ checks: z.array(GemCheckSchema) });

const TARGET_IDS = Object.keys(TARGET_REGISTRY) as [string, ...string[]];
export const TargetIdSchema = z.enum(TARGET_IDS);

export const SkippedArtifactSchema = z.object({
  artifact: z.string(),
  type: z.enum(["skill", "mcp_server", "instructions", "hook", "channel"]),
  reason: z.string(),
});

export const MaterializeResponseSchema = z.object({
  target: TargetIdSchema,
  files: z.record(z.string(), z.string()),
  skipped: z.array(SkippedArtifactSchema),
  compatibility: z.record(TargetIdSchema, z.object({ supported: z.number(), skipped: z.number() })),
});

// ── Gem archive ──
export const GemLockSchema = z.object({
  formatVersion: z.number(),
  files: z.record(z.string(), z.string()),
  gemDigest: z.string(),
  signature: z.string().nullable(),
});

export const GemManifestArtifactSchema = z.object({
  type: z.enum(["skill", "mcp_server", "instructions", "hook", "channel"]),
  name: z.string(),
  path: z.string(),
  description: z.string().optional(),
  source: z.string().optional(),
});

export const GemManifestSchema = z.object({
  formatVersion: z.number(),
  name: z.string(),
  version: z.string(),
  createdFrom: z.string(),
  artifacts: z.array(GemManifestArtifactSchema),
  requiredSecrets: z.array(SecretRequirementSchema),
  checks: z.array(z.object({ name: z.string(), path: z.string() })),
});

export const ArchiveRequestSchema = z.object({
  selection: GemSelectionSchema,
  name: z.string().optional(),
  version: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  outDir: z.string().optional(), // when set, write the tree here and return its path
  outFile: z.string().optional(), // when set, write one portable .gem (tar.gz) here
  tar: z.boolean().optional(),   // when true, also return the tree as a base64 .tar.gz
  channels: ChannelDeclSchema,
});

export const ArchiveResponseSchema = z.object({
  files: z.record(z.string(), z.string()),
  lock: GemLockSchema,
  skipped: z.array(SkippedArtifactSchema),
  path: z.string().nullable(),
  gemFile: z.string().nullable(), // path to the written .gem when `outFile` was set, else null
  tarGz: z.string().nullable(), // base64 .tar.gz when `tar` was requested, else null
});

export const MaterializeRequestSchema = z.object({
  selection: GemSelectionSchema.optional(),
  archivePath: z.string().optional(),
  gemPath: z.string().optional(), // install from a single .gem (tar.gz) file on disk
  gemUrl: z.string().optional(),  // install from a .gem fetched over http(s)
  bytesBase64: z.string().optional(), // install from in-memory .gem bytes (e.g. a redeemed transfer ticket)
  target: TargetIdSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  a2aServer: z.boolean().optional(), // a2a target: also emit the runnable server, not just the Agent Card
  channels: ChannelDeclSchema, // applied only when building from `selection` (ignored for archive/gem sources)
}).refine((d) => d.selection !== undefined || d.archivePath !== undefined || d.gemPath !== undefined || d.gemUrl !== undefined || d.bytesBase64 !== undefined, {
  message: "provide one of selection, archivePath, gemPath, gemUrl, or bytesBase64",
});

export const DeployTargetIdSchema = z.enum(deployTargetIds);
export const DeployReadyQuerySchema = z.object({ target: DeployTargetIdSchema.optional() });
export const DeployTargetsResponseSchema = z.object({
  targets: z.array(z.object({ id: DeployTargetIdSchema, label: z.string(), ready: z.boolean() })),
});

// ── Managed Agents publish ──
export const PublishPreviewRequestSchema = z.object({
  selection: GemSelectionSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  target: DeployTargetIdSchema.optional(),
  channels: ChannelDeclSchema,
});
export const PublishRequestSchema = PublishPreviewRequestSchema.extend({ requestId: z.string().min(8).max(128), wsName: z.string().optional() });

const ManagedAgentPayloadSchema = z.object({
  name: z.string(),
  model: z.string(),
  system: z.string(),
  mcp_servers: z.array(z.object({ type: z.literal("url"), name: z.string(), url: z.string() })),
  tools: z.array(z.union([
    z.object({ type: z.literal("agent_toolset_20260401") }),
    z.object({ type: z.literal("mcp_toolset"), mcp_server_name: z.string() }),
  ])),
});

const ManagedAgentPreviewSchema = z.object({
  kind: z.literal("managed-agent"),
  payload: ManagedAgentPayloadSchema,
  skillsToRegister: z.array(z.string()),
  skipped: z.array(SkippedArtifactSchema),
  vaultSecrets: z.array(SecretRequirementSchema),
});
const AgentcorePreviewSchema = z.object({
  kind: z.literal("agentcore-harness"),
  request: z.record(z.string(), z.unknown()),
  skipped: z.array(SkippedArtifactSchema),
  vaultSecrets: z.array(SecretRequirementSchema),
});
export const PublishPreviewResponseSchema = z.discriminatedUnion("kind", [ManagedAgentPreviewSchema, AgentcorePreviewSchema]);

export const PublishReadyResponseSchema = z.object({ ready: z.boolean() });

const ManagedAgentResultSchema = z.object({
  kind: z.literal("managed-agent"),
  agentId: z.string(), environmentId: z.string(), version: z.string(),
  registeredSkills: z.array(z.object({ name: z.string(), skillId: z.string(), version: z.string() })),
  skipped: z.array(SkippedArtifactSchema), vaultSecrets: z.array(SecretRequirementSchema),
});
const AgentcoreResultSchema = z.object({
  kind: z.literal("agentcore-harness"),
  harnessArn: z.string(), harnessId: z.string(), harnessName: z.string(), harnessVersion: z.string(), status: z.string(),
  skipped: z.array(SkippedArtifactSchema), vaultSecrets: z.array(SecretRequirementSchema),
});
export const PublishResultSchema = z.discriminatedUnion("kind", [ManagedAgentResultSchema, AgentcoreResultSchema]);

// `projects` is a JSON-encoded string array of root paths (query params can't carry arrays cleanly).
export const DirQuerySchema = z.object({ dir: z.string().optional(), projects: z.string().optional() });
export const UsageQuerySchema = z.object({
  dir: z.string().optional(),
  projects: z.string().optional(),
  scope: z.enum(["global"]).optional(),
});

export const PickQuerySchema = z.object({});
export const PickFolderSchema = z.object({ path: z.string().nullable() });

// ── Workflow-aware Gem recommendation ──
export const WorkflowAnalyzeRequestSchema = z.object({
  dir: z.string().optional(),   // .claude dir (resolveDirs handles the default)
  root: z.string(),             // the project root to analyze (one of the discovered cwds)
});
const RecommendedItemSchema = z.object({
  // mirrors ArtifactType (incl. "channel") — RecommendedItem.type is ArtifactType, so this must stay in sync
  type: z.enum(["skill", "mcp_server", "instructions", "hook", "channel"]),
  name: z.string(),
  reason: z.string(),
  root: z.string().nullable(),   // project root, or null for a global/plugin artifact
});
// One candidate Gem, carrying its own ready-to-POST GemSelection.
const GemCandidateSchema = z.object({
  name: z.string(),
  description: z.string(),
  root: z.string(),
  includeInstructions: z.boolean(),
  include: z.array(RecommendedItemSchema),
  confidence: z.enum(["high", "medium", "low"]),
  selection: z.record(z.string(), z.unknown()), // a GemSelection; buildGem validates structurally at /api/gem
});
export const WorkflowAnalyzeResponseSchema = z.object({
  candidates: z.array(GemCandidateSchema),
  gaps: z.array(z.string()),                     // project-level: used but absent from inventory
  distilled: z.array(DistilledSkillSchema),      // draft skills distilled from the builtin procedure
  reflections: z.array(ReflectionSchema),
  signalSummary: z.object({
    sessionsScanned: z.number(),
    spanDays: z.number(),
    notes: z.array(z.string()),
  }),
  degraded: z.boolean(),
});

// Accept a distilled draft → write it to .agentgem/distilled/<name>/SKILL.md.
export const WorkflowDraftWriteResponseSchema = z.object({ path: z.string() });

export const GemSchema = z.object({
  name: z.string(),
  createdFrom: z.string(),
  artifacts: z.array(GemArtifactSchema),
  checks: z.array(GemCheckSchema),
  requiredSecrets: z.array(SecretRequirementSchema),
});

// --- Transfer (store-and-forward ticket sharing) ---
// readGemMeta's shape: identity + integrity digest of a received gem.
export const GemMetaSchema = z.object({
  name: z.string(),
  version: z.string(),
  dependencies: z.array(z.string()),
  gemDigest: z.string(),
});

export const TransferSendRequestSchema = z.object({
  selection: GemSelectionSchema,
  name: z.string().optional(),
  version: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  channels: ChannelDeclSchema,
  distilledDrafts: z.array(DistilledSkillSchema).optional(),
  distilledLessons: z.array(DistilledLessonSchema).optional(),
});
export const TransferSendResponseSchema = z.object({ ticket: z.string() });

export const TransferReceiveRequestSchema = z.object({ ticket: z.string() });
export const TransferReceiveResponseSchema = z.object({
  gem: GemSchema,
  meta: GemMetaSchema,
  bytesBase64: z.string(), // the verified .gem bytes, for materializing via /materialize
});

// Ephemeral, subject-scoped NATS creds for an untrusted client (the browser web-receiver).
export const TransferTokenRequestSchema = z.object({ scope: z.literal("receive").optional() });
export const TransferTokenResponseSchema = z.object({
  creds: z.string(),
  wsUrl: z.string(),
  expiresAt: z.number(), // unix seconds
});

// Web-receiver: the browser asks for ciphertext only (key withheld) and decrypts locally.
export const TransferCiphertextRequestSchema = z.object({ object: z.string() });
export const TransferCiphertextResponseSchema = z.object({ ciphertextBase64: z.string() });

// ── Workspaces ──
export const WorkspaceSummarySchema = z.object({
  name: z.string(),
  gemName: z.string(),
  version: z.string(),
  artifactCounts: z.object({ skill: z.number(), mcp_server: z.number(), instructions: z.number(), hook: z.number() }),
  artifacts: z.array(z.object({ type: z.string(), name: z.string() })),
  modifiedMs: z.number(),
  checks: z.number(),
  renderedTargets: z.array(TargetIdSchema),
});
export const WorkspaceDetailSchema = WorkspaceSummarySchema.extend({
  files: z.record(z.string(), z.string()),
  compatibility: z.record(TargetIdSchema, z.object({ supported: z.number(), skipped: z.number() })),
});
export const RenderResultSchema = z.object({
  target: TargetIdSchema,
  files: z.record(z.string(), z.string()),
  skipped: z.array(SkippedArtifactSchema),
  path: z.string(),
});
export const CreateWorkspaceRequestSchema = z.object({
  name: z.string(),
  selection: GemSelectionSchema,
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  version: z.string().optional(),
  channels: ChannelDeclSchema,
});
export const WorkspaceQuerySchema = z.object({ name: z.string() });
export const RenderRequestSchema = z.object({ name: z.string(), target: TargetIdSchema, a2aServer: z.boolean().optional() });
export const WorkspaceNameRequestSchema = z.object({ name: z.string() });
export const ListWorkspacesResponseSchema = z.object({ workspaces: z.array(WorkspaceSummarySchema) });
export const DeleteWorkspaceResponseSchema = z.object({ deleted: z.string() });

export const RunReadyQuerySchema = z.object({ name: z.string(), target: TargetIdSchema });
export const RunReadyResponseSchema = z.object({ local: z.boolean(), vercel: z.boolean(), cloudflare: z.boolean() });
export const RunRequestSchema = z.object({ name: z.string(), target: TargetIdSchema, mode: z.enum(["local", "vercel", "cloudflare"]), eveAuth: z.enum(["placeholder", "public"]).optional() });
export const RunStatusQuerySchema = z.object({ name: z.string(), target: TargetIdSchema });
export const RunStateSchema = z.object({
  mode: z.enum(["local", "vercel", "cloudflare"]),
  state: z.enum(["idle", "installing", "building", "running", "deploying", "failed"]),
  url: z.string().optional(),
  logTail: z.array(z.string()),
});
export const RunStopRequestSchema = z.object({ name: z.string(), target: TargetIdSchema });
export const RunStopResponseSchema = z.object({ stopped: z.boolean() });

// Set a server-side credential (allowlisted keys only). Response is just ok — the UI re-fetches
// the relevant backend readiness (run-ready / publish-ready) on re-render.
export const CredentialRequestSchema = z.object({ key: z.enum(CREDENTIAL_KEYS), value: z.string().min(1) });
export const CredentialResponseSchema = z.object({ ok: z.boolean() });

// ── Testbed (testbed-first on-ramp) ──
const FLAVOR_IDS = flavorIds() as [string, ...string[]];
export const TestbedFlavorIdSchema = z.enum(FLAVOR_IDS);
export const TestbedDetectQuerySchema = z.object({ root: z.string() });
export const TestbedDetectResponseSchema = z.object({ flavor: TestbedFlavorIdSchema.nullable() });

// cwd probe for the front door. `cwd` overrides process.cwd() (tests); production omits it.
export const TestbedSuggestionQuerySchema = z.object({ cwd: z.string().optional() });
export const TestbedSuggestionResponseSchema = z.object({
  cwd: z.string(),
  looksLikeProject: z.boolean(),
  flavor: TestbedFlavorIdSchema.nullable(),
  name: z.string(),
});

// Persisted "testbeds opened in agentgem". `exists` is computed per-request (stale paths).
export const RecentEntrySchema = z.object({
  path: z.string(),
  flavor: TestbedFlavorIdSchema,
  name: z.string(),
  lastUsed: z.string(),
  exists: z.boolean(),
});
export const TestbedRecentsResponseSchema = z.object({ recents: z.array(RecentEntrySchema) });

// Cross-repo discovery: projects harvested from Claude/Codex session history (ungated).
// `dir` overrides the ~/.claude base (tests / non-default homes); production omits it.
export const TestbedProjectsQuerySchema = z.object({ dir: z.string().optional() });
export const ProjectCandidateSchema = z.object({
  path: z.string(),
  flavor: TestbedFlavorIdSchema,
  lastUsed: z.string().nullable(),
  exists: z.boolean(),
});
export const TestbedProjectsResponseSchema = z.object({ projects: z.array(ProjectCandidateSchema) });

export const TestbedImportSelectionSchema = z.object({
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  hooks: z.array(z.string()).optional(),
  includeInstructions: z.boolean().optional(),
});
export const TestbedScaffoldRequestSchema = z.object({ root: z.string(), name: z.string(), flavor: TestbedFlavorIdSchema.optional() });
export const TestbedScaffoldResponseSchema = z.object({ root: z.string(), created: z.array(z.string()) });
export const TestbedImportRequestSchema = z.object({
  root: z.string(),
  selection: TestbedImportSelectionSchema,
  dir: z.string().optional(),
  flavor: TestbedFlavorIdSchema.optional(),
});
export const ImportedRefSchema = z.object({
  // mirrors ArtifactType (incl. "channel") — ImportedRef.type is ArtifactType, so this must stay in sync
  type: z.enum(["skill", "mcp_server", "instructions", "hook", "channel"]),
  name: z.string(),
  overwritten: z.boolean(),
});
export const TestbedImportResponseSchema = z.object({
  written: z.array(ImportedRefSchema),
  skipped: z.array(z.object({ artifact: z.string(), reason: z.string() })),
});

// Apply a received .gem (in-memory archive bytes) into a user-picked testbed dir.
// `dir` is an explicit, trusted folder selection (same trust model as testbed import);
// the gem is unpacked + lock-verified before anything is written.
export const GemApplyRequestSchema = z.object({
  bytesBase64: z.string(),
  dir: z.string(),
  flavor: TestbedFlavorIdSchema.optional(),
});
export const GemApplyResponseSchema = z.object({
  dir: z.string(),
  name: z.string(),
  written: z.array(ImportedRefSchema),
  skipped: z.array(z.object({ artifact: z.string(), reason: z.string() })),
});

// ── Run a Gem with a local ACP coding agent ──
export const ToolInvocationSchema = z.object({
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  status: z.string().optional(),
});
export const RunResultSchema = z.object({
  text: z.string(),
  toolCalls: z.array(ToolInvocationSchema),
});
export const GemRunOutcomeSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  result: RunResultSchema,
  sandbox: z.object({ backend: z.string(), isolated: z.boolean() }),
});
export const GemExpectationsSchema = z.object({
  expectTools: z.array(z.string()).optional(),
  expectText: z.string().optional(),
  forbidToolFailures: z.boolean().optional(),
});
export const VerificationReportSchema = z.object({
  passed: z.boolean(),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })),
});
export const GemRunRequestSchema = z.object({
  // The Gem: either a built selection (like /materialize) or a .gem archive dir.
  selection: GemSelectionSchema.optional(),
  archivePath: z.string().optional(),
  name: z.string().optional(),
  dir: z.string().optional(),                              // introspect home (selection mode), like /materialize
  projects: z.array(z.string()).optional(),
  task: z.string(),
  // runDir is intentionally NOT accepted from the client: a caller-controlled path is a path-injection
  // sink (and the agent runs there with tool permissions). The server always derives it under
  // AGENTGEM_HOME from the gem name. See gem.controller runGem/prepareGemRun.
  agent: z.enum(["claude", "codex"]).optional(),           // which local ACP adapter to drive
  expectations: GemExpectationsSchema.optional(),
}).refine((d) => d.selection !== undefined || d.archivePath !== undefined, {
  message: "provide either selection or archivePath",
});
export const GemRunResponseSchema = z.object({
  dir: z.string(),
  agent: z.string(),
  materialized: TestbedImportResponseSchema,
  run: GemRunOutcomeSchema,
  verification: VerificationReportSchema.optional(),
});

// Streaming split: prepare (POST, carries the selection) materializes and hands
// back an opaque runId; the GET stream then runs it with simple query params.
export const GemRunPrepareRequestSchema = z.object({
  selection: GemSelectionSchema.optional(),
  archivePath: z.string().optional(),
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  // runDir is intentionally NOT accepted from the client (see GemRunRequestSchema). Server-derived only.
  agent: z.enum(["claude", "codex"]).optional(),
}).refine((d) => d.selection !== undefined || d.archivePath !== undefined, {
  message: "provide either selection or archivePath",
});
export const GemRunPrepareResponseSchema = z.object({
  runId: z.string(),
  runDir: z.string(),
  agent: z.string(),
  materialized: TestbedImportResponseSchema,
});

// ── AgentCore deploy (Phase 2) ──
export const AgentcoreReadyResponseSchema = z.object({ cli: z.boolean(), awsCreds: z.boolean() });
export const AgentcoreDeployRequestSchema = z.object({ name: z.string() });
export const AgentcoreStatusQuerySchema = z.object({ name: z.string() });
export const AgentcoreDeployStateSchema = z.object({
  state: z.enum(["idle", "installing", "building", "running", "deploying", "failed"]),
  url: z.string().optional(),
  logTail: z.array(z.string()),
});

// ── Gem Registry ──
export const RegistryReadyResponseSchema = z.object({ ready: z.boolean() });

const RegistryItemVersionSchema = z.object({ path: z.string(), gemDigest: z.string(), dependencies: z.array(z.string()) });
const RegistryItemDiscoverySchema = z.object({
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  author: z.string().optional(),
  artifactKinds: z.array(z.string()).optional(),
  updatedAt: z.string().optional(),
});
export const RegistryIndexResponseSchema = z.object({
  formatVersion: z.number(),
  items: z.record(z.string(), z.object({ latest: z.string(), versions: z.record(z.string(), RegistryItemVersionSchema), discovery: RegistryItemDiscoverySchema.optional() })),
});

export const RegistrySearchQuerySchema = z.object({
  q: z.string().optional(),
  kind: z.string().optional(),
  tag: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
export const RegistryGemSchema = z.object({
  key: z.string(),
  version: z.string(),
  author: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  artifactKinds: z.array(z.string()).optional(),
});
export const RegistryGemsResponseSchema = z.object({ gems: z.array(RegistryGemSchema) });

export const RegistrySearchResponseSchema = z.object({
  results: z.array(z.object({
    key: z.string(), latest: z.string(), score: z.number(),
    description: z.string().optional(), tags: z.array(z.string()).optional(),
    author: z.string().optional(), artifactKinds: z.array(z.string()).optional(), updatedAt: z.string().optional(),
  })),
});

export const RegistryResolveRequestSchema = z.object({
  refs: z.array(z.string()).min(1),
  mode: z.enum(["materialize", "workspace"]),
  target: TargetIdSchema.optional(),
  a2aServer: z.boolean().optional(),
});
const InstallPlanSchema = z.object({
  items: z.array(z.object({ key: z.string(), version: z.string() })),
  totalArtifacts: z.number(),
  requiredSecrets: z.array(z.object({ name: z.string(), artifact: z.string(), location: z.string() })),
  overrides: z.array(z.object({ artifact: z.string(), winner: z.string(), loser: z.string() })),
  materialize: z.object({
    files: z.record(z.string(), z.string()),
    skipped: z.array(z.object({ artifact: z.string(), type: z.string(), reason: z.string() })),
  }).optional(),
});
export const RegistryResolveResponseSchema = z.object({ plan: InstallPlanSchema });

export const RegistryInstallRequestSchema = z.object({
  refs: z.array(z.string()).min(1),
  mode: z.enum(["materialize", "workspace"]),
  target: TargetIdSchema.optional(),
  dest: z.string().optional(),
  workspaceName: z.string().optional(),
  a2aServer: z.boolean().optional(),
});
export const RegistryInstallResponseSchema = z.object({
  plan: InstallPlanSchema,
  applied: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("materialize"), dest: z.string(), written: z.array(z.string()) }),
    z.object({ mode: z.literal("workspace"), workspace: z.string() }),
  ]),
});

export const RegistryPublishRequestSchema = z.object({
  workspace: z.string(),
  scope: z.string(),
  name: z.string().optional(),
  version: z.string(),
  dependencies: z.array(z.string()).optional(),
  description: z.string().optional(), // discovery metadata for search
  tags: z.array(z.string()).optional(),
  type: z.string().optional(),
});
export const RegistryPublishResponseSchema = z.object({
  ref: z.string(), version: z.string(), gemDigest: z.string(), commit: z.string(), path: z.string(),
});

export const UndeployRequestSchema = z.object({ name: z.string(), target: z.enum(["eve", "flue", "claude-managed", "agentcore"]) });
export const UndeployResponseSchema = z.object({ removed: z.boolean(), logTail: z.array(z.string()).optional() });
export const DeployRecordQuerySchema = z.object({ name: z.string(), backend: z.enum(["eve", "flue", "claude-managed", "agentcore"]) });
export const DeployRecordResponseSchema = z.object({ record: z.record(z.string(), z.unknown()).nullable() });
