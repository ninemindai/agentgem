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

  it("neutralizes in-page '#' anchors so they can't escape the srcdoc frame to the host page", () => {
    // A srcdoc frame inherits the PARENT's URL as its base, so a hash-router game's <a href="#/route">
    // resolves to the host page URL — a cross-document navigation that loads the whole SPA shell inside
    // the null-origin frame, where its crossorigin assets fail CORS and the game goes blank.
    render(<GamePlayer html='<a href="#/find-my-match">go</a>' startFullscreen />);
    const doc = frame().getAttribute("srcdoc")!;
    expect(doc).toContain("addEventListener('click'");
    expect(doc).toContain("location.hash");
    // armed before the body so the listener is live before the game's own scripts/clicks
    expect(doc.indexOf("location.hash")).toBeLessThan(doc.indexOf("<body"));
  });

  it("keeps the CSP meta ahead of a script placed before <head> (pre-CSP execution)", () => {
    // With naive head-injection, a script placed BEFORE <head> runs at parse time before the CSP
    // meta applies — free to open a connection the policy would block.
    render(<GamePlayer html="<script>window.__evil=1</script><head><title>t</title></head><body>x</body>" startFullscreen />);
    const doc = frame().getAttribute("srcdoc")!;
    const cspAt = doc.indexOf("Content-Security-Policy");
    const evilAt = doc.indexOf("__evil");
    expect(cspAt).toBeGreaterThanOrEqual(0);
    expect(evilAt).toBeGreaterThanOrEqual(0);
    expect(cspAt).toBeLessThan(evilAt); // CSP parses first → the script runs under the policy
  });
});
