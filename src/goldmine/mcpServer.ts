#!/usr/bin/env node
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/goldmine/mcpServer.ts
import { z } from "zod";
import { MCPApplication, mcpServer, tool } from "@agentback/mcp";
import { isMain } from "@agentback/core";
import { scanSessionsCached, summarizeSession, askSession } from "@agentgem/insight";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { RecallIndex } from "@agentgem/recall";
import { searchSessions, getArtifactDetail } from "./tools.js";
import { collectBehaviorFindings } from "./behaviorFindings.js";
import { defaultRecallDbPath } from "./recall.js";

const SearchInput = z.object({
  query: z.string().default(""),
  limit: z.number().int().min(1).max(50).default(10),
});

const SearchContentInput = z.object({
  query: z.string(),
  project: z.string().optional(),
  agent: z.string().optional(),
  since: z.number().optional(),
  limit: z.number().int().min(1).max(50).default(12),
});

const SummarizeInput = z.object({
  sessionId: z.string(),
  agent: z.string().default("claude"),
});

const AskInput = z.object({
  sessionId: z.string(),
  agent: z.string().default("claude"),
  question: z.string().min(1),
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

  @tool("search_session_content", {
    input: SearchContentInput,
    description: "Search past session transcript CONTENT (not just metadata) for moments matching a query; returns ranked moments across sessions with snippets.",
  })
  async searchSessionContentTool({ query, project, agent, since, limit }: z.infer<typeof SearchContentInput>) {
    const index = new RecallIndex(defaultRecallDbPath());
    try {
      return { moments: index.search(query, { project, agent, since }, limit) };
    } finally { index.close(); }
  }

  @tool("summarize_session", {
    input: SummarizeInput,
    description: "Aggregate view of one past session — process-quality score, stage mix (exploration/implementation/verification/orchestration), detector findings, metrics, and tool/edit/verify counts. NO raw content. Call this FIRST for any 'how did session X go' question (use sessionId + agent from search_sessions).",
  })
  async summarizeSessionTool({ sessionId, agent }: z.infer<typeof SummarizeInput>) {
    return { summary: await summarizeSession(sessionId, agent) };
  }

  @tool("ask_session", {
    input: AskInput,
    description: "Ask a specific question about what actually happened in one past session. The raw transcript is read by a separate agent (the session's own model) which returns only the answer — the transcript itself never enters this conversation. Use for 'find where X', 'why did it Y', or to quote a specific exchange, when summarize_session isn't enough.",
  })
  async askSessionTool({ sessionId, agent, question }: z.infer<typeof AskInput>) {
    return { result: await askSession(sessionId, agent, question) };
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
