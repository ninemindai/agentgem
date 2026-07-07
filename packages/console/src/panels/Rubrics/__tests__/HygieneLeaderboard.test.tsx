// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Rubrics/__tests__/HygieneLeaderboard.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { HygieneLeaderboard } from "../HygieneLeaderboard.js";

afterEach(cleanup);

const rows = [
  { sessionId: "aaa", transcript: "aaa.jsonl", factors: [{ id: "context-pinned", title: "Window pinned at the context cap", advice: "", severity: "warn" as const, count: 3, sessions: 1 }], hygiene: { score: 20, verdict: "bloated" as const } },
  { sessionId: "bbb", transcript: "bbb.jsonl", factors: [{ id: "task-pingpong", title: "Ping-ponging between tasks", advice: "", severity: "info" as const, count: 1, sessions: 1 }], hygiene: { score: 60, verdict: "mixed" as const } },
];

describe("HygieneLeaderboard", () => {
  it("renders rows worst-first with verdict, score, and a deep-link to Inspect", () => {
    render(<HygieneLeaderboard perSession={rows} sessionsScanned={142} truncated={false} />);
    const list = screen.getAllByRole("listitem");
    expect(list).toHaveLength(2);
    expect(within(list[0]).getByText(/bloated/i)).toBeTruthy();   // worst (score 20) first
    expect(within(list[1]).getByText(/mixed/i)).toBeTruthy();
    const link = within(list[0]).getByRole("link");
    expect(link.getAttribute("href")).toBe("#/inspect/claude/aaa");
  });

  it("shows the scanned / needs-attention header", () => {
    render(<HygieneLeaderboard perSession={rows} sessionsScanned={142} truncated={false} />);
    expect(screen.getByText(/142 sessions scanned/i)).toBeTruthy();
    expect(screen.getByText(/2 need attention/i)).toBeTruthy();
  });
});
