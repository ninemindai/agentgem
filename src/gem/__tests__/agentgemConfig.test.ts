// src/gem/__tests__/agentgemConfig.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readShareAdoption, setShareAdoption } from "../../agentgemConfig.js";
import { useHermeticHome } from "../../__tests__/support/hermeticHome.js";

let restore: () => void;
beforeAll(() => { restore = useHermeticHome(); });
afterAll(() => restore());

describe("agentgem config — shareAdoption", () => {
  it("defaults to OFF when no config file exists (the load-bearing opt-in default)", () => {
    expect(readShareAdoption()).toBe(false); // hermetic empty home → no config.json → false
  });
  it("round-trips the opt-in through the config file", () => {
    setShareAdoption(true);
    expect(readShareAdoption()).toBe(true);
    setShareAdoption(false);
    expect(readShareAdoption()).toBe(false);
  });
});
