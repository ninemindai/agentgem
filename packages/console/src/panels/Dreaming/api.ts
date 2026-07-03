export interface DreamStatus { enabled: boolean; phasesLit: Array<"LIGHT" | "DEEP" | "REM">; promoted: number; queued: number; lastPassAtMs: number | null }

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };
export const getStatus = (b: string): Promise<DreamStatus> => fetch(`${b}/api/dream/status`).then(j);
export const post = (b: string, path: string, body?: unknown) =>
  fetch(`${b}/api/dream/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(j);

export interface JourneyEvent {
  ts: number;
  kind: "skill" | "lesson" | "opportunity" | "pass" | "verified";
  title: string;
  detail?: string;
  status?: "queued" | "accepted" | "dismissed";
  phase?: "DEEP" | "REM" | "LEARN";
  key?: string;
  firstSeenMs?: number;
  root?: string;
  agent?: string;
  passed?: boolean;
}
export interface JourneyResult { events: JourneyEvent[]; truncated: boolean }
export const getJourney = (b: string, kind?: string): Promise<JourneyResult> =>
  fetch(`${b}/api/journey${kind ? `?kind=${kind}` : ""}`).then(j);
