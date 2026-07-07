// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/base/src/agents.ts
//
// Agent registry and availability probe: enumerates selectable ACP agent backends
// and reports which are installed on PATH, driving the chat's agent picker.
import { execFileSync } from "node:child_process";
import type { AgentDescriptor } from "./acpSession.js";

export const AGENTS: AgentDescriptor[] = [
  { id: "claude-code", name: "Claude Code", command: ["claude-agent-acp"], package: "@agentclientprotocol/claude-agent-acp", version: "0.51.0" },
  { id: "codex", name: "Codex", command: ["codex-acp"], package: "@agentclientprotocol/codex-acp", version: "1.1.0" },
];

export interface AgentAvailability {
  id: string;
  name: string;
  available: boolean;
}

function onPathDefault(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function availableAgents(
  onPath: (bin: string) => boolean = onPathDefault,
): AgentAvailability[] {
  return AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    available: onPath(a.command[0]),
  }));
}
