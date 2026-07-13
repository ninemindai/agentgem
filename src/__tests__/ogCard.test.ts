import { describe, it, expect } from "vitest";
import { renderCardSvg, placeholderSvg } from "../og/card.js";

describe("renderCardSvg", () => {
  it("renders a 1200x630 SVG with the title, subtitle, per-type label and wordmark", () => {
    const svg = renderCardSvg({ type: "game", title: "Pizza Panic", subtitle: "Play on AgentGem" });
    expect(svg).toContain(`width="1200"`);
    expect(svg).toContain(`height="630"`);
    expect(svg).toContain("Pizza Panic");
    expect(svg).toContain("Play on AgentGem");
    expect(svg).toContain("Miniapp");   // per-type label for game
    expect(svg).toContain("AgentGem");  // wordmark
  });

  it("escapes markup so text cannot break out of the SVG", () => {
    const svg = renderCardSvg({ type: "gem", title: `A & B <x>`, subtitle: `"q"` });
    expect(svg).toContain("A &amp; B &lt;x&gt;");
    expect(svg).not.toContain("<x>");
    expect(svg).toContain("&quot;q&quot;");
  });

  it("caps very long titles with a trailing ellipsis", () => {
    const svg = renderCardSvg({ type: "gem", title: "x".repeat(200), subtitle: "s" });
    expect(svg).toContain("…");
  });

  it("placeholder renders a generic branded card", () => {
    const svg = placeholderSvg();
    expect(svg).toContain(`width="1200"`);
    expect(svg).toContain("AgentGem");
  });
});

describe("renderCardSvg with a screenshot", () => {
  const shot = "data:image/png;base64,iVBORw0KGgo=";
  it("embeds the screenshot as an <image> hero with title + wordmark over a legibility band", () => {
    const svg = renderCardSvg({ type: "game", title: "Pizza Panic", subtitle: "Play on AgentGem", screenshotDataUri: shot });
    expect(svg).toContain(`<image href="${shot}"`);
    expect(svg).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(svg).toContain("Pizza Panic");
    expect(svg).toContain("AgentGem");
    expect(svg).toContain("opacity"); // the semi-opaque legibility band behind the text
  });
  it("falls back to the synthetic frame when no screenshot is given", () => {
    const svg = renderCardSvg({ type: "game", title: "Pizza", subtitle: "Play on AgentGem" });
    expect(svg).not.toContain("<image");
    expect(svg).toContain("Miniapp"); // the per-type label frame
  });
});
