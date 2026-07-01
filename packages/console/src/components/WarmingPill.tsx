// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { type ReactElement, useEffect, useState } from "react";

interface WarmStatus { running: boolean; last: { finishedAt: number } | null }

export function WarmingPill({ apiBase }: { apiBase: string }): ReactElement | null {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${apiBase}/api/warm/status`);
        if (!r.ok) return;
        const s = (await r.json()) as WarmStatus;
        if (alive) setRunning(s.running);
      } catch { /* best-effort */ }
    };
    void poll();
    const h = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(h); };
  }, [apiBase]);
  if (!running) return null;
  return <span className="warming-pill" title="Precomputing insights in the background">warming…</span>;
}
