// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator/project.ts
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
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
  await db.insert(producers).values({ pubkey: att.producer.publicKey, attestCount: 1 })
    .onConflictDoUpdate({ target: producers.pubkey, set: { attestCount: sql`${producers.attestCount} + 1` } });
  await db.insert(attestations).values({
    id, gemName: att.gem.name, gemDigest: att.gem.digest, producerPubkey: att.producer.publicKey,
    harnessId: att.source.harness.id, models: att.source.models, scanSessions: att.source.scan.sessions,
    scanSpanDays: att.source.scan.spanDays, signalDigest: att.evidence.signalDigest, privateCount,
  });
  for (const n of nodes) {
    await db.insert(ingredients).values({ id: n.id, kind: n.kind, idKind: n.idKind })
      .onConflictDoUpdate({ target: ingredients.id, set: { lastSeen: sql`now()` } });
    await db.insert(usageEdges).values({ attestationId: id, ingredientId: n.id, invocations: n.invocations, sessions: n.sessions })
      .onConflictDoNothing();
  }
  // v2 attestations carry per-model outcome counts → the cross-model benchmark.
  for (const h of att.source.outcomeHistogram ?? []) {
    await db.insert(modelOutcomes).values({ attestationId: id, model: h.model, mostly: h.mostly, partially: h.partially, notAchieved: h.not })
      .onConflictDoNothing();
  }
  return { id, publicIngredients: nodes.length, privateCount };
}
