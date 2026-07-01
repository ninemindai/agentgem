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
    await waitFor(() => expect(screen.queryByText("warming…")).toBeNull());
  });
});
