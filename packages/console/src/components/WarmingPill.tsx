// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { type ReactElement, useEffect, useState } from "react";

interface WarmStatus { running: boolean; progress: { phase: string | null } | null; last: { finishedAt: number } | null }

export function WarmingPill({ apiBase }: { apiBase: string }): ReactElement | null {
  const [state, setState] = useState<{ running: boolean; phase: string | null }>({ running: false, phase: null });
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${apiBase}/api/warm/status`);
        if (!r.ok) return;
        const s = (await r.json()) as WarmStatus;
        if (alive) setState({ running: s.running, phase: s.progress?.phase ?? null });
      } catch { /* best-effort */ }
    };
    void poll();
    const h = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(h); };
  }, [apiBase]);
  if (!state.running) return null;
  return (
    <span className="warming-pill" title="Precomputing insights in the background">
      <span className="warming-pill__spark" aria-hidden="true">✦</span>
      warming…{state.phase ? <span className="warming-pill__phase">{state.phase}</span> : null}
    </span>
  );
}
