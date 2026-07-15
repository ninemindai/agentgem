// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Rubrics/__tests__/reattachSelection.test.tsx
//
// Regression test for the mount-race between the rubrics-list effect (defaults
// to the first rubric returned by /api/rubrics) and the reattach-sync effect
// (selects the rubric of a run reattached from /api/report/runs). Before the
// claimedRef fix, the rubrics-list effect set `rubricId` unconditionally, so a
// reattach that resolved FIRST (claiming a non-default rubric) still got
// clobbered back to the first-in-list rubric once /api/rubrics resolved.
//
// The two fetches race on mount with no ordering guarantee, so this test pins
// the order explicitly: it lets /api/report/runs (and therefore the reattach
// claim) resolve and fully apply BEFORE releasing a held /api/rubrics response,
// reproducing the exact "reattach resolves first" scenario from the finding.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { Rubrics } from "../index.js";

afterEach(cleanup);

// The route client (@agentback/client) parses responses via `.text()`, not
// `.json()` — mimic a real Response so route calls don't fail validation and
// get silently swallowed by the panel's `.catch(() => setX([]))` fallbacks.
function jsonResponse(body: unknown) {
  const text = JSON.stringify(body);
  return { ok: true, text: async () => text, json: async () => body } as any;
}
// The rubric stream is now `route.stream()` over fetch; a real event-stream
// Response so the reattach's stream open (a cache-hit) completes cleanly.
function sseResponse(frames: unknown[]) {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("Rubrics panel — reattach vs default-select race", () => {
  it("keeps the reattached run's rubric selected once /api/rubrics resolves afterward", async () => {
    let releaseRubrics: (() => void) | null = null;
    const rubricsGate = new Promise<void>((resolve) => { releaseRubrics = resolve; });
    // Signals that the reattach path opened the rubric stream (proof its rubric
    // claim landed) — the fetch-transport analogue of the old EventSource probe.
    let markStreamOpened: (() => void) | null = null;
    const streamOpened = new Promise<void>((resolve) => { markStreamOpened = resolve; });

    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes("/api/rubric/stream")) {
        markStreamOpened!();
        return sseResponse([{ type: "done", report: {}, cached: true, updatedAt: null }]);
      }
      if (url.includes("/api/report/runs")) {
        // A done run for "hygiene", which is NOT first in the rubrics list below.
        return jsonResponse({
          runs: [{
            id: "r1", kind: "rubric", paramsKey: "hygiene:project:/proj:",
            params: { rubric: "hygiene", scope: "project", root: "/proj" },
            status: "done", phase: "done", startedAt: Date.now(),
          }],
        });
      }
      if (url.includes("/api/rubrics")) {
        // Held open until the test explicitly releases it, so the reattach
        // claim is guaranteed to land first.
        await rubricsGate;
        return jsonResponse({
          rubrics: [
            { id: "correctness", title: "Correctness", target: "session", factors: [{ factor: "f1" }] },
            { id: "hygiene", title: "Hygiene", target: "session", factors: [{ factor: "f2" }] },
          ],
        });
      }
      if (url.includes("/api/testbed/projects")) return jsonResponse({ projects: [{ path: "/proj", flavor: "claude", name: "proj" }] });
      if (url.includes("/api/testbed/recents")) return jsonResponse({ recents: [] });
      return jsonResponse({});
    }));

    render(<Rubrics apiBase="http://x" />);

    // The reattach path (useReportRun's mount fetch → openLive → openStream)
    // opens the rubric stream once it has fully applied — proof the reattach
    // claim (rubricId="hygiene") landed before /api/rubrics is allowed to resolve.
    await streamOpened;

    const select = (await screen.findByLabelText("Rubric")) as HTMLSelectElement;
    // No options yet (the list is held), so select.value can't reflect the claimed
    // rubricId here — the meaningful check is after the list resolves, below.

    releaseRubrics!();
    await waitFor(() => expect(select.options.length).toBe(2));
    expect(select.options[0].value).toBe("correctness");   // the default this race would wrongly select

    // The list resolving afterward must not clobber the reattached selection.
    expect(select.value).toBe("hygiene");
  });

  // A session-scope reattach must end with the session row intact even when
  // /api/report/runs wins the race against /api/rubrics. During that window
  // `selected` is undefined so `sessionCapable` reads false for every rubric; the
  // clear-on-switch effect is guarded on `rubrics` being loaded so it doesn't act
  // on that "catalog unknown" state. This test locks in the correct end state for
  // the whole mount path (rubrics held until the reattach has applied).
  it("keeps a reattached session-scope run's row after /api/rubrics resolves afterward", async () => {
    let releaseRubrics: (() => void) | null = null;
    const rubricsGate = new Promise<void>((resolve) => { releaseRubrics = resolve; });
    let markStreamOpened: (() => void) | null = null;
    const streamOpened = new Promise<void>((resolve) => { markStreamOpened = resolve; });

    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes("/api/rubric/stream")) {
        markStreamOpened!();
        // A well-formed (clean) report so the active session row's RubricReportCard
        // renders — a real done event always carries the full report shape.
        return sseResponse([{ type: "done", cached: true, updatedAt: null, report: {
          rubricId: "hygiene", target: "s1", scope: "session", factors: [],
          sessionsScanned: 1, clean: true, degraded: false, skippedFactors: [],
        } }]);
      }
      if (url.includes("/api/report/runs")) {
        // A done SESSION-scope run for "hygiene".
        return jsonResponse({
          runs: [{
            id: "r1", kind: "rubric", paramsKey: "hygiene:session:/proj:s1",
            params: { rubric: "hygiene", scope: "session", root: "/proj", sessionId: "s1" },
            status: "done", phase: "done", startedAt: Date.now(),
          }],
        });
      }
      if (url.includes("/api/rubrics")) {
        await rubricsGate;
        // hygiene is session-granular, so it stays session-capable once loaded.
        return jsonResponse({
          rubrics: [
            { id: "correctness", title: "Correctness", target: "session", factors: [{ factor: "f1" }], granularity: "aggregate" },
            { id: "hygiene", title: "Hygiene", target: "session", factors: [{ factor: "f2" }], granularity: "session" },
          ],
        });
      }
      if (url.includes("/api/testbed/projects")) return jsonResponse({ projects: [{ path: "/proj", flavor: "claude", name: "proj" }] });
      if (url.includes("/api/testbed/recents")) return jsonResponse({ recents: [] });
      return jsonResponse({});
    }));

    render(<Rubrics apiBase="http://x" />);
    await streamOpened;

    const select = (await screen.findByLabelText("Rubric")) as HTMLSelectElement;
    releaseRubrics!();
    await waitFor(() => expect(select.options.length).toBe(2));
    expect(select.value).toBe("hygiene");

    // The reattached session row (labelled "session <id>" by the reattach effect)
    // must survive the mount-order race — the session-picker wiring must not drop
    // an actual reattached run just because the catalog hasn't classified its
    // rubric's granularity yet.
    expect(screen.getByText("session s1")).toBeTruthy();
  });
});
