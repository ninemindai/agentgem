// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/ContextTimeline.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextTimeline } from "./ContextTimeline.js";
import * as routes from "../../api/routes.js";

const sample = {
  meta: { sessionId: "s1", transcript: "s1.jsonl", model: "claude-opus-4-8[1m]", cap: 1_000_000 },
  curve: [
    { turn: 0, msgIndex: 1, ctxTokens: 100_000, cacheCreation: 2000, outTokens: 10 },
    { turn: 1, msgIndex: 4, ctxTokens: 500_000, cacheCreation: 40_000, outTokens: 20 },
  ],
  events: [{ msgIndex: 4, kind: "skill", name: "review" }],
  factors: [{ id: "context-pinned", title: "Window pinned", advice: "Cut earlier.", severity: "warn", count: 1, sessions: 1 }],
  hygiene: { score: 41, verdict: "bloated" },
};

beforeEach(() => vi.restoreAllMocks());

describe("ContextTimeline", () => {
  it("renders the verdict, a fired factor, and a ranked jump", async () => {
    vi.spyOn(routes.hygieneRoute, "call").mockResolvedValue(sample as any);
    render(<ContextTimeline apiBase="/" agent="claude" sessionId="s1" />);
    expect(await screen.findByText(/bloated/i)).toBeTruthy();
    expect(await screen.findByText(/Window pinned/i)).toBeTruthy();
    expect(await screen.findByText(/review/i)).toBeTruthy(); // jump cause names the skill
  });
  it("renders nothing for codex", () => {
    const { container } = render(<ContextTimeline apiBase="/" agent="codex" sessionId="s1" />);
    expect(container.firstChild).toBeNull();
  });
});
