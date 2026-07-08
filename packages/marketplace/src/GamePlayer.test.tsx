// packages/marketplace/src/GamePlayer.test.tsx
import { render, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { GamePlayer } from "./GamePlayer";

afterEach(cleanup);

const frame = () => document.querySelector('iframe[title="mini-game"]') as HTMLIFrameElement;

describe("GamePlayer", () => {
  // Games size themselves against their own viewport, so a fullscreen player that kept the thumbnail's
  // virtual 1200x780 window would only upscale the game rather than play it at screen size.
  it("gives a fullscreen game the overlay's real size, not the scaled virtual window", () => {
    render(<GamePlayer html="<h1>hi</h1>" startFullscreen />);
    expect(frame().style.width).toBe("100%");
    expect(frame().style.height).toBe("100%");
    expect(frame().style.transform).toBe("");
  });

  it("renders a thumbnail at the virtual window so every card frames a game the same way", () => {
    render(<GamePlayer html="<h1>hi</h1>" interactive={false} vw={1200} vh={780} />);
    expect(frame().style.width).toBe("1200px");
    expect(frame().style.transform).toContain("scale(");
  });

  // The document must not be handed to a frame the browser has not sized yet: it parses immediately and
  // a game that measures its stage once would be stuck at a 0x0 fallback forever.
  it("loads the sealed html only after the frame is mounted", () => {
    render(<GamePlayer html="<h1>PLAY ME</h1>" startFullscreen />);
    expect(frame().getAttribute("srcdoc")).toContain("PLAY ME");
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
  });
});
