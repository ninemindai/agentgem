// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Production SourceReaders for Play, wired to the real local source APIs. Lives in root src/ (not
// packages/play) so packages/play stays free of the heavy insight/capture/testbed deps and any cycle.
import type { SourceReaders } from "@agentgem/play";
import { loadSessionTranscript, type AgentId } from "@agentgem/insight";
import { introspectConfig } from "@agentgem/capture";
import { suggestTestbed } from "@agentgem/testbed";
import { readdirSync, existsSync } from "node:fs";

export const defaultReaders: SourceReaders = {
  loadSession: async (sessionId, agent) => {
    const view = await loadSessionTranscript(sessionId, agent as AgentId);
    return view ? { sessionId: view.sessionId, meta: view.meta, turns: view.turns } : null;
  },
  readSkill: async (name) => {
    const s = introspectConfig().skills.find((k) => k.name === name);
    return s ? { name: s.name, content: s.content, trigger: s.trigger } : null;
  },
  readProject: async (path) => {
    if (!existsSync(path)) return null;
    let files: string[];
    try { files = readdirSync(path).slice(0, 40); } catch { return null; }
    // suggestTestbed detects the agent/testbed flavor (claude/codex) when present; used only as a light
    // theme hint here, not a gate — any existing dir is a valid project source for a themed miniapp.
    const flavor = suggestTestbed(path).flavor ?? "project";
    return { path, flavor, files };
  },
};
