// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Serve-time adapter: mint a stored miniapp as an MCP Apps UI resource + launcher tool.
// Spec: modelcontextprotocol/ext-apps, accepted MVP 2026-01-26 (extension id io.modelcontextprotocol/ui).
// Pure + I/O-free — the caller supplies the already-loaded miniapp.
import type { GameCapability } from "@agentgem/model";
import type { MiniappMeta } from "./miniapps.js";

export const MCP_APP_MIME = "text/html;profile=mcp-app";

export interface McpUiCsp {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
}

// AgentGem's namespaced extension block — the _meta key MCP Apps reserves for producer extensions,
// exactly as ChatGPT layers "openai/*". Carries provenance + the capability declaration a host reads.
export interface AgentGemGameMeta {
  genre: MiniappMeta["genre"];
  engineVersion: string;
  createdFrom: MiniappMeta["createdFrom"];
  needs?: GameCapability[];
  offline: boolean; // fast-path marker: calls no tools, pure sealed content
}

export interface McpUiResource {
  uri: string;
  mimeType: string;
  text: string;
  _meta: {
    ui: { csp: McpUiCsp; permissions: Record<string, never> };
    "io.agentgem/game": AgentGemGameMeta;
  };
}

export interface McpUiTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, never> };
  _meta: { ui: { resourceUri: string; visibility: ("model" | "app")[] } };
}

export interface McpApp { resource: McpUiResource; tool: McpUiTool }

// Every current capability is host-brokered over postMessage (a tools/call), never a network fetch from
// the sealed frame — so the CSP stays fully sealed regardless of `needs`. This constant is the single
// seam a future network-declaring capability would widen.
const SEALED_CSP: McpUiCsp = { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };

export function uiUri(name: string): string { return `ui://agentgem/${name}`; }

export function mcpResourceFor(app: { name: string; html: string; meta: MiniappMeta }): McpUiResource {
  const needs = app.meta.needs;
  return {
    uri: uiUri(app.name),
    mimeType: MCP_APP_MIME,
    text: app.html,
    _meta: {
      ui: { csp: SEALED_CSP, permissions: {} },
      "io.agentgem/game": {
        genre: app.meta.genre,
        engineVersion: app.meta.engineVersion,
        createdFrom: app.meta.createdFrom,
        ...(needs && needs.length ? { needs } : {}),
        offline: !needs || needs.length === 0,
      },
    },
  };
}

export function mcpToolFor(app: { name: string; meta: MiniappMeta }): McpUiTool {
  return {
    name: `play_${app.name}`,
    description: `Launch the "${app.meta.title}" miniapp`,
    inputSchema: { type: "object", properties: {} },
    _meta: { ui: { resourceUri: uiUri(app.name), visibility: ["app"] } },
  };
}

export function mcpAppFor(app: { name: string; html: string; meta: MiniappMeta }): McpApp {
  return { resource: mcpResourceFor(app), tool: mcpToolFor({ name: app.name, meta: app.meta }) };
}
