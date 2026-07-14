// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { canonicalJSON, type UsageAttestation } from "./attestation.js";

export type IngestHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultHttp: IngestHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, json: () => res.json() };
};

const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";

// The hosted-aggregator ingest endpoint, for callers that DELIBERATELY contribute to
// the public benchmark (the consent-gated producer flow). Kept separate from the
// opt-in default in postAttestation so an unconfigured caller never phones home
// implicitly — pass this explicitly as `endpoint` when you mean to reach the hosted
// aggregator.
export function hostedIngestEndpoint(): string {
  if (process.env.AGENTGEM_INGEST_URL) return process.env.AGENTGEM_INGEST_URL; // full-URL override
  return `${process.env.AGENTGEM_AGGREGATOR_URL || DEFAULT_AGGREGATOR_URL}/api/aggregator/ingest`;
}

export async function postAttestation(args: {
  attestation: UsageAttestation; endpoint?: string; token?: string; http?: IngestHttp;
}): Promise<{ ingestId: string } | { skipped: true }> {
  // Opt-in: unconfigured (no explicit endpoint, no AGENTGEM_INGEST_URL) ⇒ skip, never
  // phone home. Callers that mean to reach the hosted aggregator pass hostedIngestEndpoint().
  const endpoint = args.endpoint ?? process.env.AGENTGEM_INGEST_URL ?? "";
  if (!endpoint) return { skipped: true };
  const http = args.http ?? defaultHttp;
  const res = await http(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${args.token ?? ""}` },
    body: canonicalJSON(args.attestation),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`ingest ${res.status}`);
  const body = (await res.json()) as { ingestId?: string; accepted?: boolean };
  if (body.accepted === false) return { skipped: true }; // policy reject (e.g. org-forbidden) — nothing to do
  if (!body.ingestId) throw new Error("ingest: response missing ingestId");
  return { ingestId: body.ingestId };
}
