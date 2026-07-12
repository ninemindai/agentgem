import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

afterEach(() => { cleanup(); });

const pinGame = vi.fn(async (..._a: unknown[]) => {});
const unpinGame = vi.fn(async (..._a: unknown[]) => {});
let pinned = false;
vi.mock("./offline", () => ({
  pinGame: (...a: unknown[]) => pinGame(...a),
  unpinGame: (...a: unknown[]) => unpinGame(...a),
  isPinned: () => pinned,
}));

import { OfflineToggle } from "./OfflineToggle";

describe("OfflineToggle", () => {
  beforeEach(() => { pinGame.mockClear(); unpinGame.mockClear(); pinned = false; });

  it("downloads for offline, then shows the pinned state", async () => {
    render(<OfflineToggle gemKey="@a/t" version="1.0.0" title="T" />);
    fireEvent.click(screen.getByRole("button", { name: /download for offline/i }));
    expect(pinGame).toHaveBeenCalledWith(expect.any(String), "@a/t", "1.0.0", "T");
    await waitFor(() => expect(screen.getByText(/available offline/i)).toBeTruthy());
  });

  it("starts in the pinned state and removes on click", async () => {
    pinned = true;
    render(<OfflineToggle gemKey="@a/t" version="1.0.0" title="T" />);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(unpinGame).toHaveBeenCalledWith(expect.any(String), "@a/t", "1.0.0");
    await waitFor(() => expect(screen.getByRole("button", { name: /download for offline/i })).toBeTruthy());
  });

  it("surfaces an error when the download fails", async () => {
    pinGame.mockRejectedValueOnce(new Error("offline"));
    render(<OfflineToggle gemKey="@a/t" version="1.0.0" title="T" />);
    fireEvent.click(screen.getByRole("button", { name: /download for offline/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Download failed"));
    // Stayed unpinned — a failed download must not look like success.
    expect(screen.getByRole("button", { name: /download for offline/i })).toBeTruthy();
  });

  it("surfaces an error when the remove fails and keeps the pinned state", async () => {
    pinned = true;
    unpinGame.mockRejectedValueOnce(new Error("offline"));
    render(<OfflineToggle gemKey="@a/t" version="1.0.0" title="T" />);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Remove failed"));
    // Did NOT falsely flip to the unpinned state.
    expect(screen.getByRole("button", { name: /remove/i })).toBeTruthy();
    expect(screen.getByText(/available offline/i)).toBeTruthy();
  });

  it("resyncs the badge when props change without a remount", () => {
    // Mounts unpinned, then the same instance is handed different props (client-side nav
    // between game pages) for a gem that IS pinned — the badge must follow.
    const { rerender } = render(<OfflineToggle gemKey="@a/t" version="1.0.0" title="T" />);
    expect(screen.getByRole("button", { name: /download for offline/i })).toBeTruthy();
    pinned = true;
    act(() => { rerender(<OfflineToggle gemKey="@a/other" version="2.0.0" title="T" />); });
    expect(screen.getByText(/available offline/i)).toBeTruthy();
  });
});
