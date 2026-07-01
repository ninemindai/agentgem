export interface DreamStatus { enabled: boolean; phasesLit: Array<"LIGHT" | "DEEP" | "REM">; promoted: number; queued: number; lastPassAtMs: number | null }
export interface DreamItem { key: string; kind: "skill" | "lesson"; name: string; summary: string; confidence?: string; importance?: string }

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };
export const getStatus = (b: string): Promise<DreamStatus> => fetch(`${b}/api/dream/status`).then(j);
export const getQueue = (b: string): Promise<{ items: DreamItem[] }> => fetch(`${b}/api/dream/queue`).then(j);
export const post = (b: string, path: string, body?: unknown) =>
  fetch(`${b}/api/dream/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(j);
