import { describe, it, expect } from "vitest";
import { injectHead } from "../og/inject.js";

const SHELL = `<!doctype html><html><head><title>AgentGem</title></head><body><div id="root"></div></body></html>`;

describe("injectHead", () => {
  it("rewrites the title and injects large-image OG + twitter tags before </head>", () => {
    const out = injectHead(SHELL, {
      title: "Pizza Panic", description: "Play on AgentGem", url: "https://app.agentgem.ai/games/pizza",
      image: "https://app.agentgem.ai/og/card.png?type=game&key=pizza",
    });
    expect(out).toContain("<title>Pizza Panic — AgentGem</title>");
    expect(out).toContain(`<meta property="og:title" content="Pizza Panic">`);
    expect(out).toContain(`<meta property="og:image" content="https://app.agentgem.ai/og/card.png?type=game&amp;key=pizza">`);
    expect(out).toContain(`<meta name="twitter:card" content="summary_large_image">`);
    expect(out).toContain(`<div id="root"></div>`); // body preserved so React still hydrates
    expect(out.indexOf("og:title")).toBeLessThan(out.indexOf("</head>"));
  });

  it("escapes angle brackets/quotes in text to prevent tag breakout", () => {
    const out = injectHead(SHELL, { title: `A<b>"&`, description: "d", url: "u", image: "i" });
    expect(out).toContain(`content="A&lt;b&gt;&quot;&amp;">`);
  });
});
