// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Rubrics/__tests__/generateReport.test.tsx
//
// The "Generate report ⤓" button: appears once an evaluation is done, opens the
// report-render stream with the SAME scope addressing as the evaluation, and
// downloads the returned self-contained HTML as a blob.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { Rubrics } from "../index.js";
import { setPendingRubricRun, consumePendingRubricRun } from "../../../pendingAnalyze.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); consumePendingRubricRun(); });

function jsonResponse(body: unknown) {
  const text = JSON.stringify(body);
  return { ok: true, text: async () => text, json: async () => body } as any;
}
function sseResponse(frames: unknown[]) {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const DONE_REPORT = {
  rubricId: "context-hygiene", target: "overview", scope: "session",
  factors: [], sessionsScanned: 1, clean: true, degraded: false, skippedFactors: [],
};

describe("Rubrics panel — Generate report", () => {
  it("streams the report render for the active scope and downloads the html", async () => {
    const reportUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes("/api/rubric/report")) {
        reportUrls.push(url);
        return sseResponse([
          { type: "start", rubric: "context-hygiene", title: "Context hygiene", scope: "session" },
          { type: "done", html: "<html>REPORT</html>", truncated: false },
        ]);
      }
      if (url.includes("/api/rubric/stream")) {
        return sseResponse([{ type: "done", report: DONE_REPORT, cached: false, updatedAt: null }]);
      }
      if (url.includes("/api/report/runs")) return jsonResponse({ runs: [] });
      if (url.includes("/api/rubrics")) {
        return jsonResponse({ rubrics: [{ id: "context-hygiene", title: "Context hygiene", target: "overview", factors: [{ factor: "task-sprawl" }] }] });
      }
      if (url.includes("/api/testbed/projects")) return jsonResponse({ projects: [] });
      if (url.includes("/api/testbed/recents")) return jsonResponse({ recents: [] });
      return jsonResponse({});
    }));
    // jsdom has no createObjectURL; the download anchor must not navigate.
    const createUrl = vi.fn(() => "blob:report");
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createUrl;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    // Land via a session shortcut so the evaluation autoruns and completes.
    setPendingRubricRun({ rubric: "context-hygiene", scope: "session", sessionId: "sess-9", autorun: true });
    render(<Rubrics apiBase="http://x" />);

    const btn = await screen.findByText("Generate report ⤓");
    fireEvent.click(btn);

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(createUrl).toHaveBeenCalledTimes(1);
    // Same scope addressing as the evaluation: session + sessionId, no root.
    expect(reportUrls.length).toBe(1);
    const q = new URLSearchParams(reportUrls[0]!.split("?")[1] ?? "");
    expect(q.get("rubric")).toBe("context-hygiene");
    expect(q.get("scope")).toBe("session");
    expect(q.get("sessionId")).toBe("sess-9");
    expect(q.get("root")).toBeNull();
  });

  it("renders the report in a viewer modal after generation, and can reopen it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes("/api/rubric/report")) {
        return sseResponse([
          { type: "start", rubric: "context-hygiene", title: "Context hygiene", scope: "session" },
          { type: "done", html: "<html>REPORT</html>", truncated: false },
        ]);
      }
      if (url.includes("/api/rubric/stream")) {
        return sseResponse([{ type: "done", report: DONE_REPORT, cached: false, updatedAt: null }]);
      }
      if (url.includes("/api/report/runs")) return jsonResponse({ runs: [] });
      if (url.includes("/api/rubrics")) {
        return jsonResponse({ rubrics: [{ id: "context-hygiene", title: "Context hygiene", target: "overview", factors: [{ factor: "task-sprawl" }] }] });
      }
      if (url.includes("/api/testbed/projects")) return jsonResponse({ projects: [] });
      if (url.includes("/api/testbed/recents")) return jsonResponse({ recents: [] });
      return jsonResponse({});
    }));
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:report");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    setPendingRubricRun({ rubric: "context-hygiene", scope: "session", sessionId: "sess-9", autorun: true });
    render(<Rubrics apiBase="http://x" />);

    fireEvent.click(await screen.findByText("Generate report ⤓"));

    // The viewer opens automatically with the report in a sealed iframe — the
    // download ("save") still happens exactly once alongside it.
    const frame = await screen.findByTitle("Rubric report");
    expect((frame as HTMLIFrameElement).getAttribute("srcdoc")).toContain("<html>REPORT</html>");
    expect((frame as HTMLIFrameElement).getAttribute("sandbox")).toBe("allow-scripts");
    expect(click).toHaveBeenCalledTimes(1);

    // Close hides the viewer; "View report" brings it back without re-generating.
    fireEvent.click(screen.getByLabelText("Close report"));
    expect(screen.queryByTitle("Rubric report")).toBeNull();
    fireEvent.click(screen.getByText("View report"));
    expect(await screen.findByTitle("Rubric report")).toBeTruthy();

    // The modal's own Download button saves the same html again.
    fireEvent.click(screen.getByText("Download ⤓"));
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("shows the failure message when the render stream fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      const url = String(u);
      if (url.includes("/api/rubric/report")) return sseResponse([{ type: "failed", message: "report rendering failed — is the local coding agent available?" }]);
      if (url.includes("/api/rubric/stream")) return sseResponse([{ type: "done", report: DONE_REPORT, cached: false, updatedAt: null }]);
      if (url.includes("/api/report/runs")) return jsonResponse({ runs: [] });
      if (url.includes("/api/rubrics")) return jsonResponse({ rubrics: [{ id: "context-hygiene", title: "Context hygiene", target: "overview", factors: [{ factor: "task-sprawl" }] }] });
      if (url.includes("/api/testbed/projects")) return jsonResponse({ projects: [] });
      if (url.includes("/api/testbed/recents")) return jsonResponse({ recents: [] });
      return jsonResponse({});
    }));

    setPendingRubricRun({ rubric: "context-hygiene", scope: "session", sessionId: "sess-9", autorun: true });
    render(<Rubrics apiBase="http://x" />);

    fireEvent.click(await screen.findByText("Generate report ⤓"));
    await screen.findByText(/report rendering failed/);
  });
});
