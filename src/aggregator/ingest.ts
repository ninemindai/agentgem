// src/aggregator/ingest.ts
import { verify } from "../gem/identity.js";
import { canonicalJSON, type UsageAttestation } from "../gem/attestation.js";
import type { DB } from "./db.js";
import { projectAttestation } from "./project.js";

export type VerifyResult = { ok: true } | { ok: false; reason: "bad-signature" | "inconsistent" };

export function verifyAttestation(att: UsageAttestation): VerifyResult {
  const { signature, ...rest } = att;
  if (!verify(att.producer.publicKey, canonicalJSON(rest), signature)) return { ok: false, reason: "bad-signature" };
  const cap = att.source.scan.sessions;
  for (const row of [...att.ingredients.skills, ...att.ingredients.mcps]) {
    if (row.sessions > cap || row.invocations < row.sessions || row.sessions < 0 || row.invocations < 0) {
      return { ok: false, reason: "inconsistent" };
    }
  }
  return { ok: true };
}

export type IngestResult =
  | { accepted: true; id: string; publicIngredients: number; privateCount: number; idempotent: boolean }
  | { accepted: false; rejected: "bad-signature" | "inconsistent" };

export async function ingestAttestation(db: DB, att: UsageAttestation): Promise<IngestResult> {
  const v = verifyAttestation(att);
  if (!v.ok) return { accepted: false, rejected: v.reason };
  const prior = await db.query<{ id: string; private_count: number }>(
    "select id, private_count from attestations where gem_digest = $1", [att.gem.digest]);
  if (prior.rows.length > 0) {
    const row = prior.rows[0];
    const pub = await db.query<{ c: number }>("select count(*)::int as c from usage_edges where attestation_id = $1", [row.id]);
    return { accepted: true, id: row.id, publicIngredients: pub.rows[0].c, privateCount: row.private_count, idempotent: true };
  }
  const p = await projectAttestation(db, att);
  return { accepted: true, ...p, idempotent: false };
}
