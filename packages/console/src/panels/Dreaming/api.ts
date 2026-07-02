export interface DreamStatus { enabled: boolean; phasesLit: Array<"LIGHT" | "DEEP" | "REM">; promoted: number; queued: number; lastPassAtMs: number | null }
export interface DreamItem { key: string; kind: "skill" | "lesson" | "opportunity"; root: string; name: string; summary: string; confidence?: string; importance?: string }
export interface DreamDiaryEntry { atMs: number; passId: number; rootsProcessed: string[]; phasesLit: string[]; enqueued: { skills: number; lessons: number; opportunities?: number }; degraded: boolean }

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };
export const getStatus = (b: string): Promise<DreamStatus> => fetch(`${b}/api/dream/status`).then(j);
export const getQueue = (b: string): Promise<{ items: DreamItem[] }> => fetch(`${b}/api/dream/queue`).then(j);
export const getDiary = (b: string): Promise<{ entries: DreamDiaryEntry[] }> => fetch(`${b}/api/dream/diary`).then(j);
export const post = (b: string, path: string, body?: unknown) =>
  fetch(`${b}/api/dream/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(j);
