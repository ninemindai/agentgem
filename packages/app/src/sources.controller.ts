// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { InvalidInputError } from "@agentgem/model";
import {
  CURATED_SOURCES,
  curatedSourceById,
  cfgForCuratedSource,
  sourceDivisions,
  sourceAgents,
  sourceEntry,
  importSourceSkill,
  assertSourcePath,
  type CuratedSource,
} from "@agentgem/distribute";
import { SkillArtifactSchema } from "./schemas.js";
import { installAgencySkill } from "./sourcesCore.js";

const CuratedSourceSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  repo: z.string(),
  ref: z.string(),
  kind: z.enum(["agency-layout", "skills-layout"]),
  license: z.string().optional(),
  homepage: z.string().optional(),
});
const SourcesResult = z.object({ sources: z.array(CuratedSourceSchema) });

const SourceQuery = z.object({ source: z.string().min(1) });
const AgentsQuery = z.object({ source: z.string().min(1), division: z.string().min(1) });
const AgentQuery = z.object({ source: z.string().min(1), path: z.string().min(1) });
const ImportBody = z.object({ source: z.string().min(1), path: z.string().min(1) }).strict();
const InstallResult = z.object({ ok: z.boolean(), skill: z.string(), dir: z.string() });

const DivisionSchema = z.object({ key: z.string(), label: z.string(), icon: z.string().optional(), color: z.string().optional() });
const DivisionsResult = z.object({ divisions: z.array(DivisionSchema) });
const AgentRefSchema = z.object({ division: z.string(), slug: z.string(), name: z.string(), path: z.string() });
const AgentsResult = z.object({ agents: z.array(AgentRefSchema) });
const EntrySchema = z.object({
  division: z.string(), slug: z.string(), name: z.string(), path: z.string(),
  description: z.string().optional(), vibe: z.string().optional(), color: z.string().optional(), emoji: z.string().optional(),
});

// Input containment: a division is a single path segment. Agent-path shape is kind-specific
// (agency-layout vs skills-layout), so it's validated via `assertSourcePath` (dispatch by
// `source.kind`, in @agentgem/distribute) — a caller can't walk to arbitrary repo files or
// traverse out (the repo itself is fixed per source).
const DIV_RE = /^[a-z0-9-]+$/;

function sourceOrThrow(id: string): CuratedSource {
  const s = curatedSourceById(id);
  if (!s) throw new InvalidInputError(`Unknown curated source '${id}'.`);
  return s;
}
function divisionOrThrow(d: string): string {
  if (!DIV_RE.test(d)) throw new InvalidInputError(`Invalid division '${d}'.`);
  return d;
}

// Curated import sources that bootstrap the Gem registry. Reads are server-proxied (the browser
// stays same-origin) through the token-optional GitHub Contents API; import maps a persona/skill
// into a SkillArtifact ready to bundle into a Gem. Every source has a `kind` (agency-layout,
// skills-layout); more sources are more CURATED_SOURCES entries (same layout) or a new adapter +
// kind, dispatched uniformly via `@agentgem/distribute`'s sourceImport.ts.
@api({ basePath: "/api/sources" })
export class SourcesController {
  @get("/", { response: SourcesResult })
  async list(): Promise<z.infer<typeof SourcesResult>> {
    return { sources: CURATED_SOURCES };
  }

  @get("/divisions", { query: SourceQuery, response: DivisionsResult })
  async divisions(input: { query: z.infer<typeof SourceQuery> }): Promise<z.infer<typeof DivisionsResult>> {
    const source = sourceOrThrow(input.query.source);
    return { divisions: await sourceDivisions(source, cfgForCuratedSource(source)) };
  }

  @get("/agents", { query: AgentsQuery, response: AgentsResult })
  async agents(input: { query: z.infer<typeof AgentsQuery> }): Promise<z.infer<typeof AgentsResult>> {
    const source = sourceOrThrow(input.query.source);
    return { agents: await sourceAgents(source, divisionOrThrow(input.query.division), cfgForCuratedSource(source)) };
  }

  @get("/agent", { query: AgentQuery, response: EntrySchema })
  async agent(input: { query: z.infer<typeof AgentQuery> }): Promise<z.infer<typeof EntrySchema>> {
    const source = sourceOrThrow(input.query.source);
    return sourceEntry(source, assertSourcePath(source, input.query.path), cfgForCuratedSource(source));
  }

  // Pure read (fetches curated content, writes nothing) exposed as both GET — reachable
  // cross-origin via originGuard's PUBLIC_READ_PATHS — and POST, which the same-origin console
  // still uses. Both delegate to importSkill so the two can't drift.
  @get("/import", { query: AgentQuery, response: SkillArtifactSchema })
  async importGet(input: { query: z.infer<typeof AgentQuery> }): Promise<z.infer<typeof SkillArtifactSchema>> {
    return this.importSkill(input.query.source, input.query.path);
  }

  @post("/import", { body: ImportBody, response: SkillArtifactSchema })
  async import(input: { body: z.infer<typeof ImportBody> }): Promise<z.infer<typeof SkillArtifactSchema>> {
    return this.importSkill(input.body.source, input.body.path);
  }

  private importSkill(source: string, path: string): Promise<z.infer<typeof SkillArtifactSchema>> {
    const s = sourceOrThrow(source);
    return importSourceSkill(s, assertSourcePath(s, path), cfgForCuratedSource(s));
  }

  // Install a persona into the user's global skills home (~/.agents/skills/<name>/SKILL.md) —
  // the same dir introspect reads — so it appears in "Import from machine" and can be Curated,
  // built into a Gem, and published. This is a LOCAL-machine action (mirrors Discover's install).
  @post("/install", { body: ImportBody, response: InstallResult })
  async install(input: { body: z.infer<typeof ImportBody> }): Promise<z.infer<typeof InstallResult>> {
    const { ok, skill, dir } = await installAgencySkill(input.body.source, input.body.path);
    return { ok, skill, dir };
  }
}
