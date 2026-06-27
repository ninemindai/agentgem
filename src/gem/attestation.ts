// src/gem/attestation.ts
import { createHash } from "node:crypto";
import type { Gem, McpServerArtifact, SkillArtifact } from "./types.js";
import type { WorkflowSignal } from "./workflowScan.js";
import { CANONICALIZER_VERSION, canonicalHarness, canonicalModel, canonicalMcpServer, canonicalSkill, saltedHash } from "./canonicalize.js";
import type { Identity } from "./identity.js";

export interface EventTuple { saltedSessionId: string; ingredientId: string; count: number; coarseTimeBucket: string }
export interface UsageAttestation {
  formatVersion: number;
  canonicalizerVersion: number;
  gem: { name: string; digest: string };
  producer: { publicKey: string; account: { provider: string; login: string } | null };
  source: { harness: { id: string }; models: string[]; scan: { sessions: number; spanDays: number; firstMs: number; lastMs: number } };
  ingredients: {
    skills: { id: string; idKind: string; public: boolean; invocations: number; sessions: number }[];
    mcps: { id: string; idKind: string; public: boolean; invocations: number; sessions: number }[];
  };
  evidence: { signalDigest: string; salt: string; tuples: EventTuple[] };
  signedAt: number;
  signature: string;
}

export function canonicalJSON(value: unknown): string {
  const seen = new WeakSet();
  const norm = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) throw new Error("circular");
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = norm(o[k]); return acc; }, {});
  };
  return JSON.stringify(norm(value));
}

function coarseBucket(ms: number): string { return new Date(ms).toISOString().slice(0, 7); } // YYYY-MM

export function buildAttestation(args: {
  gem: Gem; signal: WorkflowSignal; gemDigest: string; salt: string;
  account?: { provider: string; login: string } | null;
}): UsageAttestation {
  const { gem, signal, gemDigest, salt } = args;
  // Map gem artifacts → canonical ids, then attach counts from the signal (counts are the source of truth).
  const usageByName = new Map(signal.artifacts.map((a) => [`${a.type}:${a.name}`, a]));
  const tuples: EventTuple[] = [];
  const bucket = coarseBucket(signal.sessions.lastMs);

  function mkRow(canon: { id: string; idKind: string; public: boolean }, key: string) {
    const u = usageByName.get(key);
    const invocations = u?.invocations ?? 0;
    const sessions = u?.sessionsUsedIn ?? 0;
    // Emit one salted-session tuple per session this ingredient appeared in (deterministic indices).
    for (let i = 0; i < sessions; i++) {
      const per = Math.floor(invocations / sessions) + (i < invocations % sessions ? 1 : 0);
      tuples.push({ saltedSessionId: saltedHash(salt, `${canon.id}#${i}`), ingredientId: canon.id, count: per, coarseTimeBucket: bucket });
    }
    return { id: canon.id, idKind: canon.idKind, public: canon.public, invocations, sessions };
  }

  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill")
    .map((s) => mkRow(canonicalSkill(s), `skill:${s.name}`));
  const mcps = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server")
    .map((m) => mkRow(canonicalMcpServer(m), `mcp_server:${m.name}`));

  const att: UsageAttestation = {
    formatVersion: 1,
    canonicalizerVersion: CANONICALIZER_VERSION,
    gem: { name: gem.name, digest: gemDigest },
    producer: { publicKey: "", account: args.account ?? null },
    source: {
      harness: { id: canonicalHarness(signal.flavor).id },
      models: signal.models.map((m) => canonicalModel(m.id).id),
      scan: { sessions: signal.sessions.scanned, spanDays: signal.sessions.spanDays, firstMs: signal.sessions.firstMs, lastMs: signal.sessions.lastMs },
    },
    ingredients: { skills, mcps },
    evidence: { signalDigest: "", salt, tuples },
    signedAt: 0,
    signature: "",
  };
  att.evidence.signalDigest = `sha256:${createHash("sha256").update(canonicalJSON(att.evidence.tuples)).digest("hex")}`;
  return att;
}

export function signAttestation(att: UsageAttestation, identity: Identity, signedAt = 0): UsageAttestation {
  const filled = { ...att, producer: { ...att.producer, publicKey: identity.publicKey }, signedAt };
  const { signature, ...rest } = filled;
  return { ...filled, signature: identity.sign(canonicalJSON(rest)) };
}
