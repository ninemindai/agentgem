// src/aggregator/project.ts
import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";
import type { UsageAttestation } from "../gem/attestation.js";

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

export async function projectAttestation(db: DB, att: UsageAttestation): Promise<{ id: string; publicIngredients: number; privateCount: number }> {
  const { nodes, privateCount } = publicNodes(att);
  const id = randomUUID();
  await db.query("insert into producers(pubkey, attest_count) values ($1, 1) on conflict (pubkey) do update set attest_count = producers.attest_count + 1", [att.producer.publicKey]);
  await db.query(
    `insert into attestations(id, gem_name, gem_digest, producer_pubkey, harness_id, models, scan_sessions, scan_span_days, signal_digest, private_count)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, att.gem.name, att.gem.digest, att.producer.publicKey, att.source.harness.id, att.source.models,
     att.source.scan.sessions, att.source.scan.spanDays, att.evidence.signalDigest, privateCount]);
  for (const n of nodes) {
    await db.query(
      "insert into ingredients(id, kind, id_kind) values ($1,$2,$3) on conflict (id) do update set last_seen = now()",
      [n.id, n.kind, n.idKind]);
    await db.query(
      "insert into usage_edges(attestation_id, ingredient_id, invocations, sessions) values ($1,$2,$3,$4) on conflict do nothing",
      [id, n.id, n.invocations, n.sessions]);
  }
  return { id, publicIngredients: nodes.length, privateCount };
}
