// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/aggregator/src/ingestAdoption.ts
import { verify } from "@agentgem/model";
import { canonicalJSON, type GemAdoption } from "@agentgem/insight";
import type { AppDb } from "./schema.js";
import { projectGemAdoption } from "./projectAdoption.js";

export function verifyGemAdoption(a: GemAdoption): { ok: true } | { ok: false; reason: "bad-signature" } {
  const { signature, ...rest } = a;
  return verify(a.producer.publicKey, canonicalJSON(rest), signature) ? { ok: true } : { ok: false, reason: "bad-signature" };
}

export type AdoptResult =
  | { accepted: true; idempotent: boolean }
  | { accepted: false; rejected: "bad-signature" };

export async function ingestGemAdoption(db: AppDb, a: GemAdoption): Promise<AdoptResult> {
  const v = verifyGemAdoption(a);
  if (!v.ok) return { accepted: false, rejected: v.reason };
  const { idempotent } = await projectGemAdoption(db, a);
  return { accepted: true, idempotent };
}
