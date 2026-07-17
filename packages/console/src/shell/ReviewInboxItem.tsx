// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Rail entry for the Journey/Dreaming queue — piggybacks useBackgroundJobs's poll
// (Shell computes `count` from the same dream-status fetch the status line already
// uses; see useBackgroundJobs.ts). Absent at 0, present with a count badge above it.
import type { ReactElement } from "react";

export function ReviewInboxItem({ count, active }: { count: number; active: boolean }): ReactElement | null {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      className={"console-nav-item" + (active ? " is-active" : "")}
      onClick={() => { window.location.hash = "#/dreaming"; }}
    >
      <span className="console-nav-icon" aria-hidden="true">📥</span>
      Review inbox
      <span className="nav-badge">{count}</span>
    </button>
  );
}
