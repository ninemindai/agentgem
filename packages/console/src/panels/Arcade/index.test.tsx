// packages/console/src/panels/Arcade/index.test.tsx
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { ArcadePage } from "./index";
import { playMiniappsRoute, playMiniappRoute } from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Observe Arcade", () => {
  it("lists games and opens a playable sealed overlay on click", async () => {
    vi.spyOn(playMiniappsRoute, "call").mockResolvedValue({ miniapps: [{ name: "duel", title: "Duel", genre: "replay" }] });
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "duel", html: "<h1>DUEL GAME</h1>",
      meta: { title: "Duel", genre: "replay", createdFrom: { kind: "html", title: "Duel" }, engineVersion: "1" },
    } as never);
    render(<ArcadePage apiBase="" />);
    await waitFor(() => expect(screen.getByText("Duel")).toBeTruthy());
    fireEvent.click(screen.getByText("Duel"));
    await waitFor(() => expect(document.querySelector(".arcade-overlay")).toBeTruthy()); // play overlay opens
    await waitFor(() => {
      const f = document.querySelector(".arcade-overlay iframe") as HTMLIFrameElement | null;
      expect(f?.getAttribute("srcdoc")).toContain("DUEL GAME"); // the sealed game plays in it
    });
    expect(screen.getByText("✕ Close")).toBeTruthy();
  });
});
