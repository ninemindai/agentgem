// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { InvalidInputError } from "@agentgem/model";
import {
  CURATED_SOURCES,
  curatedSourceById,
  cfgForCuratedSource,
  fetchAgencyDivisions,
  listAgencyAgents,
  fetchAgencyAgentEntry,
  importAgencyAgentSkill,
  type CuratedSource,
} from "@agentgem/distribute";
import { SkillArtifactSchema } from "./schemas.js";

const CuratedSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  repo: z.string(),
  ref: z.string(),
  kind: z.literal("agency-layout"),
  license: z.string().optional(),
  homepage: z.string().optional(),
});
const SourcesResult = z.object({ sources: z.array(CuratedSourceSchema) });

const SourceQuery = z.object({ source: z.string().min(1) });
const AgentsQuery = z.object({ source: z.string().min(1), division: z.string().min(1) });
const AgentQuery = z.object({ source: z.string().min(1), path: z.string().min(1) });
const ImportBody = z.object({ source: z.string().min(1), path: z.string().min(1) }).strict();

const DivisionSchema = z.object({ key: z.string(), label: z.string(), icon: z.string().optional(), color: z.string().optional() });
const DivisionsResult = z.object({ divisions: z.array(DivisionSchema) });
const AgentRefSchema = z.object({ division: z.string(), slug: z.string(), name: z.string(), path: z.string() });
const AgentsResult = z.object({ agents: z.array(AgentRefSchema) });
const EntrySchema = z.object({
  division: z.string(), slug: z.string(), name: z.string(), path: z.string(),
  description: z.string().optional(), vibe: z.string().optional(), color: z.string().optional(), emoji: z.string().optional(),
});

// Input containment: a division is a single path segment; an agent path is exactly
// "<division>/<file>.md". Both bound what we fetch to the source repo's persona layout — a
// caller can't walk to arbitrary repo files or traverse out (the repo itself is fixed per source).
const DIV_RE = /^[a-z0-9-]+$/;
const AGENCY_PATH_RE = /^[a-z0-9-]+\/[A-Za-z0-9._-]+\.md$/;

function sourceOrThrow(id: string): CuratedSource {
  const s = curatedSourceById(id);
  if (!s) throw new InvalidInputError(`Unknown curated source '${id}'.`);
  return s;
}
function divisionOrThrow(d: string): string {
  if (!DIV_RE.test(d)) throw new InvalidInputError(`Invalid division '${d}'.`);
  return d;
}
function agencyPathOrThrow(path: string): string {
  if (path.includes("..") || !AGENCY_PATH_RE.test(path)) throw new InvalidInputError(`Invalid agent path '${path}'.`);
  return path;
}

// Curated import sources that bootstrap the Gem registry. Reads are server-proxied (the browser
// stays same-origin) through the token-optional GitHub Contents API; import maps a persona into a
// SkillArtifact ready to bundle into a Gem. Today every source is "agency-layout"; more sources
// are more CURATED_SOURCES entries (same layout) or a new adapter + kind.
@api({ basePath: "/api/sources" })
export class SourcesController {
  @get("/", { response: SourcesResult })
  async list(): Promise<z.infer<typeof SourcesResult>> {
    return { sources: CURATED_SOURCES };
  }

  @get("/divisions", { query: SourceQuery, response: DivisionsResult })
  async divisions(input: { query: z.infer<typeof SourceQuery> }): Promise<z.infer<typeof DivisionsResult>> {
    const source = sourceOrThrow(input.query.source);
    return { divisions: await fetchAgencyDivisions(cfgForCuratedSource(source)) };
  }

  @get("/agents", { query: AgentsQuery, response: AgentsResult })
  async agents(input: { query: z.infer<typeof AgentsQuery> }): Promise<z.infer<typeof AgentsResult>> {
    const source = sourceOrThrow(input.query.source);
    return { agents: await listAgencyAgents(divisionOrThrow(input.query.division), cfgForCuratedSource(source)) };
  }

  @get("/agent", { query: AgentQuery, response: EntrySchema })
  async agent(input: { query: z.infer<typeof AgentQuery> }): Promise<z.infer<typeof EntrySchema>> {
    const source = sourceOrThrow(input.query.source);
    return fetchAgencyAgentEntry(agencyPathOrThrow(input.query.path), cfgForCuratedSource(source));
  }

  @post("/import", { body: ImportBody, response: SkillArtifactSchema })
  async import(input: { body: z.infer<typeof ImportBody> }): Promise<z.infer<typeof SkillArtifactSchema>> {
    const source = sourceOrThrow(input.body.source);
    return importAgencyAgentSkill(agencyPathOrThrow(input.body.path), cfgForCuratedSource(source));
  }
}
