import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GemController } from "../gem.controller.js";
import { useHermeticHome } from "./support/hermeticHome.js";

let restoreHome: () => void;
beforeAll(() => { restoreHome = useHermeticHome(); });
afterAll(() => restoreHome());

describe("GemController.observe", () => {
  it("returns an ObservePayload for a valid range without throwing", async () => {
    const c = new GemController();
    const out = await c.observe({ query: { range: "all" } });
    expect(out.range).toBe("all");
    expect(Array.isArray(out.daily)).toBe(true);
    expect(Array.isArray(out.sessions)).toBe(true);
    expect(Array.isArray(out.models)).toBe(true);
    expect(typeof out.pulse.sessions).toBe("number");
  });

  it("defaults to 7d when range is omitted", async () => {
    const c = new GemController();
    const out = await c.observe({ query: {} });
    expect(out.range).toBe("7d");
  });

  it("accepts filter params and returns facets with array fields", async () => {
    const c = new GemController();
    const out = await c.observe({ query: { range: "all", agent: "claude" } });
    expect(out.facets).toBeDefined();
    expect(Array.isArray(out.facets.agents)).toBe(true);
    expect(Array.isArray(out.facets.projects)).toBe(true);
    expect(Array.isArray(out.facets.models)).toBe(true);
  });
});
