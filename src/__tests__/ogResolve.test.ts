// resolveCard mirrors the entity route shapes in packages/marketplace/src/Router.tsx
// (the source of truth). If a NEW shareable route is added there, add it here too.
import { describe, it, expect } from "vitest";
import { resolveCard } from "../og/resolve.js";

describe("resolveCard", () => {
  it("resolves the four entity shapes", () => {
    expect(resolveCard("/games/@acme/tetris")).toEqual({ type: "game", key: "@acme/tetris" });
    expect(resolveCard("/gems/@acme/toolkit")).toEqual({ type: "gem", key: "@acme/toolkit" });
    expect(resolveCard("/@ada")).toEqual({ type: "profile", key: "ada" });
    expect(resolveCard("/skills/github-xyz/agents/reviewer.md"))
      .toEqual({ type: "skill", key: "github-xyz/agents/reviewer.md" });
  });

  it("decodes percent-escapes in the captured key", () => {
    expect(resolveCard("/gems/@acme%2Ftool")).toEqual({ type: "gem", key: "@acme/tool" });
  });

  it("returns null for collection roots and non-entity paths", () => {
    for (const p of ["/", "/games", "/gems", "/skills", "/api/aggregator/game-meta", "/og/card.png", "/@"]) {
      expect(resolveCard(p)).toBeNull();
    }
  });
});
