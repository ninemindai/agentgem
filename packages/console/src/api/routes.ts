import { z } from "zod";
import { createClient, defineRoute, type Client } from "@agentback/client";

// Minimal client-side schemas: validate ONLY what the UI reads. Zod strips the
// server's extra artifact fields. When a shared browser-safe contract package is
// extracted later, replace these with imports from it.
const ArtifactSchema = z.object({ name: z.string() });
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
export const usageRoute = defineRoute("GET", "/api/usage", { response: UsageSchema });

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
  checks: z.number(),
  renderedTargets: z.array(z.string()),
});
export const WorkspacesSchema = z.object({ workspaces: z.array(WorkspaceSummarySchema) });
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

export const workspacesRoute = defineRoute("GET", "/api/workspaces", { response: WorkspacesSchema });

// POST /api/gem — build a gem from a selection. Request mirrors the server's
// GemRequestSchema (only the fields the UI sends; channels/dir/etc. are optional).
const GemSelectionSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    includeInstructions: z.boolean().optional(),
    hooks: z.array(z.string()).optional(),
  }),
]);
export const GemRequestSchema = z.object({
  selection: GemSelectionSchema,
  name: z.string().optional(),
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

export const makeClient = (apiBase: string): Client => createClient({ baseURL: apiBase });
