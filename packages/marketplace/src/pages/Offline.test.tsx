import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

afterEach(() => { cleanup(); });

const unpinGame = vi.fn(async (..._a: unknown[]) => {});
let pins = [{ key: "@a/t", version: "1.0.0", title: "Tetris", size: 2048, pinnedAt: 1 }];
vi.mock("../offline", () => ({
  listPinned: () => pins,
  unpinGame: (...a: unknown[]) => unpinGame(...a),
  storageEstimate: async () => ({ usage: 2048, quota: 1_000_000 }),
}));

import { Offline } from "./Offline";

describe("Offline library", () => {
  beforeEach(() => { unpinGame.mockClear(); pins = [{ key: "@a/t", version: "1.0.0", title: "Tetris", size: 2048, pinnedAt: 1 }]; });

  it("lists pinned games with a remove control", () => {
    render(<Offline />);
    expect(screen.getByText("Tetris")).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove/i })).toBeTruthy();
  });

  it("removes a pin on click", async () => {
    render(<Offline />);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(unpinGame).toHaveBeenCalledWith(expect.any(String), "@a/t", "1.0.0");
    await waitFor(() => expect(screen.queryByText("Tetris")).toBeNull());
  });

  it("shows an empty state with no pins", () => {
    pins = [];
    render(<Offline />);
    expect(screen.getByText(/no games downloaded/i)).toBeTruthy();
  });
});
