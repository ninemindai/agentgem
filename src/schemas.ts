// src/schemas.ts
import { z } from "zod";

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
});

export const InstructionsArtifactSchema = z.object({
  type: z.literal("instructions"),
  name: z.string(),
  content: z.string(),
});

export const PackArtifactSchema = z.discriminatedUnion("type", [
  SkillArtifactSchema,
  McpServerArtifactSchema,
  InstructionsArtifactSchema,
]);

export const ProjectInventorySchema = z.object({
  root: z.string(),
  skills: z.array(SkillArtifactSchema),
  mcpServers: z.array(McpServerArtifactSchema),
  instructions: z.array(InstructionsArtifactSchema),
});

export const InventorySchema = z.object({
  skills: z.array(SkillArtifactSchema),
  mcpServers: z.array(McpServerArtifactSchema),
  instructions: z.array(InstructionsArtifactSchema),
  project: ProjectInventorySchema.nullable().optional(),
});

export const PackSelectionSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    includeInstructions: z.boolean().optional(),
    projectSkills: z.array(z.string()).optional(),
    projectMcpServers: z.array(z.string()).optional(),
    includeProjectInstructions: z.boolean().optional(),
  }),
]);

export const PackRequestSchema = z.object({
  selection: PackSelectionSchema,
  name: z.string().optional(),
  dir: z.string().optional(),
  project: z.string().optional(),
});

export const DirQuerySchema = z.object({ dir: z.string().optional(), project: z.string().optional() });

export const PickQuerySchema = z.object({});
export const PickFolderSchema = z.object({ path: z.string().nullable() });

export const PackSchema = z.object({
  name: z.string(),
  createdFrom: z.string(),
  artifacts: z.array(PackArtifactSchema),
});
