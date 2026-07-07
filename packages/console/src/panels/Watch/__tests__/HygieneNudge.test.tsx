// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Watch/__tests__/HygieneNudge.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { HygieneNudge } from "../HygieneNudge.js";
import * as stream from "../hygieneStream.js";

afterEach(cleanup);

// Drive the component by capturing the onEvent callback the component passes to
// openHygieneStream, so the test can push snapshot/nudge events synchronously.
function mockStream() {
  let cb: (e: stream.HygieneMsg) => void = () => {};
  vi.spyOn(stream, "openHygieneStream").mockImplementation((_a, _f, onEvent) => { cb = onEvent; return () => {}; });
  return { push: (e: stream.HygieneMsg) => cb(e) };
}

const snap = (verdict: "bounded" | "mixed" | "bloated") => ({
  type: "hygiene" as const, verdict, score: 40, cap: 1_000_000,
  curveTail: [{ turn: 0, msgIndex: 0, ctxTokens: 500_000, cacheCreation: 0, outTokens: 1 }], factors: [],
});

describe("HygieneNudge", () => {
  it("renders nothing while bounded", () => {
    const m = mockStream();
    const { container } = render(<HygieneNudge apiBase="/" file="s.jsonl" />);
    m.push(snap("bounded"));
    expect(container.querySelector(".hyg-nudge")).toBeNull();
  });
  it("shows a dismissible banner with advice on a nudge event", async () => {
    const m = mockStream();
    render(<HygieneNudge apiBase="/" file="s.jsonl" />);
    m.push(snap("bloated"));
    m.push({ type: "nudge", verdict: "bloated", advice: "Take a clean break." });
    expect(await screen.findByText(/Take a clean break/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByText(/Take a clean break/i)).toBeNull();
  });
  it("re-shows after dismiss when a higher-verdict nudge arrives", async () => {
    const m = mockStream();
    render(<HygieneNudge apiBase="/" file="s.jsonl" />);
    m.push({ type: "nudge", verdict: "mixed", advice: "Getting heavy." });
    expect(await screen.findByText(/Getting heavy/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByText(/Getting heavy/i)).toBeNull());
    m.push({ type: "nudge", verdict: "bloated", advice: "Now bloated." });
    expect(await screen.findByText(/Now bloated/i)).toBeTruthy();
  });
  it("re-arms after a session clears and re-bloats", async () => {
    const m = mockStream();
    render(<HygieneNudge apiBase="/" file="s.jsonl" />);
    m.push({ type: "nudge", verdict: "bloated", advice: "First bloat." });
    expect(await screen.findByText(/First bloat/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByText(/First bloat/i)).toBeNull());
    m.push(snap("bounded"));
    m.push({ type: "nudge", verdict: "bloated", advice: "Re-bloat." });
    expect(await screen.findByText(/Re-bloat/i)).toBeTruthy();
  });
  it("renders nothing for an unsupported (Codex) phase", () => {
    const m = mockStream();
    const { container } = render(<HygieneNudge apiBase="/" file="s.jsonl" />);
    m.push({ type: "phase", phase: "unsupported" });
    expect(container.querySelector(".hyg-nudge")).toBeNull();
  });
});
