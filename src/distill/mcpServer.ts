// src/distill/mcpServer.ts
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ConfigInventory, Gem } from "../gem/types.js";
import type { WorkflowSignal } from "../gem/workflowScan.js";
import { buildGem, type GemSelection } from "../gem/buildGem.js";
import { canonicalHarness, canonicalModel, canonicalMcpServer, canonicalSkill } from "../gem/canonicalize.js";
import { buildAttestation, signAttestation, canonicalJSON, type UsageAttestation } from "../gem/attestation.js";
import { writeAttestedArchive } from "../gem/attestationArchive.js";
import { loadOrCreateIdentity } from "../gem/identity.js";
import { postAttestation } from "../gem/ingestClient.js";

// ---- pure handlers (unit-tested) ----
export function inspectIngredientsTool(input: { inventory: ConfigInventory; signal: WorkflowSignal }) {
  return {
    harness: canonicalHarness(input.signal.flavor),
    models: input.signal.models.map((m) => canonicalModel(m.id).id),
    // Preview ids use an empty salt — these are never published, only shown to the user.
    skills: input.inventory.skills.map((s) => canonicalSkill(s, "")),
    mcps: input.inventory.mcpServers.map((m) => canonicalMcpServer(m, "")),
  };
}

export function buildAttestationTool(input: { inventory: ConfigInventory; signal: WorkflowSignal; selection: GemSelection; salt: string; account?: { provider: string; login: string } | null }) {
  const gem: Gem = buildGem(input.inventory, input.selection, { createdFrom: input.signal.flavor });
  const gemDigest = `sha256:${createHash("sha256").update(canonicalJSON(gem)).digest("hex")}`;
  const attestation = buildAttestation({ gem, signal: input.signal, gemDigest, salt: input.salt, account: input.account ?? null });
  const ids = [...attestation.ingredients.skills, ...attestation.ingredients.mcps].map((i) => i.id);
  return { attestation, gemPreview: gem, willPublish: ids };
}

// ---- runtime context loader (real env) ----
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { introspectConfig, introspectProject } from "../gem/introspect.js";
import { scanWorkflow, claudeTranscriptsForCwd } from "../gem/workflowScan.js";

export interface ToolDeps {
  loadContext: (cwd: string) => { inventory: ConfigInventory; signal: WorkflowSignal };
  publish?: (gem: Gem, files: Record<string, string>) => Promise<{ ref: string }>;
  salt?: string; // fixed salt for reproducible builds/tests; else random per call
  token?: string;
}

export function realDeps(): ToolDeps {
  return {
    loadContext(cwd) {
      const inventory = introspectConfig();
      const scanInv = { project: introspectProject(cwd) };
      const paths = claudeTranscriptsForCwd(join(homedir(), ".claude"), cwd);
      return { inventory, signal: scanWorkflow(paths, scanInv, { retainSequences: false }) };
    },
    // Distribution-publish to the GitHub registry is intentionally NOT wired here yet.
    // It must first fetch the LIVE registry index — publishing against an empty index
    // would overwrite and erase other published gems (data loss). Until that lands,
    // sign_and_publish performs only the data-critical ingest POST; registry
    // distribution is a tracked follow-up.
    publish: undefined,
    token: process.env.AGENTGEM_INGEST_TOKEN,
  };
}

// ---- dispatch (unit-tested with injected deps) ----
export async function dispatchTool(name: string, args: Record<string, unknown>, deps: ToolDeps): Promise<unknown> {
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
  switch (name) {
    case "scan_workflow": {
      const { signal } = deps.loadContext(cwd);
      return { signal, signalDigest: `sha256:${createHash("sha256").update(canonicalJSON(signal)).digest("hex")}` };
    }
    case "inspect_ingredients":
      return inspectIngredientsTool(deps.loadContext(cwd));
    case "build_attestation": {
      const { inventory, signal } = deps.loadContext(cwd);
      const salt = deps.salt ?? randomBytes(16).toString("hex");
      return buildAttestationTool({ inventory, signal, selection: (args.selection ?? { all: true }) as GemSelection, salt, account: (args.account as { provider: string; login: string } | null) ?? null });
    }
    case "sign_and_publish": {
      const { inventory, signal } = deps.loadContext(cwd);
      const gem = buildGem(inventory, (args.selection ?? { all: true }) as GemSelection, { createdFrom: signal.flavor });
      return signAndPublishTool({ gem, attestation: args.attestation as UsageAttestation, token: deps.token }, { publish: deps.publish ? (files) => deps.publish!(gem, files) : undefined });
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

const TOOLS = [
  { name: "scan_workflow", description: "Scan local transcripts into a redacted workflow signal.", inputSchema: { type: "object", properties: { cwd: { type: "string" } } } },
  { name: "inspect_ingredients", description: "Canonical fingerprints of available harness/models/skills/mcps.", inputSchema: { type: "object", properties: { cwd: { type: "string" } } } },
  { name: "build_attestation", description: "Build the unsigned usage attestation + a 'what will leave your machine' preview.", inputSchema: { type: "object", properties: { selection: { type: "object" }, cwd: { type: "string" } }, required: ["selection"] } },
  { name: "sign_and_publish", description: "Sign the attestation, embed it in the Gem archive, and POST it to the ingest endpoint (skipped if unconfigured). Registry distribution is currently disabled; do not report a published distribution unless a publishedRef is returned.", inputSchema: { type: "object", properties: { attestation: { type: "object" }, selection: { type: "object" } }, required: ["attestation"] } },
];

export async function main(): Promise<void> {
  const server = new Server({ name: "agentgem-distill", version: "0.1.0" }, { capabilities: { tools: {} } });
  const deps = realDeps();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await dispatchTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, deps);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  await server.connect(new StdioServerTransport());
}

// sign_and_publish is environment-touching; export it for integration tests with injected deps.
export async function signAndPublishTool(
  input: { gem: Gem; attestation: UsageAttestation; identityDir?: string; token?: string },
  deps: { publish?: (files: Record<string, string>) => Promise<{ ref: string }>; ingestHttp?: Parameters<typeof postAttestation>[0]["http"] } = {},
): Promise<{ publishedRef?: string; gemDigest: string; signature: string; ingestId?: string }> {
  const identity = loadOrCreateIdentity(input.identityDir);
  const signed = signAttestation(input.attestation, identity, Date.now());
  const { files } = writeAttestedArchive(input.gem, signed, identity);
  const lock = JSON.parse(files["gem.lock"]) as { gemDigest: string; signature: string };
  const published = deps.publish ? await deps.publish(files) : undefined;
  const ingest = await postAttestation({ attestation: signed, token: input.token, http: deps.ingestHttp });
  return { publishedRef: published?.ref, gemDigest: lock.gemDigest, signature: lock.signature, ingestId: "ingestId" in ingest ? ingest.ingestId : undefined };
}

if (import.meta.url === `file://${process.argv[1]}`) { void main(); }
