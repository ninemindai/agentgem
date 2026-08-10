// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Watch/hygieneStream.ts
//
// Watch tab live context-hygiene data layer: subscribe to one session's hygiene
// stream via native EventSource — named events phase/hygiene/nudge/failed, same
// scaffold as eventStream.ts. The server has already scrubbed everything; the
// panel renders counts/advice + an integer curve, never markup.
// Transport resilience (stall watchdog → ?poll=1 fallback) comes from
// openResilientStream; the cursor carries the last verdict so nudges still
// fire only on a CLIMB across stateless polls.
import type { CurvePoint } from "../_shared/BloatCurve.js";
import { openResilientStream, type PollResult } from "../_shared/resilientStream.js";

export type Verdict = "bounded" | "mixed" | "bloated";
export interface FactorRow { id: string; title: string; advice: string; severity: "info" | "warn"; count: number; sessions: number }

export type HygieneMsg =
  | { type: "phase"; phase: string }
  | { type: "hygiene"; verdict: Verdict; score: number; cap: number; curveTail: CurvePoint[]; factors: FactorRow[] }
  | { type: "nudge"; verdict: Verdict; advice: string }
  | { type: "failed"; message: string };

export function openHygieneStream(apiBase: string, file: string, onEvent: (e: HygieneMsg) => void): () => void {
  type Cursor = { prev: string; since: number };
  const close = openResilientStream<Cursor>({
    streamUrl: `${apiBase}/api/watch/hygiene?${new URLSearchParams({ file }).toString()}`,
    events: ["phase", "hygiene", "nudge", "failed"],
    initialCursor: { prev: "", since: 0 },
    advance: (c, event, data) => (event === "hygiene" ? { ...c, prev: (data as { verdict: Verdict }).verdict } : c),
    poll: async (c) => {
      const params = new URLSearchParams({ file, poll: "1", prev: c.prev, since: String(c.since) });
      const r = await fetch(`${apiBase}/api/watch/hygiene?${params.toString()}`);
      if (!r.ok) throw new Error(`hygiene poll ${r.status}`);
      return (await r.json()) as PollResult<Cursor>;
    },
    onMessage: (event, data) => {
      const d = data as Record<string, unknown>;
      if (event === "phase") onEvent({ type: "phase", phase: d.phase as string });
      else if (event === "hygiene") onEvent({ type: "hygiene", ...(data as Omit<HygieneMsg & { type: "hygiene" }, "type">) });
      else if (event === "nudge") onEvent({ type: "nudge", verdict: d.verdict as Verdict, advice: d.advice as string });
      else if (event === "failed") { onEvent({ type: "failed", message: d.message as string }); close(); }
    },
  });
  return close;
}
