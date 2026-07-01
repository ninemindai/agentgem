// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/adoption.ts
import { canonicalJSON } from "./attestation.js";
import type { Identity } from "@agentgem/model";
import type { IngestHttp } from "./ingestClient.js";

export interface GemAdoption {
  formatVersion: 1;
  gemKey: string;          // registry key "@scope/name"
  version: string;         // installed version
  gemDigest: string;       // the installed gem's digest
  event: "install";        // v1 always "install" (apply/run deferred)
  producer: { publicKey: string; account: { provider: string; login: string } | null };
  signedAt: number;
  signature: string;
}

export function buildGemAdoption(args: {
  gemKey: string; version: string; gemDigest: string;
  account?: { provider: string; login: string } | null;
}): GemAdoption {
  return {
    formatVersion: 1, gemKey: args.gemKey, version: args.version, gemDigest: args.gemDigest,
    event: "install", producer: { publicKey: "", account: args.account ?? null }, signedAt: 0, signature: "",
  };
}

export function signGemAdoption(a: GemAdoption, identity: Identity, signedAt = 0): GemAdoption {
  const filled = { ...a, producer: { ...a.producer, publicKey: identity.publicKey }, signedAt };
  const { signature, ...rest } = filled;
  return { ...filled, signature: identity.sign(canonicalJSON(rest)) };
}

export async function postGemAdoption(args: {
  adoption: GemAdoption; endpoint?: string; token?: string; http?: IngestHttp;
}): Promise<{ ingestId: string } | { skipped: true }> {
  const endpoint = args.endpoint ?? process.env.AGENTGEM_ADOPT_URL ?? "";
  if (!endpoint) return { skipped: true };
  const http = args.http ?? (async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, json: () => res.json() };
  });
  const res = await http(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${args.token ?? ""}` },
    body: canonicalJSON(args.adoption),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`adopt ${res.status}`);
  const body = (await res.json()) as { ingestId?: string };
  if (!body.ingestId) throw new Error("adopt: response missing ingestId");
  return { ingestId: body.ingestId };
}
