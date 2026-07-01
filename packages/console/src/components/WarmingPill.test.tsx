// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { WarmingPill } from "./WarmingPill.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

describe("WarmingPill", () => {
  it("renders 'warming…' when status.running is true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ running: true, last: null })));
    render(<WarmingPill apiBase="" />);
    await waitFor(() => expect(screen.getByText("warming…")).toBeTruthy());
  });

  it("renders nothing when status.running is false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ running: false, last: null })));
    render(<WarmingPill apiBase="" />);
    // Wait for the poll to actually fire so the assertion is not vacuous (the
    // component initialises with useState(false) and returns null immediately,
    // meaning a synchronous queryByText check would pass even if fetch was never
    // called).  Confirming fetch ran proves the false-branch was exercised.
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByText("warming…")).toBeNull();
  });
});
