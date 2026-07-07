// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Rubrics/HygieneLeaderboard.tsx
import type { RubricReportView } from "./rubricStream.js";

type Row = NonNullable<RubricReportView["perSession"]>[number];

export function HygieneLeaderboard({ perSession, sessionsScanned, truncated }: {
  perSession: Row[]; sessionsScanned: number; truncated: boolean;
}) {
  // worst-first: ascending hygiene score (lower = more bloated). Entries without a
  // verdict sort last (shouldn't happen for a hygiene rubric, but stay total).
  const rows = [...perSession].sort((a, b) => (a.hygiene?.score ?? 101) - (b.hygiene?.score ?? 101));
  return (
    <div className="hyg-lb">
      <p className="insights-hint">
        {sessionsScanned} session{sessionsScanned === 1 ? "" : "s"} scanned · {perSession.length} need attention{truncated ? " (showing the first 200)" : ""}
      </p>
      <ul className="hyg-lb-list">
        {rows.map((r) => {
          const top = [...r.factors].filter((f) => f.count > 0).sort((a, b) => b.count - a.count)[0];
          const v = r.hygiene?.verdict ?? "bounded";
          return (
            <li key={r.sessionId} className="hyg-lb-row">
              <a className="hyg-lb-name" href={`#/inspect/claude/${r.sessionId}`}>{r.transcript}</a>
              <span className={"hyg-verdict is-" + v}><span className="hyg-word">{v}</span> <span className="hyg-score">{r.hygiene?.score ?? ""}</span></span>
              {top && <span className="hyg-lb-top ledger-muted">{top.title}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
