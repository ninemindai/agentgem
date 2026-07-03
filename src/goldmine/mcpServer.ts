#!/usr/bin/env node
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/mcpServer.ts
import { z } from "zod";
import { MCPApplication, mcpServer, tool } from "@agentback/mcp";
import { isMain } from "@agentback/core";
import { scanSessionsCached, loadSessionTranscript } from "@agentgem/insight";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { searchSessions, getArtifactDetail, windowTranscript } from "./tools.js";
import { collectBehaviorFindings } from "./behaviorFindings.js";

const SearchInput = z.object({
  query: z.string().default(""),
  limit: z.number().int().min(1).max(50).default(10),
});

const TranscriptInput = z.object({
  sessionId: z.string(),
  agent: z.enum(["claude", "codex"]).default("claude"),
  from: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(30),
});

const DetailInput = z.object({
  type: z.enum(["skill", "mcp_server", "hook", "instructions"]),
  name: z.string(),
  root: z.string().optional(),
});

const BehaviorInput = z.object({
  days: z.number().int().min(1).max(90).default(14),
});

@mcpServer()
export class GoldmineTools {
  @tool("search_sessions", {
    input: SearchInput,
    description: "Search the user's past coding sessions by project/model/branch. Returns newest matches.",
  })
  async searchSessionsTool({ query, limit }: z.infer<typeof SearchInput>) {
    const sessions = await scanSessionsCached(Date.now());
    return { matches: searchSessions(sessions, query, limit) };
  }

  @tool("get_session_transcript", {
    input: TranscriptInput,
    description: "Read a bounded window of turns from one past session (use sessionId + agent from search_sessions). Content is redacted; page forward with `from`. `meta` carries the session's token counts.",
  })
  async getSessionTranscriptTool({ sessionId, agent, from, limit }: z.infer<typeof TranscriptInput>) {
    const view = await loadSessionTranscript(sessionId, agent);
    if (!view) return { found: false, sessionId };
    return { found: true, ...windowTranscript(view, from, limit) };
  }

  @tool("get_artifact_detail", {
    input: DetailInput,
    description: "Return detail about one installed artifact (skill/mcp_server/hook/instructions).",
  })
  async getArtifactDetailTool({ type, name, root }: z.infer<typeof DetailInput>) {
    const global = introspectConfig();
    const project = root ? introspectProject(root) : null;
    const detail = getArtifactDetail(global, project, type, name);
    return { detail };
  }

  @tool("get_behavior_findings", {
    input: BehaviorInput,
    description: "Recurring problematic behaviors detected in the user's recent coding sessions (retry storms, thrash loops, unverified finishes, user-defined rules), with per-pattern advice. Use when the user asks how to improve, what went wrong, or about their habits.",
  })
  async getBehaviorFindingsTool({ days }: z.infer<typeof BehaviorInput>) {
    return collectBehaviorFindings({ days });
  }
}

export async function main(): Promise<void> {
  const app = new MCPApplication();
  app.configure("servers.MCPServer").to({ name: "agentgem-goldmine", version: "0.1.0" });
  app.service(GoldmineTools);
  await app.start(); // stdio transport; blocks until stdin closes
}

if (isMain(import.meta)) void main();
