import { describe, it, expect } from "vitest";
import { shareIntents } from "./shareIntents.js";

describe("shareIntents", () => {
  it("builds platform share URLs that encode the hosted url", () => {
    const u = "https://agentgem.ai/share/abc";
    const i = shareIntents(u);
    expect(i.x).toContain("https://x.com/intent/tweet");
    expect(i.x).toContain(encodeURIComponent(u));
    expect(i.linkedin).toContain("linkedin.com");
    expect(i.linkedin).toContain(encodeURIComponent(u));
    expect(i.facebook).toContain("facebook.com/sharer");
    expect(i.facebook).toContain(encodeURIComponent(u));
  });
});
