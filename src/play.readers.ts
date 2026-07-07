// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Production SourceReaders for Play, wired to the real local source APIs. Lives in root src/ (not
// packages/play) so packages/play stays free of the heavy insight/capture/testbed deps and any cycle.
import type { SourceReaders } from "@agentgem/play";
import { loadSessionTranscript, type AgentId } from "@agentgem/insight";
import { introspectConfig } from "@agentgem/capture";
import { suggestTestbed } from "@agentgem/testbed";
import { readdirSync } from "node:fs";

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
    const sug = suggestTestbed(path);
    if (!sug.looksLikeProject || !sug.flavor) return null;
    let files: string[] = [];
    try { files = readdirSync(path).slice(0, 40); } catch { files = []; }
    return { path, flavor: sug.flavor, files };
  },
};
