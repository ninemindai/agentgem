export interface DreamProgressData {
  phase: "LIGHT" | "DEEP" | "REM" | null;
  phasesLit: Array<"LIGHT" | "DEEP" | "REM">;
  currentRoot: string | null;
  rootIndex: number;
  rootCount: number;
  done: number;
  total: number;
}
export interface DreamStatus { enabled: boolean; phasesLit: Array<"LIGHT" | "DEEP" | "REM">; promoted: number; queued: number; lastPassAtMs: number | null; progress: DreamProgressData | null }

const j = (r: Response) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); };
export const getStatus = (b: string): Promise<DreamStatus> => fetch(`${b}/api/dream/status`).then(j);
export const post = (b: string, path: string, body?: unknown) =>
  fetch(`${b}/api/dream/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(j);

export interface JourneyEvent {
  ts: number;
  kind: "skill" | "lesson" | "opportunity" | "guardrail" | "pass" | "verified";
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

// Guardrail apply flow: preview the managed-region write (with a drift-guard hash
// and the editable seed), then apply the human-authored directive to CLAUDE.md/AGENTS.md.
export interface GuardrailPreview {
  current: string;
  next: string;
  hash: string;
  file: string | null;
  target: "claude" | "agents" | null;
  ambiguous: boolean;
  malformed: boolean;
  seed: string;
}
export const previewGuardrail = (b: string, key: string, target?: "claude" | "agents"): Promise<GuardrailPreview> =>
  post(b, "guardrail/preview", { key, target });
export const applyGuardrail = (b: string, key: string, expectHash: string, directive: string, target: "claude" | "agents") =>
  post(b, "queue/accept", { key, expectHash, directive, target });
