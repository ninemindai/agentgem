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
  // The id subtitle earns its place only when the title can't identify the card. seedStudio sets
  // meta.title = the id, so printing it unconditionally would render the same string twice.
  it("shows the id under the title only when the title cannot identify the card", async () => {
    vi.spyOn(playMiniappsRoute, "call").mockResolvedValue({
      miniapps: [
        { name: "space-dodger", title: "Space Dodger", genre: "project-fun" },   // id inferable from title
        { name: "api", title: "api", genre: "project-fun" },                     // seeded: title IS the id
        { name: "space-dodger-2", title: "Space Dodger", genre: "project-fun" }, // suffixed: not inferable
        { name: "my-duel", title: "Anything", genre: "project-fun" },            // explicitly named
      ],
    });
    render(<Arcade apiBase="" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText("Space Dodger")).toHaveLength(2));

    // Both same-titled cards carry an id, so neither is left ambiguous.
    expect(screen.getByText("space-dodger")).toBeTruthy();
    expect(screen.getByText("space-dodger-2")).toBeTruthy();
    expect(screen.getByText("my-duel")).toBeTruthy();       // title says nothing about the id
    expect(screen.getAllByText("api")).toHaveLength(1);      // the title alone — no duplicate line
  });

  it("built-in (__-prefixed) cards have no delete affordance, but are still openable", async () => {
    vi.spyOn(playMiniappsRoute, "call").mockResolvedValue({
      miniapps: [
        { name: "__ember", title: "Ember", genre: "session-heatmap", needs: ["context-hygiene"] },
        { name: "duel", title: "Duel", genre: "project-fun" },
      ],
    });
    const onOpen = vi.fn();
    render(<Arcade apiBase="" onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText("Ember")).toBeTruthy());
    expect(screen.queryByLabelText("Delete __ember")).toBeNull();     // built-in: not deletable
    expect(screen.getByLabelText("Delete duel")).toBeTruthy();        // registry card: still deletable
    fireEvent.click(screen.getByText("Ember"));
    expect(onOpen).toHaveBeenCalledWith("__ember");                   // still opens
  });

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

    // Both cards already carry an id subtitle (same title), so once the confirm opens the id appears
    // twice: once on the card, once in the dialog naming what it will remove.
    fireEvent.click(screen.getByLabelText("Delete duel-2"));  // unambiguous even though titles collide
    expect(screen.getAllByText("duel-2")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(screen.getAllByText("Duel")).toHaveLength(1));
    expect(del).toHaveBeenCalledWith(expect.anything(), { body: { name: "duel-2" } });
  });

  // busy/error used to be component-scoped, so an in-flight delete on one card leaked into another's
  // dialog: opening B mid-delete showed "Deleting…", A's completion dismissed B, and A's failure showed
  // A's error inside B's overlay. Each card's confirm must stand on its own.
  it("an in-flight delete on one card cannot leak into another card's dialog", async () => {
    vi.spyOn(playMiniappsRoute, "call").mockResolvedValue(twoApps);
    let rejectA: (e: Error) => void = () => {};
    vi.spyOn(playDeleteRoute, "call").mockReturnValue(new Promise((_, rej) => { rejectA = rej; }) as never);
    render(<Arcade apiBase="" onOpen={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Duel")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Delete duel"));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));   // A is now in flight
    await waitFor(() => expect(screen.getByRole("button", { name: /deleting/i })).toBeTruthy());

    // While A is in flight, B's ✕ must not open a second dialog on top of it.
    expect(screen.getByLabelText("Delete auth-replay")).toHaveProperty("disabled", true);

    rejectA(new Error("boom"));                                          // A fails
    await waitFor(() => expect(screen.getByText(/boom/i)).toBeTruthy());
    // The error belongs to A's overlay only; B has no dialog and shows no error.
    expect(screen.getAllByText(/boom/i)).toHaveLength(1);
    expect(screen.getByText("duel")).toBeTruthy();                       // A's confirm still identifies A
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
