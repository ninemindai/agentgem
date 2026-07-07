// packages/console/src/panels/Play/__tests__/Arcade.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { Arcade } from "../Arcade.js";
import { playMiniappsRoute } from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Arcade", () => {
  it("lists miniapps and calls onOpen when a card is clicked", async () => {
    vi.spyOn(playMiniappsRoute, "call").mockResolvedValue({
      miniapps: [{ name: "auth-replay", title: "Auth Replay", genre: "replay", needs: ["live-session-events"] }],
    });
    const onOpen = vi.fn();
    render(<Arcade apiBase="" onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText("Auth Replay")).toBeTruthy());
    expect(screen.getByText(/live/i)).toBeTruthy(); // permission chip
    fireEvent.click(screen.getByText("Auth Replay"));
    expect(onOpen).toHaveBeenCalledWith("auth-replay");
  });
});
