// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Rubrics/__tests__/shortcutAutorun.test.tsx
//
// The rubric-shortcut deep-link: a surface (Sessions row, Mine scope) sets a
// PendingRubricRun with autorun and navigates to #/rubrics; the panel consumes
// it, selects the rubric, injects a session row when the target is a session,
// and opens the stream immediately — without the client ever knowing the
// session's project root (the server derives it from the transcript).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { Rubrics } from "../index.js";
import { setPendingRubricRun, consumePendingRubricRun } from "../../../pendingAnalyze.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); consumePendingRubricRun(); });

function jsonResponse(body: unknown) {
  const text = JSON.stringify(body);
  return { ok: true, text: async () => text, json: async () => body } as any;
}
function sseResponse(frames: unknown[]) {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const RUBRICS = {
  rubrics: [
    { id: "hygiene", title: "Session hygiene", target: "overview", factors: [{ factor: "retry-storm" }] },
    { id: "context-hygiene", title: "Context hygiene", target: "overview", factors: [{ factor: "task-sprawl" }] },
  ],
};

function stubFetch(streamUrls: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    const url = String(u);
    if (url.includes("/api/rubric/stream")) {
      streamUrls.push(url);
      return sseResponse([{ type: "done", report: { rubricId: "context-hygiene", target: "overview", scope: "session", factors: [], sessionsScanned: 1, clean: true, degraded: false, skippedFactors: [] }, cached: false, updatedAt: null }]);
    }
    if (url.includes("/api/report/runs")) return jsonResponse({ runs: [] });
    if (url.includes("/api/rubrics")) return jsonResponse(RUBRICS);
    if (url.includes("/api/testbed/projects")) return jsonResponse({ projects: [{ path: "/proj", flavor: "claude", name: "proj" }] });
    if (url.includes("/api/testbed/recents")) return jsonResponse({ recents: [] });
    return jsonResponse({});
  }));
}

describe("Rubrics panel — shortcut deep-link autorun", () => {
  it("auto-runs a session shortcut: selects the rubric, injects the session row, streams without root", async () => {
    const streamUrls: string[] = [];
    stubFetch(streamUrls);
    setPendingRubricRun({ rubric: "context-hygiene", scope: "session", sessionId: "sess-1", label: "agentgem · sess-1", autorun: true });

    render(<Rubrics apiBase="http://x" />);

    await waitFor(() => expect(streamUrls.length).toBe(1));
    const q = new URLSearchParams(streamUrls[0]!.split("?")[1] ?? "");
    expect(q.get("rubric")).toBe("context-hygiene");
    expect(q.get("scope")).toBe("session");
    expect(q.get("sessionId")).toBe("sess-1");
    expect(q.get("root")).toBeNull(); // root stays server-derived

    // The rubric select claims the shortcut's rubric (not the first in the list),
    // and the injected session row leads the list.
    await waitFor(() => {
      expect((screen.getByLabelText("Rubric") as HTMLSelectElement).value).toBe("context-hygiene");
    });
    expect(screen.getByText("agentgem · sess-1")).toBeDefined();
  });

  it("auto-runs a project shortcut against the given root", async () => {
    const streamUrls: string[] = [];
    stubFetch(streamUrls);
    setPendingRubricRun({ rubric: "context-hygiene", scope: "project", root: "/proj", autorun: true });

    render(<Rubrics apiBase="http://x" />);

    await waitFor(() => expect(streamUrls.length).toBe(1));
    const q = new URLSearchParams(streamUrls[0]!.split("?")[1] ?? "");
    expect(q.get("scope")).toBe("project");
    expect(q.get("root")).toBe("/proj");
  });

  it("a pending run WITHOUT autorun only preselects (the library's Run ▶)", async () => {
    const streamUrls: string[] = [];
    stubFetch(streamUrls);
    setPendingRubricRun({ rubric: "context-hygiene" });

    render(<Rubrics apiBase="http://x" />);

    await waitFor(() => {
      expect((screen.getByLabelText("Rubric") as HTMLSelectElement).value).toBe("context-hygiene");
    });
    expect(streamUrls.length).toBe(0);
  });
});
