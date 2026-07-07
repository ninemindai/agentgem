// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Watch/hygieneStream.ts
//
// Watch tab live context-hygiene data layer: subscribe to one session's hygiene
// stream via native EventSource — named events phase/hygiene/nudge/failed, same
// scaffold as eventStream.ts. The server has already scrubbed everything; the
// panel renders counts/advice + an integer curve, never markup.
import type { CurvePoint } from "../_shared/BloatCurve.js";

export type Verdict = "bounded" | "mixed" | "bloated";
export interface FactorRow { id: string; title: string; advice: string; severity: "info" | "warn"; count: number; sessions: number }

export type HygieneMsg =
  | { type: "phase"; phase: string }
  | { type: "hygiene"; verdict: Verdict; score: number; cap: number; curveTail: CurvePoint[]; factors: FactorRow[] }
  | { type: "nudge"; verdict: Verdict; advice: string }
  | { type: "failed"; message: string };

export function openHygieneStream(apiBase: string, file: string, onEvent: (e: HygieneMsg) => void): () => void {
  const es = new EventSource(`${apiBase}/api/watch/hygiene?${new URLSearchParams({ file }).toString()}`);
  const data = (m: Event) => JSON.parse((m as MessageEvent).data);
  es.addEventListener("phase", (m) => { const d = data(m); onEvent({ type: "phase", phase: d.phase }); });
  es.addEventListener("hygiene", (m) => { const d = data(m); onEvent({ type: "hygiene", ...d }); });
  es.addEventListener("nudge", (m) => { const d = data(m); onEvent({ type: "nudge", verdict: d.verdict, advice: d.advice }); });
  es.addEventListener("failed", (m) => { onEvent({ type: "failed", message: data(m).message }); es.close(); });
  es.addEventListener("error", () => onEvent({ type: "failed", message: "connection lost" }));
  return () => es.close();
}
