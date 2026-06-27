// src/aggregator/ingest.ts
import { verify } from "../gem/identity.js";
import { canonicalJSON, type UsageAttestation } from "../gem/attestation.js";

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
