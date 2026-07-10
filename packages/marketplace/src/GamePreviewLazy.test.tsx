// packages/marketplace/src/GamePreviewLazy.test.tsx
// The arcade mounts one sealed iframe per card, and each iframe PARSES AND RUNS a whole game. Twelve
// cards meant twelve games booting at once on first paint. These pin the deferral.
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { GamePreview } from "./GamePreview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

type Api = Parameters<typeof GamePreview>[0]["api"];
const api = (getGameHtml: () => Promise<string>): Api =>
  ({ getGameHtml, recordPlay: async () => true }) as unknown as Api;

// A controllable IntersectionObserver: nothing is visible until `reveal()` is called.
function stubObserver() {
  const cbs: ((e: { isIntersecting: boolean }[]) => void)[] = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(cb: (e: { isIntersecting: boolean }[]) => void) { cbs.push(cb); }
    observe() {}
    disconnect() {}
  });
  return { reveal: () => cbs.forEach((cb) => cb([{ isIntersecting: true }])) };
}

describe("GamePreview off-screen deferral", () => {
  it("does not fetch a game's html while the card is off-screen", async () => {
    stubObserver();
    const getGameHtml = vi.fn(async () => "<h1>PLAY ME</h1>");
    render(<GamePreview api={api(getGameHtml)} gemKey="@o/duel" version="1.0.0" />);
    await Promise.resolve();
    expect(getGameHtml).not.toHaveBeenCalled();
    const thumb = screen.getByRole("button", { name: /Play @o\/duel/ }) as HTMLButtonElement;
    expect(thumb.disabled).toBe(true);                                  // nothing to play yet
    expect(document.querySelector('iframe[title="mini-game"]')).toBeNull(); // and no game booted
  });

  it("fetches and boots the game once the card scrolls into view", async () => {
    const io = stubObserver();
    const getGameHtml = vi.fn(async () => "<h1>PLAY ME</h1>");
    render(<GamePreview api={api(getGameHtml)} gemKey="@o/duel" version="1.0.0" />);
    expect(getGameHtml).not.toHaveBeenCalled();

    io.reveal();
    await waitFor(() => expect(getGameHtml).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const f = document.querySelector('iframe[title="mini-game"]') as HTMLIFrameElement | null;
      expect(f?.getAttribute("srcdoc")).toContain("PLAY ME");
    });
  });

  it("fetches eagerly where IntersectionObserver does not exist (jsdom, old browsers)", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const getGameHtml = vi.fn(async () => "<h1>PLAY ME</h1>");
    render(<GamePreview api={api(getGameHtml)} gemKey="@o/duel" version="1.0.0" />);
    await waitFor(() => expect(getGameHtml).toHaveBeenCalledTimes(1));
  });
});
