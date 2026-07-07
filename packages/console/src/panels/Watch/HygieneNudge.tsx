// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Watch/HygieneNudge.tsx
import { useEffect, useRef, useState } from "react";
import { openHygieneStream, type HygieneMsg, type Verdict } from "./hygieneStream.js";
import { BloatCurve, type CurvePoint } from "../_shared/BloatCurve.js";

const RANK: Record<Verdict, number> = { bounded: 0, mixed: 1, bloated: 2 };

export function HygieneNudge({ apiBase, file }: { apiBase: string; file: string }) {
  const [snap, setSnap] = useState<{ verdict: Verdict; score: number; cap: number; curve: CurvePoint[] } | null>(null);
  const [nudge, setNudge] = useState<{ verdict: Verdict; advice: string } | null>(null);
  const dismissedAt = useRef<number>(-1);   // rank of the last dismissed verdict

  useEffect(() => {
    setSnap(null); setNudge(null); dismissedAt.current = -1;
    return openHygieneStream(apiBase, file, (m: HygieneMsg) => {
      if (m.type === "hygiene") setSnap({ verdict: m.verdict, score: m.score, cap: m.cap, curve: m.curveTail });
      else if (m.type === "nudge") {
        // re-show only if this escalation is heavier than what was last dismissed
        if (RANK[m.verdict] > dismissedAt.current) setNudge({ verdict: m.verdict, advice: m.advice });
      }
    });
  }, [apiBase, file]);

  if (!nudge) return null;

  return (
    <div className={"hyg-nudge is-" + nudge.verdict} role="status">
      <div className="hyg-nudge-body">
        <span className={"hyg-verdict is-" + nudge.verdict}>{nudge.verdict}</span>
        <span className="hyg-nudge-advice">{nudge.advice}</span>
        <button type="button" className="hyg-nudge-x" aria-label="Dismiss"
          onClick={() => { dismissedAt.current = RANK[nudge.verdict]; setNudge(null); }}>×</button>
      </div>
      {snap && snap.curve.length > 0 && <BloatCurve curve={snap.curve} cap={snap.cap} width={280} height={64} />}
    </div>
  );
}
