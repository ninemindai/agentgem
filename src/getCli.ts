// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// `agentgem get <key>[@<version>]` — download a published gem from the hosted marketplace and import
// it into the local app as a workspace. Zero-config: no registry setup, no browser, no running daemon
// — the CLI counterpart to the marketplace "Open in AgentGem" deep link, for anyone with Node.
import { fetchHostedArchive, hasExecutable, executableArtifacts, type ArchiveHttp } from "@agentgem/app/gem/hostedInstall";
import { importGem } from "@agentgem/distribute";
import { createWorkspace } from "@agentgem/base";

export interface GetArgs { key: string; version?: string; yes: boolean; endpoint?: string; help: boolean }

export const GET_HELP = `agentgem get <key>[@<version>]  — download a published gem and import it locally

  agentgem get raymondfeng/agentgem-biz@0.1.0
  agentgem get @octocat/kit --version 1.0.0
  agentgem get raymondfeng/agentgem-biz            (resolves the latest published version)

Options:
  --version <v>   Pin a version (same as <key>@<version>)
  --yes, -y       Import even if the gem runs executable artifacts (MCP servers / hooks)
  --endpoint <u>  Marketplace API base (default $AGENTGEM_AGGREGATOR_URL or https://api.agentgem.ai)`;

// `<key>[@<version>]` plus --version, --yes/-y, --endpoint. The key may itself start with "@"
// (@scope/name), so only a "@" AFTER position 0 separates a version.
export function parseGetArgs(argv: string[]): GetArgs {
  const val = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const flag = (...ns: string[]) => ns.some((n) => argv.includes(n));
  let key = argv.find((a) => !a.startsWith("-")) ?? "";
  let version = val("--version");
  const at = key.lastIndexOf("@");
  if (at > 0) { if (!version) version = key.slice(at + 1); key = key.slice(0, at); }
  return { key, version, yes: flag("--yes", "-y"), endpoint: val("--endpoint"), help: flag("-h", "--help") };
}

const DEFAULT_HTTP: ArchiveHttp = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  return { status: res.status, json: () => res.json() };
};

function resolveBase(endpoint: string | undefined): string {
  return endpoint ?? process.env.AGENTGEM_AGGREGATOR_URL ?? "https://api.agentgem.ai";
}

// Descending order so the newest version sorts first. Dotted-numeric compare, non-numeric segments
// fall back to string compare — good enough to pick the latest of a handful of published versions.
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split("."), pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]), nb = Number(pb[i]);
    if (Number.isInteger(na) && Number.isInteger(nb)) { if (na !== nb) return nb - na; }
    else { const c = (pb[i] ?? "").localeCompare(pa[i] ?? ""); if (c !== 0) return c; }
  }
  return 0;
}

// Look up the latest published version for a key when the caller didn't pin one.
async function resolveVersion(key: string, endpoint: string | undefined, http: ArchiveHttp): Promise<string> {
  const res = await http(`${resolveBase(endpoint)}/api/registry/gems`);
  if (res.status < 200 || res.status >= 300) throw new Error(`could not reach the marketplace (HTTP ${res.status})`);
  const body = (await res.json()) as { gems?: { key: string; version: string }[] };
  const versions = (body.gems ?? []).filter((g) => g.key === key).map((g) => g.version);
  if (!versions.length) throw new Error(`no published gem "${key}" found — check the key, or pin a version: agentgem get ${key}@<version>`);
  return versions.sort(compareVersionsDesc)[0];
}

export interface GetDeps { fetchArchive?: typeof fetchHostedArchive; create?: typeof createWorkspace; http?: ArchiveHttp }

export async function runGetCommand(argv: string[], deps: GetDeps = {}): Promise<number> {
  const args = parseGetArgs(argv);
  if (args.help) { console.log(GET_HELP); return 0; }
  if (!args.key) { console.error("usage: agentgem get <key>[@<version>]  (see agentgem get --help)"); return 1; }
  const http = deps.http ?? DEFAULT_HTTP;
  const fetchArchive = deps.fetchArchive ?? fetchHostedArchive;
  const create = deps.create ?? createWorkspace;
  try {
    const version = args.version ?? await resolveVersion(args.key, args.endpoint, http);
    const bytes = await fetchArchive({ key: args.key, version, endpoint: args.endpoint, http });
    const { gem } = importGem(bytes); // verifies gem.lock; throws on tamper
    if (hasExecutable(gem) && !args.yes) {
      const e = executableArtifacts(gem);
      console.error(`"${args.key}" runs executable artifacts on install:`);
      if (e.mcp.length) console.error(`  MCP servers: ${e.mcp.join(", ")}`);
      if (e.hooks.length) console.error(`  hooks: ${e.hooks.join(", ")}`);
      console.error(`Re-run with --yes to import it anyway.`);
      return 1;
    }
    const name = args.key.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "installed-gem";
    create(name, gem, { version });
    console.log(`✓ Imported "${args.key}" v${version} into AgentGem (workspace "${name}").`);
    console.log(`  Run \`agentgem\` and open Workspaces to use it.`);
    return 0;
  } catch (e) {
    console.error(`agentgem get: ${(e as Error).message}`);
    return 1;
  }
}
