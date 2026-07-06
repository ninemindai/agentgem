// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/HygieneReport.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HygieneReport } from "./HygieneReport.js";
import * as routes from "../../api/routes.js";

const sample = {
  meta: { sessionId: "s1", transcript: "s1.jsonl", model: "claude-opus-4-8[1m]", cap: 1_000_000 },
  curve: [{ turn: 0, msgIndex: 1, ctxTokens: 402_100, cacheCreation: 2000, outTokens: 10 }],
  factors: [
    { id: "context-pinned", title: "Window pinned at the context cap", advice: "Cut earlier.", severity: "warn", count: 1, sessions: 1 },
    { id: "task-sprawl", title: "Many tasks in one session", advice: "Split them.", severity: "warn", count: 0, sessions: 0 },
  ],
  hygiene: { score: 78, verdict: "bounded" },
};

beforeEach(() => vi.restoreAllMocks());

describe("HygieneReport", () => {
  it("renders the verdict and the fired factor after auto-loading", async () => {
    vi.spyOn(routes.hygieneRoute, "call").mockResolvedValue(sample as any);
    render(<HygieneReport apiBase="/" agent="claude" sessionId="s1" />);
    expect(await screen.findByText(/bounded/i)).toBeTruthy();
    expect(await screen.findByText(/Window pinned/i)).toBeTruthy();      // fired factor shown
    expect(screen.queryByText(/Many tasks/i)).toBeNull();               // unfired factor collapsed
  });

  it("renders 'No context data' when the curve is empty", async () => {
    vi.spyOn(routes.hygieneRoute, "call").mockResolvedValue({ ...sample, curve: [] } as any);
    render(<HygieneReport apiBase="/" agent="claude" sessionId="s1" />);
    expect(await screen.findByText(/No context data/i)).toBeTruthy();
  });

  it("renders nothing for a Codex session (no fetch)", () => {
    const spy = vi.spyOn(routes.hygieneRoute, "call");
    const { container } = render(<HygieneReport apiBase="/" agent="codex" sessionId="s1" />);
    expect(container.firstChild).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
