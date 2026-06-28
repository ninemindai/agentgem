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

export const makeClient = (apiBase: string): Client => createClient({ baseURL: apiBase });
