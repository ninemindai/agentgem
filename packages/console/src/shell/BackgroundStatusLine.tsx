// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Rail-footer status line, above the footer pages (Settings/Memory). Presentational
// only — useBackgroundJobs (mounted once in Shell) owns the poll; this component just
// renders the three literal states and, when there's something to show, expands
// inline to the job rows the signals already carry. No new job framework, no history.
import { useState, type ReactElement } from "react";
import type { BackgroundJobs } from "./useBackgroundJobs.js";

// The header's count must match what the expanded list actually shows — `jobs.length`,
// not `count` (which only tallies RUNNING signals). A finished-warm-cache row or a
// queued-dream row still shows up in the list while not counting as "running", so
// using `count` here could read "Working in the background: 1 jobs" while the list
// underneath shows 2 rows. Singular/plural handled explicitly ("1 job", not "1 jobs").
function copyFor(mode: BackgroundJobs["mode"], jobCount: number): string {
  if (mode === "active") return `Working in the background: ${jobCount} job${jobCount === 1 ? "" : "s"}`;
  if (mode === "off") return "Background jobs off — enable in Settings";
  return "Background jobs idle";
}

export function BackgroundStatusLine({ mode, jobs }: BackgroundJobs): ReactElement {
  const [expanded, setExpanded] = useState(false);
  // "off" has nothing to expand — warming never started, so there's no last-known
  // job for it to carry — the label itself is the call to action straight to Settings.
  const expandable = mode !== "off";

  const onClick = () => {
    if (!expandable) { window.location.hash = "#/settings"; return; }
    setExpanded((e) => !e);
  };

  return (
    <div className="bg-status" data-mode={mode}>
      <button
        type="button"
        className="bg-status-toggle"
        aria-expanded={expandable && expanded}
        onClick={onClick}
      >
        <span className="bg-status-dot" aria-hidden="true" />
        <span className="bg-status-label">{copyFor(mode, jobs.length)}</span>
        {expandable && <span className="bg-status-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>}
      </button>
      {expandable && expanded && (
        jobs.length === 0
          ? <p className="bg-status-empty">Nothing to show yet.</p>
          : (
            <ul className="bg-status-jobs">
              {jobs.map((j) => (
                <li key={j.id}>
                  <button type="button" className="bg-status-job" onClick={() => { window.location.hash = j.route; }}>
                    {j.label}
                  </button>
                </li>
              ))}
            </ul>
          )
      )}
    </div>
  );
}
