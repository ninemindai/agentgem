export interface ProviderRow { id: string; implemented: boolean; enabled: boolean; connected: boolean }
export interface Candidate { key: string; text: string; kind: string; source: string }
export interface ProviderCfg { enabled: boolean; apiKey: string; baseUrl?: string; userId?: string }

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };

export const listProviders = (b: string): Promise<{ providers: ProviderRow[] }> =>
  fetch(`${b}/api/memory/providers`).then(j);
export const saveProvider = (b: string, id: string, config: ProviderCfg): Promise<{ ok: boolean; detail?: string }> =>
  fetch(`${b}/api/memory/providers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, config }) }).then(j);
export const pull = (b: string, id: string): Promise<{ pulled: number }> =>
  fetch(`${b}/api/memory/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).then(j);
export const getOutbox = (b: string): Promise<{ candidates: Candidate[] }> =>
  fetch(`${b}/api/memory/outbox`).then(j);
export const refreshOutbox = (b: string): Promise<{ candidates: Candidate[] }> =>
  fetch(`${b}/api/memory/outbox/refresh`, { method: "POST" }).then(j);
export const pushApproved = (b: string, keys: string[]): Promise<{ pushed: number; skipped: number }> =>
  fetch(`${b}/api/memory/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys }) }).then(j);
