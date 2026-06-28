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

// Selection shape shared by build/archive/materialize/run/workspace routes.
const GemSelectionSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({
    skills: z.array(z.string()).optional(),
    mcpServers: z.array(z.string()).optional(),
    includeInstructions: z.boolean().optional(),
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

export const makeClient = (apiBase: string): Client => createClient({ baseURL: apiBase });
