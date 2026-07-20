// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Zero-config install of a hosted (shared) gem: fetch the .gem archive from the hosted aggregator's
// public download (no registry config), and surface the executable artifacts (MCP servers, hooks)
// so the console can gate the install on an explicit consent step before materializing.
import type { Gem } from "@agentgem/model";
import { InvalidInputError } from "@agentgem/model";

// The executable artifacts a gem would run on install. Skills/instructions are inert text; MCP
// servers and hooks execute commands, so they drive the consent prompt.
export function executableArtifacts(gem: Gem): { mcp: string[]; hooks: string[] } {
  return {
    mcp: gem.artifacts.filter((a) => a.type === "mcp_server").map((a) => a.name),
    hooks: gem.artifacts.filter((a) => a.type === "hook").map((a) => a.name),
  };
}

export function hasExecutable(gem: Gem): boolean {
  const e = executableArtifacts(gem);
  return e.mcp.length > 0 || e.hooks.length > 0;
}

export type ArchiveHttp = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;
const defaultHttp: ArchiveHttp = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: () => res.json() };
};

// Resolve the hosted base: explicit endpoint -> AGENTGEM_AGGREGATOR_URL -> the hosted default.
function resolveBase(endpoint: string | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  return "https://api.agentgem.ai";
}

// Download a published gem's archive bytes from the hosted public download.
export async function fetchHostedArchive(args: { key: string; version: string; endpoint?: string; http?: ArchiveHttp }): Promise<Buffer> {
  const base = resolveBase(args.endpoint);
  const http = args.http ?? defaultHttp;
  const url = `${base}/api/aggregator/gem-archive?key=${encodeURIComponent(args.key)}&version=${encodeURIComponent(args.version)}`;
  const res = await http(url);
  if (res.status === 404) throw new InvalidInputError("that gem is not available for install (no uploaded archive)");
  if (res.status < 200 || res.status >= 300) throw new InvalidInputError(`could not fetch the gem (HTTP ${res.status}); try again in a moment`);
  const b = (await res.json()) as { archiveBase64?: string };
  if (!b.archiveBase64) throw new InvalidInputError("gem archive not found");
  return Buffer.from(b.archiveBase64, "base64");
}
