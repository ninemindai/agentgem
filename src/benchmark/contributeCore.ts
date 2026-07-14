// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/benchmark/contributeCore.ts
//
// Local-core contribution flow: enumerate the producer's published gems (hosted
// aggregator), and for each one that ALSO has a local workspace, post an anonymous,
// INGREDIENTS-ONLY usage attestation back to the aggregator. There is deliberately
// NO LLM judge and NO outcome facets here — see the design spec's "Design
// refinements #2": outcomes were dropped after eng review because a producer
// self-reporting per-model success rates is neither trustworthy nor cheap. We
// contribute only the tamper-evident ingredient counts the local scan already has.
//
// One scan feeds every gem: transcripts are scanned ONCE into a shared WorkflowSignal
// and reused across the owned-gem loop (counts are per-ingredient, gem-independent).
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readWorkspace } from "@agentgem/base";
import { readGemArchive, computeLock } from "@agentgem/archive";
import {
  scanWorkflow,
  buildAttestation,
  signAttestation,
  postAttestation,
  hostedIngestEndpoint,
  claudeTranscriptsForCwd,
  type WorkflowSignal,
} from "@agentgem/insight";
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { loadOrCreateIdentity, type Gem, type Identity } from "@agentgem/model";
import { benchmarkContribute } from "./config.js";
import { postMyGems, type OwnedGem } from "../gem/myGemsClient.js";

export interface ContributeResult {
  gem: string;
  status: "ingested" | "updated" | "skipped" | "failed";
  reason?: string;
}

export interface ContributeDeps {
  enabled: () => boolean;
  identity: Identity;
  listOwned: () => Promise<OwnedGem[]>;
  // #3: readGemArchive(readWorkspace(name).files) — readWorkspace has NO `.gem`.
  // Returns null when there is no local workspace for that name.
  readGem: (name: string) => Gem | null;
  // Single global scan of the local transcript corpus; done once, reused across gems.
  scan: () => WorkflowSignal;
  // #5: computeLock(files).gemDigest over the workspace archive file map. There is
  // no `gemDigestOf`; the digest is derived from the workspace, keyed by gem name.
  digestOf: (gem: Gem) => string;
  build: typeof buildAttestation;
  sign: (att: ReturnType<typeof buildAttestation>) => ReturnType<typeof buildAttestation>;
  post: (att: ReturnType<typeof buildAttestation>) => Promise<{ ingestId: string } | { skipped: true }>;
}

export function defaultDeps(): ContributeDeps {
  const identity = loadOrCreateIdentity();
  const cwd = process.cwd();
  return {
    enabled: () => benchmarkContribute(),
    identity,
    listOwned: () => postMyGems({ identity }),
    readGem: (name) => {
      try {
        return readGemArchive(readWorkspace(name).files);
      } catch {
        return null;
      }
    },
    scan: () => {
      // Mirror mcpServer.realDeps: the scan MUST carry the GLOBAL inventory or every
      // global skill/mcp falls to `unresolved` and the ingredient counts come back
      // empty. retainSequences:false — we want ingredient counts, not judged sequences.
      const global = introspectConfig();
      const paths = claudeTranscriptsForCwd(join(homedir(), ".claude"), cwd);
      return scanWorkflow(
        paths,
        { project: introspectProject(cwd), global: { skills: global.skills, mcpServers: global.mcpServers, hooks: global.hooks } },
        { retainSequences: false },
      );
    },
    // Random per-call salt hashes private ids; it is NOT stored in the attestation.
    // Let any failure propagate to the per-gem `catch` in contribute() — swallowing
    // it here would post an attestation with an empty digest instead of reporting
    // the gem as `failed`.
    digestOf: (gem) => computeLock(readWorkspace(gem.name).files).gemDigest,
    build: buildAttestation,
    sign: (att) => signAttestation(att, identity, Date.now()),
    // The contribute flow is consent-gated (deps.enabled), so it deliberately posts to
    // the hosted aggregator — pass the endpoint explicitly rather than relying on a
    // default (postAttestation skips when unconfigured, to keep other callers opt-in).
    post: (att) => postAttestation({ attestation: att, endpoint: hostedIngestEndpoint() }),
  };
}

export async function contribute(
  deps: ContributeDeps = defaultDeps(),
): Promise<{ enabled: boolean; results: ContributeResult[] }> {
  if (!deps.enabled()) return { enabled: false, results: [] };
  const owned = await deps.listOwned();
  if (owned.length === 0) return { enabled: true, results: [] };

  const signal = deps.scan(); // ONCE, reused across every owned gem
  const results: ContributeResult[] = [];
  for (const o of owned) {
    const gem = deps.readGem(o.name);
    // #9: only attest an owned gem when a local workspace exists AND the rebuilt gem's
    // name matches — don't attest an unrelated same-named workspace.
    if (!gem || gem.name !== o.name) {
      results.push({ gem: o.name, status: "skipped", reason: "no local workspace" });
      continue;
    }
    try {
      // NO facets — ingredients-only. account:null — anonymous producer attestation.
      const att = deps.sign(
        deps.build({ gem, signal, gemDigest: deps.digestOf(gem), salt: randomBytes(16).toString("hex"), account: null }),
      );
      const r = await deps.post(att);
      // postAttestation returns only { ingestId }, so we can't see the aggregator's
      // updated flag — report `ingested` for any accepted post (updated is a P3 follow-up).
      results.push(
        "skipped" in r ? { gem: o.name, status: "skipped", reason: "ingest disabled" } : { gem: o.name, status: "ingested" },
      );
    } catch (e) {
      results.push({ gem: o.name, status: "failed", reason: (e as Error).message });
    }
  }
  return { enabled: true, results };
}
