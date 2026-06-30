// src/gem/attestation.ts
import { createHash } from "node:crypto";
import type { Gem, McpServerArtifact, SkillArtifact } from "@agentgem/model";
import type { WorkflowSignal } from "./workflowScan.js";
import { CANONICALIZER_VERSION, canonicalHarness, canonicalModel, canonicalMcpServer, canonicalSkill } from "@agentgem/model";
import type { Identity } from "@agentgem/model";

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
  evidence: { signalDigest: string };
  signedAt: number;
  signature: string;
}

export function canonicalJSON(value: unknown): string {
  const seen = new WeakSet();
  const norm = (v: unknown): unknown => {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("canonicalJSON: non-finite number");
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) throw new Error("circular");
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(norm);
    const o = v as Record<string, unknown>;
    // Object.create(null): no prototype, so a parsed-untrusted "__proto__" key is an own
    // property here and cannot pollute Object.prototype during canonicalization.
    return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = norm(o[k]); return acc; }, Object.create(null) as Record<string, unknown>);
  };
  return JSON.stringify(norm(value));
}

export function buildAttestation(args: {
  gem: Gem; signal: WorkflowSignal; gemDigest: string; salt: string;
  account?: { provider: string; login: string } | null;
}): UsageAttestation {
  const { gem, signal, gemDigest, salt } = args;
  // Map gem artifacts → canonical ids, then attach counts from the signal (counts are the source of truth).
  const usageByName = new Map(signal.artifacts.map((a) => [`${a.type}:${a.name}`, a]));

  // `salt` is still used for private-id hashing (canonicalMcpServer/canonicalSkill) but is NOT
  // stored anywhere in the attestation — private ids are opaque and withholding the salt is more
  // private. We publish aggregate rows only (no synthetic per-session tuples).
  function mkRow(canon: { id: string; idKind: string; public: boolean }, key: string) {
    const u = usageByName.get(key);
    return { id: canon.id, idKind: canon.idKind, public: canon.public, invocations: u?.invocations ?? 0, sessions: u?.sessionsUsedIn ?? 0 };
  }

  const skills = gem.artifacts.filter((a): a is SkillArtifact => a.type === "skill")
    .map((s) => mkRow(canonicalSkill(s, salt), `skill:${s.name}`));
  const mcps = gem.artifacts.filter((a): a is McpServerArtifact => a.type === "mcp_server")
    .map((m) => mkRow(canonicalMcpServer(m, salt), `mcp_server:${m.name}`));

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
    // Tamper-evident commitment to the published aggregate ingredient rows (self-consistency,
    // NOT proof of real use). Carries no raw signal, prompts, paths, or file contents.
    evidence: { signalDigest: `sha256:${createHash("sha256").update(canonicalJSON({ skills, mcps })).digest("hex")}` },
    signedAt: 0,
    signature: "",
  };
  return att;
}

export function signAttestation(att: UsageAttestation, identity: Identity, signedAt = 0): UsageAttestation {
  const filled = { ...att, producer: { ...att.producer, publicKey: identity.publicKey }, signedAt };
  const { signature, ...rest } = filled;
  return { ...filled, signature: identity.sign(canonicalJSON(rest)) };
}
