// packages/console/src/panels/Play/__tests__/Arcade.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { Arcade } from "../Arcade.js";
import { playMiniappsRoute, playDeleteRoute } from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const twoApps = {
  miniapps: [
    { name: "auth-replay", title: "Auth Replay", genre: "replay", needs: ["live-session-events" as const] },
    { name: "duel", title: "Duel", genre: "project-fun" },
  ],
};

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

  it("asks to confirm before deleting, and does NOT open the miniapp on the way", async () => {
    vi.spyOn(playMiniappsRoute, "call").mockResolvedValue(twoApps);
    const onOpen = vi.fn();
    render(<Arcade apiBase="" onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText("Duel")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Delete duel"));
    expect(onOpen).not.toHaveBeenCalled();                 // the ✕ must not bubble into the card's open
    expect(screen.getByText(/delete “Duel”\?/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeTruthy();
  });

  it("cancelling leaves the miniapp alone", async () => {
    vi.spyOn(playMiniappsRoute, "call").mockResolvedValue(twoApps);
    const del = vi.spyOn(playDeleteRoute, "call");
    render(<Arcade apiBase="" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Duel")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Delete duel"));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.getByText("Duel")).toBeTruthy());
    expect(del).not.toHaveBeenCalled();
  });

  it("confirming deletes the miniapp and drops just that card", async () => {
    vi.spyOn(playMiniappsRoute, "call").mockResolvedValue(twoApps);
    const del = vi.spyOn(playDeleteRoute, "call").mockResolvedValue({ name: "duel", commit: "abc1234" });
    render(<Arcade apiBase="" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Duel")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Delete duel"));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(screen.queryByText("Duel")).toBeNull());
    expect(del).toHaveBeenCalledWith(expect.anything(), { body: { name: "duel" } });
    expect(screen.getByText("Auth Replay")).toBeTruthy();  // the sibling card is untouched
  });

  // Creating twice from one source is now supported, so two cards can share a title. The id is the only
  // thing that separates them: the ✕ and the confirm must both address the right one.
  it("disambiguates same-titled miniapps by id when deleting", async () => {
    vi.spyOn(playMiniappsRoute, "call").mockResolvedValue({
      miniapps: [
        { name: "duel", title: "Duel", genre: "project-fun" },
        { name: "duel-2", title: "Duel", genre: "project-fun" },
      ],
    });
    const del = vi.spyOn(playDeleteRoute, "call").mockResolvedValue({ name: "duel-2", commit: "abc1234" });
    render(<Arcade apiBase="" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText("Duel")).toHaveLength(2));

    fireEvent.click(screen.getByLabelText("Delete duel-2"));  // unambiguous even though titles collide
    expect(screen.getByText("duel-2")).toBeTruthy();          // the confirm names the id it will remove
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(screen.getAllByText("Duel")).toHaveLength(1));
    expect(del).toHaveBeenCalledWith(expect.anything(), { body: { name: "duel-2" } });
  });

  it("keeps the card and surfaces the error when the delete fails", async () => {
    vi.spyOn(playMiniappsRoute, "call").mockResolvedValue(twoApps);
    vi.spyOn(playDeleteRoute, "call").mockRejectedValue(new Error("miniapp 'duel' not found"));
    render(<Arcade apiBase="" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Duel")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Delete duel"));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(screen.getByText(/not found/i)).toBeTruthy());
    expect(screen.getByText("Duel")).toBeTruthy();         // still there — nothing was removed
  });
});
