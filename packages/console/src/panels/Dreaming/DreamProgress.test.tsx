// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DreamProgress } from "./DreamProgress.js";

afterEach(cleanup);

describe("DreamProgress", () => {
  it("renders nothing when idle", () => {
    const { container } = render(<DreamProgress progress={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows phase states and the current project", () => {
    render(<DreamProgress progress={{ phase: "DEEP", phasesLit: ["LIGHT"], currentRoot: "my-app", rootIndex: 2, rootCount: 5, done: 3, total: 8 }} />);
    const phases = screen.getAllByRole("listitem");
    expect(phases.find((li) => li.textContent === "LIGHT")!.getAttribute("data-state")).toBe("done");
    expect(phases.find((li) => li.textContent === "DEEP")!.getAttribute("data-state")).toBe("running");
    expect(phases.find((li) => li.textContent === "REM")!.getAttribute("data-state")).toBe("pending");
    expect(screen.getByText("my-app")).toBeTruthy();
    expect(screen.getByText(/2 of 5/)).toBeTruthy();
  });
});
