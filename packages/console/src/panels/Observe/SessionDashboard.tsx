// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/SessionDashboard.tsx
//
// Dashboard lens (Inspect → Session): the same agent-generated HTML dashboard
// the Watch panel renders live, produced once for a completed session and
// cached server-side by (sessionId, transcript mtime). One-shot — no SSE
// double-buffer; a single sealed srcdoc iframe (sandboxDoc CSP, null origin).
// Works for both agents — the server resolves Claude or Codex sessions by id.
import { useEffect, useState } from "react";
import { makeClient } from "../../api/routes.js";
import { openSessionDashboardStream, type SessionDashboardEvent } from "./dashboardStream.js";
import { sandboxDoc } from "../Watch/sandboxDoc.js";
import { fmtTime } from "./data.js";

type Phase =
  | { kind: "connecting" }
  | { kind: "generating"; chars: number }
  | { kind: "done"; html: string; cached: boolean; updatedAt: number }
  | { kind: "failed"; message: string };

export function SessionDashboard({ apiBase, agent, sessionId }: { apiBase: string; agent: "claude" | "codex"; sessionId: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "connecting" });
  const [run, setRun] = useState(0);            // bump to re-open the stream
  const [fresh, setFresh] = useState(false);    // regenerate on the next open

  useEffect(() => {
    setPhase({ kind: "connecting" });
    let chars = 0;
    const close = openSessionDashboardStream(makeClient(apiBase), { id: sessionId, agent, fresh }, (e: SessionDashboardEvent) => {
      if (e.type === "start" && !e.cached) setPhase({ kind: "generating", chars: 0 });
      else if (e.type === "delta") { chars += e.text.length; setPhase({ kind: "generating", chars }); }
      else if (e.type === "done") setPhase({ kind: "done", html: e.html, cached: e.cached, updatedAt: e.updatedAt });
      else if (e.type === "failed") setPhase({ kind: "failed", message: e.message });
    });
    return close;
  }, [apiBase, agent, sessionId, run, fresh]);

  const regenerate = () => { setFresh(true); setRun((r) => r + 1); };

  if (phase.kind === "connecting") return <div className="obs sd"><div className="obs-muted">Loading dashboard…</div></div>;
  if (phase.kind === "generating") {
    return (
      <div className="obs sd">
        <div className="obs-muted sd-progress">
          Generating dashboard{phase.chars > 0 ? ` — ${Math.round(phase.chars / 100) / 10}k chars` : ""}… first render drives the local
          agent and can take a minute or two; it's cached afterward.
        </div>
      </div>
    );
  }
  if (phase.kind === "failed") {
    return (
      <div className="obs sd">
        <div className="obs-error">{phase.message}</div>
        <button type="button" className="obs-open-transcript sd-regen" onClick={regenerate}>Try again</button>
      </div>
    );
  }

  return (
    <div className="obs sd">
      <div className="sd-head">
        <span className="obs-muted">
          {phase.cached ? "cached · " : ""}generated {fmtTime(phase.updatedAt)}
        </span>
        <button type="button" className="obs-open-transcript sd-regen" onClick={regenerate}>Regenerate</button>
      </div>
      <iframe
        className="sd-frame"
        title="Session dashboard"
        sandbox="allow-scripts"
        srcDoc={sandboxDoc(phase.html)}
      />
    </div>
  );
}
