// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/BlastRadius.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { BlastRadius } from "./BlastRadius.js";
import * as routes from "../../api/routes.js";

const sample = {
  meta: { sessionId: "s1", transcript: "s1.jsonl", project: "~/proj", startMs: 0, endMs: 0 },
  events: [
    { seq: 0, msgIndex: 1, tsMs: null, tool: "Read", action: "read", target: "src/a.ts", zone: "project" },
    { seq: 1, msgIndex: 2, tsMs: null, tool: "Edit", action: "edit", target: "src/a.ts", zone: "project" },
    { seq: 2, msgIndex: 3, tsMs: null, tool: "Read", action: "read", target: "/etc/hosts", zone: "outside", error: true },
    { seq: 3, msgIndex: 4, tsMs: null, tool: "Skill", action: "skill", target: "qa" },
  ],
};

beforeEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("BlastRadius", () => {
  it("renders the map groups, summary chips, and deck for a claude session", async () => {
    vi.spyOn(routes.blastRoute, "call").mockResolvedValue(sample as any);
    render(<BlastRadius apiBase="/" agent="claude" sessionId="s1" />);
    expect(await screen.findByText("a.ts")).toBeTruthy();
    expect(screen.getByText("src/")).toBeTruthy();
    expect(screen.getByText(/outside · other/)).toBeTruthy();
    expect(screen.getByText("skills")).toBeTruthy();
    expect(screen.getByText("2 files")).toBeTruthy();
    expect(screen.getByText("1 edited")).toBeTruthy();
    expect(screen.getByText("1 outside")).toBeTruthy();
    expect(screen.getByText("1 errors")).toBeTruthy();
    // the map|rail divider is wired onto .br (rail is the resizable pane)
    expect(document.querySelector(".br .split-handle")?.getAttribute("data-side")).toBe("end");
  });

  it("pins a target and jumps the playhead from a visit row", async () => {
    vi.spyOn(routes.blastRoute, "call").mockResolvedValue(sample as any);
    render(<BlastRadius apiBase="/" agent="claude" sessionId="s1" />);
    fireEvent.click(await screen.findByText("a.ts"));
    expect(screen.getByText("src/a.ts")).toBeTruthy();          // rail shows the full path
    const visits = document.querySelectorAll(".br-visit");
    expect(visits).toHaveLength(2);                              // Read + Edit
    fireEvent.click(visits[0]);
    expect(screen.getByText("1/4")).toBeTruthy();                // playhead at seq 0
  });

  it("steps the playhead with the keyboard (Home, arrows, E to next edit)", async () => {
    vi.spyOn(routes.blastRoute, "call").mockResolvedValue(sample as any);
    render(<BlastRadius apiBase="/" agent="claude" sessionId="s1" />);
    const app = (await screen.findByRole("application")) as HTMLElement;
    fireEvent.keyDown(app, { key: "Home" });
    expect(screen.getByText("0/4")).toBeTruthy();
    fireEvent.keyDown(app, { key: "ArrowRight" });
    expect(screen.getByText("1/4")).toBeTruthy();
    fireEvent.keyDown(app, { key: "e" });
    expect(screen.getByText("2/4")).toBeTruthy();                // next edit is seq 1
  });

  it("renders nothing for codex and for an empty report", async () => {
    const { container } = render(<BlastRadius apiBase="/" agent="codex" sessionId="s1" />);
    expect(container.firstChild).toBeNull();
    vi.spyOn(routes.blastRoute, "call").mockResolvedValue({ meta: sample.meta, events: [] } as any);
    const { container: c2 } = render(<BlastRadius apiBase="/" agent="claude" sessionId="s2" />);
    await vi.waitFor(() => expect(c2.firstChild).toBeNull());
  });
});
