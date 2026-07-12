import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { makeApi } from "../api";

afterEach(() => { cleanup(); });

const unpinGame = vi.fn(async (..._a: unknown[]) => {});
let pins = [{ key: "@a/t", version: "1.0.0", title: "Tetris", size: 2048, pinnedAt: 1 }];
vi.mock("../offline", () => ({
  listPinned: () => pins,
  unpinGame: (...a: unknown[]) => unpinGame(...a),
  storageEstimate: async () => ({ usage: 2048, quota: 1_000_000 }),
}));

// Stub the player so the test stays focused on the library's own logic (list/remove/empty/play-in-place)
// rather than GamePreview's html fetch. The stub records the key+version it was asked to play so the test
// can assert the library plays the pin IN PLACE (not via a link to the metadata-gated gem page).
const gpProps = vi.fn();
vi.mock("../GamePreview", () => ({
  GamePreview: (props: { gemKey: string; version: string }) => { gpProps(props); return <div data-testid="game-preview">{props.gemKey}</div>; },
}));

import { Offline } from "./Offline";

const api = {} as ReturnType<typeof makeApi>;

describe("Offline library", () => {
  beforeEach(() => { unpinGame.mockClear(); gpProps.mockClear(); pins = [{ key: "@a/t", version: "1.0.0", title: "Tetris", size: 2048, pinnedAt: 1 }]; });

  it("lists pinned games with a remove control", () => {
    render(<Offline api={api} />);
    expect(screen.getByText("Tetris")).toBeTruthy();
    expect(screen.getByRole("button", { name: /remove/i })).toBeTruthy();
  });

  it("plays each pin IN PLACE (renders a player for it, no gem-page link)", () => {
    const { container } = render(<Offline api={api} />);
    // The library must NOT link to /gems/<key> — that page needs uncached metadata and 404s offline.
    expect(container.querySelector('a[href^="/gems/"]')).toBeNull();
    // It mounts a GamePreview for the pinned game (which the SW serves from games-pinned offline).
    expect(gpProps).toHaveBeenCalledWith(expect.objectContaining({ gemKey: "@a/t", version: "1.0.0" }));
    expect(screen.getByTestId("game-preview")).toBeTruthy();
  });

  it("removes a pin on click", async () => {
    render(<Offline api={api} />);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(unpinGame).toHaveBeenCalledWith(expect.any(String), "@a/t", "1.0.0");
    await waitFor(() => expect(screen.queryByText("Tetris")).toBeNull());
  });

  it("shows an empty state with no pins", () => {
    pins = [];
    render(<Offline api={api} />);
    expect(screen.getByText(/no games downloaded/i)).toBeTruthy();
  });
});
