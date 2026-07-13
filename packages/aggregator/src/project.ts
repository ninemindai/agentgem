// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator/project.ts
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { AppDb } from "./schema.js";
import { producers, attestations, ingredients, usageEdges, modelOutcomes } from "./schema.js";
import type { UsageAttestation } from "@agentgem/insight";

interface Node { id: string; kind: string; idKind: string; invocations: number; sessions: number }

function publicNodes(att: UsageAttestation): { nodes: Node[]; privateCount: number } {
  const s = att.source.scan.sessions;
  const nodes: Node[] = [
    { id: att.source.harness.id, kind: "harness", idKind: "known", invocations: s, sessions: s },
    ...att.source.models.map((m) => ({ id: m, kind: "model", idKind: "known", invocations: s, sessions: s })),
  ];
  let privateCount = 0;
  for (const r of att.ingredients.skills) r.public ? nodes.push({ id: r.id, kind: "skill", idKind: r.idKind, invocations: r.invocations, sessions: r.sessions }) : privateCount++;
  for (const r of att.ingredients.mcps) r.public ? nodes.push({ id: r.id, kind: "mcp", idKind: r.idKind, invocations: r.invocations, sessions: r.sessions }) : privateCount++;
  return { nodes, privateCount };
}

export async function projectAttestation(db: AppDb, att: UsageAttestation): Promise<{ id: string; publicIngredients: number; privateCount: number }> {
  const { nodes, privateCount } = publicNodes(att);
  const id = randomUUID();
  // All five table mutations run in one transaction so the caller gets either a fully-committed record
  // or a clean error. Without it, a failure after the attestations row (e.g. mid usage_edges) left an
  // orphaned attestation — and a bumped producer attest_count — that downstream aggregates counted, and
  // that could not be retried because attestations.gem_digest is UNIQUE.
  await db.transaction(async (tx) => {
    await tx.insert(producers).values({ pubkey: att.producer.publicKey, attestCount: 1 })
      .onConflictDoUpdate({ target: producers.pubkey, set: { attestCount: sql`${producers.attestCount} + 1` } });
    await tx.insert(attestations).values({
      id, gemName: att.gem.name, gemDigest: att.gem.digest, producerPubkey: att.producer.publicKey,
      harnessId: att.source.harness.id, models: att.source.models, scanSessions: att.source.scan.sessions,
      scanSpanDays: att.source.scan.spanDays, signalDigest: att.evidence.signalDigest, privateCount,
    });
    for (const n of nodes) {
      await tx.insert(ingredients).values({ id: n.id, kind: n.kind, idKind: n.idKind })
        .onConflictDoUpdate({ target: ingredients.id, set: { lastSeen: sql`now()` } });
      await tx.insert(usageEdges).values({ attestationId: id, ingredientId: n.id, invocations: n.invocations, sessions: n.sessions })
        .onConflictDoNothing();
    }
    // v2 attestations carry per-model outcome counts → the cross-model benchmark.
    for (const h of att.source.outcomeHistogram ?? []) {
      await tx.insert(modelOutcomes).values({ attestationId: id, model: h.model, mostly: h.mostly, partially: h.partially, notAchieved: h.not })
        .onConflictDoNothing();
    }
  });
  return { id, publicIngredients: nodes.length, privateCount };
}

// A resubmit from the same producer for the same gem_digest re-projects the attestation's
// usage data in place: same row, refreshed edges. ingested_at is intentionally NOT touched
// here (#4) — it's the adoption-bucket time-series dimension, and attest_count is NOT bumped
// (that would double-count a producer who just resent the same-shaped signal).
export async function updateAttestation(db: AppDb, id: string, att: UsageAttestation): Promise<{ id: string; publicIngredients: number; privateCount: number }> {
  const { nodes, privateCount } = publicNodes(att);
  await db.transaction(async (tx) => {
    await tx.update(attestations).set({
      gemName: att.gem.name, harnessId: att.source.harness.id, models: att.source.models,
      scanSessions: att.source.scan.sessions, scanSpanDays: att.source.scan.spanDays,
      signalDigest: att.evidence.signalDigest, privateCount, // NOTE: ingested_at intentionally NOT touched (#4)
    }).where(eq(attestations.id, id));
    await tx.delete(usageEdges).where(eq(usageEdges.attestationId, id));
    await tx.delete(modelOutcomes).where(eq(modelOutcomes.attestationId, id));
    for (const n of nodes) {
      await tx.insert(ingredients).values({ id: n.id, kind: n.kind, idKind: n.idKind })
        .onConflictDoUpdate({ target: ingredients.id, set: { lastSeen: sql`now()` } });
      await tx.insert(usageEdges).values({ attestationId: id, ingredientId: n.id, invocations: n.invocations, sessions: n.sessions });
    }
    for (const h of att.source.outcomeHistogram ?? []) {
      await tx.insert(modelOutcomes).values({ attestationId: id, model: h.model, mostly: h.mostly, partially: h.partially, notAchieved: h.not });
    }
  });
  return { id, publicIngredients: nodes.length, privateCount };
}
