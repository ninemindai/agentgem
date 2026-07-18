// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The neutral binding wire-contract: the pure payload the client signs and the server verifies for
// pubkey->account binding. The DB-backed recordBinding lives in the aggregator and imports this.
import { createHash } from "node:crypto";
import { canonicalJSON } from "@agentgem/insight";

/** The exact string the client signs and the server verifies. Signs over sha256(token) — never the
 *  raw token — so the secret stays out of the canonical (loggable) payload. */
export function bindSigningPayload(pubkey: string, token: string, signedAt: number): string {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return canonicalJSON({ pubkey, signedAt, tokenHash });
}
