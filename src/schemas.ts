// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/schemas.ts
import { z } from "zod";
import { RUNNER_REGISTRY } from "@agentgem/build";
import { TARGET_REGISTRY } from "@agentgem/model";
import { deployTargetIds } from "@agentgem/deploy";
import { flavorIds } from "@agentgem/testbed";
import { CREDENTIAL_KEYS } from "@agentgem/capture";

export const TriggerContractSchema = z.object({
  intent: z.string(),
  triggers: z.array(z.string()),
  antiTriggers: z.array(z.string()),
  inputs: z.array(z.string()).optional(),
  outputs: z.array(z.string()).optional(),
});

export const SkillArtifactSchema = z.object({
  type: z.literal("skill"),
  name: z.string(),
  description: z.string().optional(),
  source: z.string(),
  content: z.string(),
  trigger: TriggerContractSchema.optional(),
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

export const SubagentArtifactSchema = z.object({
  type: z.literal("subagent"),
  name: z.string(),
  description: z.string().optional(),
  source: z.string(),
  content: z.string(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
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

export const ArtifactRefSchema = z.object({
  kind: z.enum(["package", "gem"]),
  id: z.string(),
  digest: z.string().optional(),
});

export const ReferenceArtifactSchema = z.object({
  type: z.literal("reference"),
  name: z.string(),
  refKind: z.enum(["skill", "mcp_server", "instructions", "hook", "channel", "subagent", "game"]),
  ref: ArtifactRefSchema,
});

export const GameArtifactSchema = z.object({
  type: z.literal("game"),
  name: z.string(),
  title: z.string(),
  genre: z.enum(["replay", "skill-run", "project-fun"]),
  html: z.string(),
  poster: z.string().optional(),
  createdFrom: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("session"), agent: z.string(), project: z.string().optional(), sessionId: z.string(), summary: z.string() }),
    z.object({ kind: z.literal("skill"), skillName: z.string(), sourceId: z.string().optional() }),
    z.object({ kind: z.literal("project"), path: z.string(), flavor: z.string() }),
    z.object({ kind: z.literal("html"), title: z.string() }),
    z.object({ kind: z.literal("blank"), title: z.string() }),
  ]),
  engineVersion: z.string(),
  needs: z.array(z.enum(["session-data", "live-session-events", "local-project-access", "invoke-agent"])).optional(),
  meta: z.object({ controls: z.string().optional(), estPlaySeconds: z.number().optional() }).optional(),
});

export const GemArtifactSchema = z.discriminatedUnion("type", [
  SkillArtifactSchema,
  McpServerArtifactSchema,
  InstructionsArtifactSchema,
  HookArtifactSchema,
  ChannelArtifactSchema,
  SubagentArtifactSchema,
  GameArtifactSchema,
  ReferenceArtifactSchema,
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
  subagents: z.array(SubagentArtifactSchema),
});

export const InventorySchema = z.object({
  skills: z.array(SkillArtifactSchema),
  mcpServers: z.array(McpServerArtifactSchema),
  instructions: z.array(InstructionsArtifactSchema),
  hooks: z.array(HookArtifactSchema),
  subagents: z.array(SubagentArtifactSchema),
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
    instructions: z.array(z.string()).optional(),
    hooks: z.array(z.string()).optional(),
    subagents: z.array(z.string()).optional(),
  }),
);

export const GemSelectionSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    includeInstructions: z.boolean().optional(),
    instructions: z.array(z.string()).optional(),
    hooks: z.array(z.string()).optional(),
    subagents: z.array(z.string()).optional(),
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
  triggerContract: TriggerContractSchema.optional(),
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
  type: z.enum(["skill", "mcp_server", "instructions", "hook", "channel", "subagent", "reference", "game"]),
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
  type: z.enum(["skill", "mcp_server", "instructions", "hook", "channel", "subagent"]),
  name: z.string(),
  path: z.string(),
  description: z.string().optional(),
  source: z.string().optional(),
  tools: z.array(z.string()).optional(),
  model: z.string().optional(),
});

// Mirrors GemContract (packages/model/src/types.ts). Like the loop facet, a contract is an
// archived, shareable facet — it must survive the Zod schemas below (which strip unknown keys)
// so it isn't lost when a gem is transferred or returned from /scorecard/build.
export const GemContractSchema = z.object({
  task: z.string(),
  expect: z.object({
    tools: z.array(z.string()).optional(),
    text: z.string().optional(),
    forbidToolFailures: z.boolean().optional(),
  }),
});

// Mirrors LoopSpec (packages/model/src/loop.ts). Present so publish/install boundaries that
// re-validate a manifest through Zod (which strips unknown keys by default) preserve the loop
// facet instead of silently dropping it.
//
// Tolerant read gate — same contract as sanitizeLoop (packages/archive/src/archive.ts) and the
// deliberate resolution of issue #243 finding B: a wrong-shaped optional sub-field is dropped
// (`.catch(undefined)`) and the valid core kept, rather than hard-rejecting the enclosing gem.
// The required core (`mode`, `guardrails.approval`) stays strict; when it is malformed the whole
// loop is dropped at the usage site (`.optional().catch(undefined)`), matching sanitizeLoop's
// "return undefined" — never rejecting the gem. Runtime-only invariants (mode↔goal/schedule,
// non-negative budgets — issue #243 finding C) are NOT enforced here; the future executor owns
// those. See LoopSpec's comment in packages/model/src/loop.ts.
export const LoopSpecSchema = z.object({
  mode: z.enum(["loop", "goal"]),
  schedule: z.object({
    kind: z.enum(["interval", "watch", "cron"]),
    everyMs: z.number().optional().catch(undefined),
    globs: z.array(z.string()).optional().catch(undefined),
    cron: z.string().optional().catch(undefined),
  }).optional().catch(undefined),
  goal: z.object({
    until: z.string(),
    check: z.enum(["llm", "regex"]),
    pattern: z.string().optional().catch(undefined),
  }).optional().catch(undefined),
  guardrails: z.object({
    approval: z.enum(["auto", "gate"]),
    maxRounds: z.number().optional().catch(undefined),
    maxSpendUsd: z.number().optional().catch(undefined),
    maxTokens: z.number().optional().catch(undefined),
    modelLadder: z.array(z.string()).optional().catch(undefined),
  }),
  params: z.record(z.string(), z.string()).optional().catch(undefined),
});

export const GemManifestSchema = z.object({
  formatVersion: z.number(),
  name: z.string(),
  version: z.string(),
  createdFrom: z.string(),
  artifacts: z.array(GemManifestArtifactSchema),
  requiredSecrets: z.array(SecretRequirementSchema),
  checks: z.array(z.object({ name: z.string(), path: z.string() })),
  contract: GemContractSchema.optional(),
  // .catch(undefined): an unreparable loop (malformed required core) is treated as no loop, so it
  // never rejects the gem — mirrors sanitizeLoop's read gate (issue #243 finding B).
  loop: LoopSpecSchema.optional().catch(undefined),
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

// ── Playbook prepare ──
export const PlaybookPrepareBodySchema = z.object({ root: z.string() });
export const PlaybookPrepareResponseSchema = z.object({ skills: z.array(z.string()), lessons: z.array(z.string()), root: z.string(), degraded: z.boolean(), preparing: z.boolean() });

// ── Playbook publish ──
export const PlaybookPublishBodySchema = z.object({
  workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(),
  description: z.string().optional(), tags: z.array(z.string()).optional(), provenance: z.string(),
});
export const PlaybookPublishResponseSchema = z.object({ exploreRef: z.string(), version: z.string(), shareUrl: z.string() });

export const GemSchema = z.object({
  name: z.string(),
  createdFrom: z.string(),
  artifacts: z.array(GemArtifactSchema),
  checks: z.array(GemCheckSchema),
  requiredSecrets: z.array(SecretRequirementSchema),
  grade: z.number().int().min(1).max(3).optional(),
  contract: GemContractSchema.optional(),
  // .catch(undefined): an unreparable loop (malformed required core) is treated as no loop, so it
  // never rejects the gem — mirrors sanitizeLoop's read gate (issue #243 finding B).
  loop: LoopSpecSchema.optional().catch(undefined),
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
  artifactCounts: z.object({ skill: z.number(), mcp_server: z.number(), instructions: z.number(), hook: z.number(), subagent: z.number(), game: z.number() }),
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

// Target-project discovery: independently-existing eve/flue projects on this machine. `dir` overrides
// the ~/.claude base for the session-history pass; `roots` is an optional comma-separated allowlist of
// directories to additionally scan. `lastUsed` is a recency proxy (session mtime or dir mtime).
export const TargetProjectsQuerySchema = z.object({ dir: z.string().optional(), roots: z.string().optional() });
export const TargetProjectCandidateSchema = z.object({
  path: z.string(),
  target: TargetIdSchema,
  lastUsed: z.string().nullable(),
});
export const TargetProjectsResponseSchema = z.object({ projects: z.array(TargetProjectCandidateSchema) });

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
  // mirrors testbed ImportedRef.type — keep in sync when the importer gains a new artifact kind
  type: z.enum(["skill", "subagent", "mcp_server", "instructions", "hook", "channel"]),
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
  task: z.string().optional(),                             // falls back to the Gem's contract.task
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

export const AgentVerdictSchema = z.object({
  agent: z.enum(["claude", "codex"]),
  status: z.enum(["passed", "failed", "unavailable"]),
  verification: VerificationReportSchema.optional(),
  detail: z.string().optional(),
});
export const GemVerifyRequestSchema = z.object({
  selection: GemSelectionSchema.optional(),
  archivePath: z.string().optional(),
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  // Validated in the controller (unknown ids → InvalidInputError 400) so the error
  // is a clear message, not a schema 422, and the list stays extensible.
  agents: z.array(z.string()).optional(),
  fetch: z.boolean().optional(),       // default false: missing adapters report unavailable, never download
}).refine((d) => d.selection !== undefined || d.archivePath !== undefined, {
  message: "provide either selection or archivePath",
});
export const GemVerifyResponseSchema = z.object({
  gemName: z.string(),
  gemDigest: z.string(),
  baseDir: z.string(),
  verdicts: z.array(AgentVerdictSchema),
});

// Prepare→stream split for the matrix (mirrors GemRunPrepare*): the POST carries the
// selection/archive; the SSE GET carries only the opaque verifyId.
export const GemVerifyPrepareRequestSchema = z.object({
  selection: GemSelectionSchema.optional(),
  archivePath: z.string().optional(),
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),  // validated in the controller → clear 400
  fetch: z.boolean().optional(),
}).refine((d) => d.selection !== undefined || d.archivePath !== undefined, {
  message: "provide either selection or archivePath",
});
export const GemVerifyPrepareResponseSchema = z.object({
  verifyId: z.string(),
  gemName: z.string(),
  gemDigest: z.string(),
  agents: z.array(z.string()),
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
  type: z.string().optional(),
  publishedBy: z.string().optional(),
  grade: z.number().int().min(1).max(3).optional(),
  installable: z.boolean(),
  artifacts: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
});
export const RegistryGemsResponseSchema = z.object({ gems: z.array(RegistryGemSchema) });

export const RegistrySearchResponseSchema = z.object({
  results: z.array(z.object({
    key: z.string(), latest: z.string(), score: z.number(),
    description: z.string().optional(), tags: z.array(z.string()).optional(),
    author: z.string().optional(), publishedBy: z.string().optional(), artifactKinds: z.array(z.string()).optional(), updatedAt: z.string().optional(),
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

// ---- Play (miniapps registry) ----
export const PlaySaveRequestSchema = z.object({
  name: z.string(),
  html: z.string(),
  meta: z.object({
    title: z.string(),
    genre: z.enum(["replay", "skill-run", "project-fun"]),
    createdFrom: GameArtifactSchema.shape.createdFrom,
    engineVersion: z.string().default("1"),
    needs: z.array(z.enum(["session-data", "live-session-events", "local-project-access", "invoke-agent"])).optional(),
  }),
});
export const PlaySaveResponseSchema = z.object({ name: z.string(), commit: z.string().nullable() });
export const PlayDeleteRequestSchema = z.object({ name: z.string() });
const PlayNeedsSchema = z.array(z.enum(["session-data", "live-session-events", "local-project-access", "invoke-agent"])).optional();
const EmptyObjectSchema = z.object({});
export const PlayMcpAppSchema = z.object({
  resource: z.object({
    uri: z.string(),
    mimeType: z.string(),
    text: z.string(),
    _meta: z.object({
      ui: z.object({
        csp: z.object({
          connectDomains: z.array(z.string()),
          resourceDomains: z.array(z.string()),
          frameDomains: z.array(z.string()),
          baseUriDomains: z.array(z.string()),
        }),
        permissions: EmptyObjectSchema,
      }),
      "ai.agentgem/game": z.object({
        genre: z.string(),
        engineVersion: z.string(),
        createdFrom: GameArtifactSchema.shape.createdFrom,
        needs: PlayNeedsSchema,
        offline: z.boolean(),
      }),
    }),
  }),
  tool: z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.object({ type: z.literal("object"), properties: z.record(z.string(), z.unknown()) }),
    _meta: z.object({ ui: z.object({ resourceUri: z.string(), visibility: z.array(z.enum(["model", "app"])) }) }),
  }),
});
export const MiniappListSchema = z.object({ miniapps: z.array(z.object({ name: z.string(), title: z.string(), genre: z.string(), needs: PlayNeedsSchema })) });
// The codemod pass over the whole registry (POST /play/migrate): rewrites old-bridge miniapps to the
// MCP Apps client shim on disk. Optimization only — readMiniapp()'s on-read backstop already serves
// migrated html regardless of whether this route has run.
export const PlayMigrateResponseSchema = z.object({
  results: z.array(z.object({ name: z.string(), outcome: z.enum(["migrated", "already", "unrecognized"]), commit: z.string().nullable() })),
});
export const PlayMiniappQuerySchema = z.object({ name: z.string() });
export const PlaySessionDataQuerySchema = z.object({ name: z.string(), sessionId: z.string().optional(), agent: z.string().optional() });
export const PlayMiniappSchema = z.object({
  name: z.string(), html: z.string(),
  meta: z.object({ title: z.string(), genre: z.string(), createdFrom: GameArtifactSchema.shape.createdFrom, engineVersion: z.string(), needs: PlayNeedsSchema }),
});
export const PlayPublishRequestSchema = z.object({ remote: z.string().url().optional() });
export const PlayPublishResponseSchema = z.object({ ok: z.boolean() });
// `name` is the optional miniapp id. Omitted, it is derived from the source (and suffixed on collision);
// supplied, it is slugified and claimed exactly — a collision is a 409, not a silent rename.
export const PlayStudioRequestSchema = z.object({ source: GameArtifactSchema.shape.createdFrom, name: z.string().optional() });
export const PlayStudioResponseSchema = z.object({ name: z.string() });
// Import a miniapp from an existing self-contained HTML file. The HTML becomes the miniapp as-is (a
// draft opened in the studio); the seal gate is enforced on Save, not import, so imperfect HTML can be
// brought in and fixed by chatting with the agent.
export const PlayImportRequestSchema = z.object({ title: z.string().min(1), html: z.string().min(1), name: z.string().optional() });
// Create a miniapp from scratch — no source context. Seeds a blank sealed canvas + opens the studio;
// `prompt` is optional creative direction handed to the studio agent.
export const PlayBlankRequestSchema = z.object({ title: z.string().min(1), prompt: z.string().optional(), name: z.string().optional() });

// Host-brokered feed for a replay miniapp: its source-session transcript ({meta, timeline}), fetched on
// demand so the sealed bundle stays tiny. Only session-sourced miniapps have it (else 404).
export const PlaySessionDataSchema = z.object({
  meta: z.record(z.string(), z.unknown()),
  timeline: z.array(z.object({ role: z.string(), tsMs: z.number(), text: z.string() })),
});
