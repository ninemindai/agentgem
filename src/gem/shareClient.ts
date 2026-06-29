export type ShareHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

const defaultHttp: ShareHttp = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, json: () => res.json() };
};

type Counts = { breadth: number; battleTested: number; portable: number };

// Resolve the backend base: explicit endpoint -> AGENTGEM_AGGREGATOR_URL ->
// the in-process aggregator (self) when a local port is known -> skip.
function resolveBase(endpoint: string | undefined, port: number | undefined): string {
  if (endpoint !== undefined) return endpoint;
  if (process.env.AGENTGEM_AGGREGATOR_URL) return process.env.AGENTGEM_AGGREGATOR_URL;
  if (port) return `http://127.0.0.1:${port}`;
  return "";
}

export async function postShare(args: {
  counts: Counts; generatedAtMs: number; endpoint?: string; port?: number; http?: ShareHttp;
}): Promise<{ id: string; url: string } | { skipped: true }> {
  const base = resolveBase(args.endpoint, args.port);
  if (!base) return { skipped: true };
  const http = args.http ?? defaultHttp;
  const res = await http(`${base}/api/aggregator/share`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "certificate", counts: args.counts, generatedAtMs: args.generatedAtMs }),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`share ${res.status}`);
  const body = (await res.json()) as { id?: string; url?: string };
  if (!body.id || !body.url) throw new Error("share: response missing id/url");
  return { id: body.id, url: body.url };
}
