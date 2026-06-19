// src/schemas.ts
import { z } from "zod";
import { RUNNER_REGISTRY } from "./gem/checks.js";
import { TARGET_REGISTRY } from "./gem/targets.js";
import { deployTargetIds } from "./gem/deploy.js";

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

export const PackArtifactSchema = z.discriminatedUnion("type", [
  SkillArtifactSchema,
  McpServerArtifactSchema,
  InstructionsArtifactSchema,
  HookArtifactSchema,
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

// runner validates against the registry keys, so a pack can't declare a check no runner can run.
const RUNNER_IDS = Object.keys(RUNNER_REGISTRY) as [string, ...string[]];
export const ExternalCheckSchema = z.object({
  kind: z.literal("external"),
  name: z.string(),
  description: z.string().optional(),
  runner: z.enum(RUNNER_IDS),
  with: z.record(z.string(), z.unknown()).optional(),
});

export const PackCheckSchema = z.discriminatedUnion("kind", [BehavioralCheckSchema, ExternalCheckSchema]);

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

export const PackSelectionSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    includeInstructions: z.boolean().optional(),
    hooks: z.array(z.string()).optional(),
    projects: ProjectSelectionSchema.optional(),
  }),
]);

export const PackRequestSchema = z.object({
  selection: PackSelectionSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  checks: z.array(PackCheckSchema).optional(),
});

export const ScaffoldChecksRequestSchema = z.object({
  selection: PackSelectionSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
});

export const ScaffoldChecksResponseSchema = z.object({ checks: z.array(PackCheckSchema) });

const TARGET_IDS = Object.keys(TARGET_REGISTRY) as [string, ...string[]];
export const TargetIdSchema = z.enum(TARGET_IDS);

export const SkippedArtifactSchema = z.object({
  artifact: z.string(),
  type: z.enum(["skill", "mcp_server", "instructions", "hook"]),
  reason: z.string(),
});

export const MaterializeResponseSchema = z.object({
  target: TargetIdSchema,
  files: z.record(z.string(), z.string()),
  skipped: z.array(SkippedArtifactSchema),
  compatibility: z.record(TargetIdSchema, z.object({ supported: z.number(), skipped: z.number() })),
});

// ── Gem archive ──
export const PackLockSchema = z.object({
  formatVersion: z.number(),
  files: z.record(z.string(), z.string()),
  packDigest: z.string(),
  signature: z.string().nullable(),
});

export const PackManifestArtifactSchema = z.object({
  type: z.enum(["skill", "mcp_server", "instructions", "hook"]),
  name: z.string(),
  path: z.string(),
  description: z.string().optional(),
  source: z.string().optional(),
});

export const PackManifestSchema = z.object({
  formatVersion: z.number(),
  name: z.string(),
  version: z.string(),
  createdFrom: z.string(),
  artifacts: z.array(PackManifestArtifactSchema),
  requiredSecrets: z.array(SecretRequirementSchema),
  checks: z.array(z.object({ name: z.string(), path: z.string() })),
});

export const ArchiveRequestSchema = z.object({
  selection: PackSelectionSchema,
  name: z.string().optional(),
  version: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  outDir: z.string().optional(), // when set, write the tree here and return its path
  tar: z.boolean().optional(),   // when true, also return the tree as a base64 .tar.gz
});

export const ArchiveResponseSchema = z.object({
  files: z.record(z.string(), z.string()),
  lock: PackLockSchema,
  skipped: z.array(SkippedArtifactSchema),
  path: z.string().nullable(),
  tarGz: z.string().nullable(), // base64 .tar.gz when `tar` was requested, else null
});

export const MaterializeRequestSchema = z.object({
  selection: PackSelectionSchema.optional(),
  archivePath: z.string().optional(),
  target: TargetIdSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
}).refine((d) => d.selection !== undefined || d.archivePath !== undefined, {
  message: "provide either selection or archivePath",
});

export const DeployTargetIdSchema = z.enum(deployTargetIds);
export const DeployReadyQuerySchema = z.object({ target: DeployTargetIdSchema.optional() });
export const DeployTargetsResponseSchema = z.object({
  targets: z.array(z.object({ id: DeployTargetIdSchema, label: z.string(), ready: z.boolean() })),
});

// ── Managed Agents publish ──
export const PublishPreviewRequestSchema = z.object({
  selection: PackSelectionSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  target: DeployTargetIdSchema.optional(),
});
export const PublishRequestSchema = PublishPreviewRequestSchema.extend({ requestId: z.string().min(8).max(128) });

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

export const PublishPreviewResponseSchema = z.object({
  payload: ManagedAgentPayloadSchema,
  skillsToRegister: z.array(z.string()),
  skipped: z.array(SkippedArtifactSchema),
  vaultSecrets: z.array(SecretRequirementSchema),
});

export const PublishReadyResponseSchema = z.object({ ready: z.boolean() });

export const PublishResultSchema = z.object({
  agentId: z.string(),
  environmentId: z.string(),
  version: z.string(),
  registeredSkills: z.array(z.object({ name: z.string(), skillId: z.string(), version: z.string() })),
  skipped: z.array(SkippedArtifactSchema),
  vaultSecrets: z.array(SecretRequirementSchema),
});

// `projects` is a JSON-encoded string array of root paths (query params can't carry arrays cleanly).
export const DirQuerySchema = z.object({ dir: z.string().optional(), projects: z.string().optional() });

export const PickQuerySchema = z.object({});
export const PickFolderSchema = z.object({ path: z.string().nullable() });

export const PackSchema = z.object({
  name: z.string(),
  createdFrom: z.string(),
  artifacts: z.array(PackArtifactSchema),
  checks: z.array(PackCheckSchema),
  requiredSecrets: z.array(SecretRequirementSchema),
});

// ── Workspaces ──
export const WorkspaceSummarySchema = z.object({
  name: z.string(),
  packName: z.string(),
  version: z.string(),
  artifactCounts: z.object({ skill: z.number(), mcp_server: z.number(), instructions: z.number(), hook: z.number() }),
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
  selection: PackSelectionSchema,
  dir: z.string().optional(),
  projects: z.array(z.string()).optional(),
  version: z.string().optional(),
});
export const WorkspaceQuerySchema = z.object({ name: z.string() });
export const RenderRequestSchema = z.object({ name: z.string(), target: TargetIdSchema });
export const WorkspaceNameRequestSchema = z.object({ name: z.string() });
export const ListWorkspacesResponseSchema = z.object({ workspaces: z.array(WorkspaceSummarySchema) });
export const DeleteWorkspaceResponseSchema = z.object({ deleted: z.string() });
