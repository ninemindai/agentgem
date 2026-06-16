// src/schemas.ts
import { z } from "zod";
import { RUNNER_REGISTRY } from "./pack/checks.js";

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
