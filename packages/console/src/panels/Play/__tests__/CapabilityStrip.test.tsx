// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { CapabilityStrip } from "../CapabilityStrip.js";

afterEach(cleanup);

describe("CapabilityStrip connectors", () => {
  it("renders ready / unreachable / missing connector states", () => {
    render(<CapabilityStrip needs={[]} pruned={[]} connectors={[
      { server: "github", tools: ["list_prs", "list_commits"], state: "ready" },
      { server: "linear", tools: [], state: "unreachable" },
      { server: "jira", tools: [], state: "missing" },
    ]} />);
    expect(screen.getByText(/list_prs, list_commits/)).toBeTruthy();
    expect(screen.getByText(/couldn.t connect/i)).toBeTruthy();
    expect(screen.getByText(/not installed here/i)).toBeTruthy();
  });

  it("renders nothing when there is nothing to disclose", () => {
    const { container } = render(<CapabilityStrip pruned={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
