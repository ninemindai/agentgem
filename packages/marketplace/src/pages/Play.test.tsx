import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { Play } from "./Play";

afterEach(() => cleanup());

function apiStub(over: Partial<{ getGameMeta: unknown; getGameHtml: unknown }> = {}) {
  return {
    getGameMeta: vi.fn().mockResolvedValue({ title: "Tetris", genre: "project-fun", version: "2.0.0" }),
    getGameHtml: vi.fn().mockResolvedValue("<!doctype html><title>t</title>"),
    ...over,
  } as never;
}

describe("Play", () => {
  it("resolves the bare key to a version, then fetches that version's html", async () => {
    const api = apiStub();
    render(<Play api={api} gemKey="@acme/tetris" />);

    await waitFor(() => expect((api as never as { getGameHtml: ReturnType<typeof vi.fn> }).getGameHtml)
      .toHaveBeenCalledWith("@acme/tetris", "2.0.0"));
  });

  it("renders the sealed iframe once html arrives", async () => {
    render(<Play api={apiStub()} gemKey="@acme/tetris" />);
    await waitFor(() => expect(document.querySelector("iframe[sandbox]")).not.toBeNull());
  });

  it("shows a not-found state for an unknown key instead of a blank iframe", async () => {
    const api = apiStub({ getGameMeta: vi.fn().mockRejectedValue(new Error("game-meta -> 404")) });
    render(<Play api={api} gemKey="@acme/nope" />);

    await waitFor(() => expect(screen.getByText(/doesn't exist/i)).toBeTruthy());
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("shows the not-found state when the gem resolves but has no game", async () => {
    const api = apiStub({ getGameHtml: vi.fn().mockRejectedValue(new Error("game-html -> 404")) });
    render(<Play api={api} gemKey="@acme/search" />);

    await waitFor(() => expect(screen.getByText(/doesn't exist/i)).toBeTruthy());
  });
});
