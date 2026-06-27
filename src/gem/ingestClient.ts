import { canonicalJSON, type UsageAttestation } from "./attestation.js";

export type IngestHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultHttp: IngestHttp = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, json: () => res.json() };
};

export async function postAttestation(args: {
  attestation: UsageAttestation; endpoint?: string; token?: string; http?: IngestHttp;
}): Promise<{ ingestId: string } | { skipped: true }> {
  const endpoint = args.endpoint ?? process.env.AGENTGEM_INGEST_URL ?? "";
  if (!endpoint) return { skipped: true };
  const http = args.http ?? defaultHttp;
  const res = await http(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${args.token ?? ""}` },
    body: canonicalJSON(args.attestation),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`ingest ${res.status}`);
  const body = (await res.json()) as { ingestId?: string };
  return { ingestId: body.ingestId ?? "" };
}
