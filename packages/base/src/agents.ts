// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/base/src/agents.ts
//
// Agent registry and availability probe: enumerates selectable ACP agent backends
// and reports which are installed on PATH, driving the chat's agent picker.
import type { AgentDescriptor } from "./acpSession.js";
import { resolveAdapterSource, adapterRuntimeCtx, type AdapterCtx, type AdapterSource } from "./adapters.js";

export const AGENTS: AgentDescriptor[] = [
  { id: "claude-code", name: "Claude Code", command: ["claude-agent-acp"], package: "@agentclientprotocol/claude-agent-acp", version: "0.51.0" },
  { id: "codex", name: "Codex", command: ["codex-acp"], package: "@agentclientprotocol/codex-acp", version: "1.1.0" },
];

export interface AgentAvailability {
  id: string;
  name: string;
  available: boolean;
  installable: boolean;   // missing + on CLI + has an npm package (desktop can't install on demand)
  source: AdapterSource;
}

export function availableAgents(ctx: AdapterCtx = adapterRuntimeCtx()): AgentAvailability[] {
  return AGENTS.map((a) => {
    const r = resolveAdapterSource(a, ctx);
    const available = r.source !== "missing";
    return {
      id: a.id,
      name: a.name,
      available,
      installable: !available && ctx.runtime === "cli" && Boolean(a.package),
      source: r.source,
    };
  });
}
