#!/usr/bin/env node
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/play/mcpServer.ts
//
// The agentgem-play MCP endpoint (spec §3 A8): serves stored miniapps to any
// MCP Apps host as `ui://agentgem/<name>` resources + `play_<name>` launcher
// tools. Every shape on the wire comes from mcpAppFor — the minting functions
// in packages/play/src/mcpApp.ts are the single source of truth; this file is
// transport only. Deliberately narrow: no capability tools (a host-proxied
// capability call gets method-not-found and the miniapp degrades per P3/S9),
// no registry mutation, nothing beyond the bundle + its declared metadata.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpError, ErrorCode, ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { isMain } from "@agentback/core";
import { listMiniapps, readMiniapp, mcpAppFor, mcpToolFor, uiUri, INSPECTOR_HTML, INSPECTOR_META, type MiniappMeta } from "@agentgem/play";

// The inspector is a constant, never in the registry (same special-case as the
// REST route in packages/app/src/play.controller.ts).
function apps(): { name: string; meta: MiniappMeta }[] {
  return [{ name: INSPECTOR_META.name, meta: INSPECTOR_META as MiniappMeta }, ...listMiniapps()];
}

function readApp(name: string): { name: string; html: string; meta: MiniappMeta } {
  if (name === INSPECTOR_META.name) return { name: INSPECTOR_META.name, html: INSPECTOR_HTML, meta: INSPECTOR_META as MiniappMeta };
  return readMiniapp(name);
}

export function buildPlayMcpServer(): Server {
  const server = new Server({ name: "agentgem-play", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  // Registry state is read inside each handler, never captured at build time:
  // A8 requires the list to reflect the registry at list time.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: apps().map((a) => mcpToolFor(a)),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const app = apps().find((a) => `play_${a.name}` === req.params.name);
    if (!app) throw new McpError(ErrorCode.MethodNotFound, `unknown tool ${req.params.name}`);
    // The host renders the widget from the tool's declared _meta.ui.resourceUri;
    // the call result just confirms the launch.
    return { content: [{ type: "text", text: `Rendering "${app.meta.title}" from ${uiUri(app.name)}` }] };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    // The minted resource minus its bundle text: listing is discovery, read is delivery.
    resources: apps().map((a) => {
      const { text: _text, ...rest } = mcpAppFor(readApp(a.name)).resource;
      return { ...rest, name: a.name };
    }),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const prefix = uiUri("");
    if (!req.params.uri.startsWith(prefix)) throw new McpError(ErrorCode.InvalidParams, `not an agentgem app uri: ${req.params.uri}`);
    const name = req.params.uri.slice(prefix.length);
    try {
      return { contents: [mcpAppFor(readApp(name)).resource] };
    } catch {
      throw new McpError(ErrorCode.InvalidParams, `unknown miniapp ${name}`);
    }
  });

  return server;
}

export async function main(): Promise<void> {
  await buildPlayMcpServer().connect(new StdioServerTransport());
}

if (isMain(import.meta)) void main();
