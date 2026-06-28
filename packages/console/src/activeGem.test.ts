import { describe, it, expect, beforeEach } from "vitest";
import { setKeys, toggleKey, clearKeys, setName, resetGem, getKeys, getName, subscribe } from "./activeGem.js";

beforeEach(() => resetGem());

describe("activeGem store", () => {
  it("set / toggle / clear keys", () => {
    setKeys(new Set(["skills::pdf"]));
    expect([...getKeys()]).toEqual(["skills::pdf"]);
    toggleKey("skills::csv");
    expect(getKeys().has("skills::csv")).toBe(true);
    toggleKey("skills::pdf");
    expect(getKeys().has("skills::pdf")).toBe(false);
    clearKeys();
    expect(getKeys().size).toBe(0);
  });

  it("name + resetGem", () => {
    setName("my-gem");
    setKeys(new Set(["skills::pdf"]));
    expect(getName()).toBe("my-gem");
    resetGem();
    expect(getName()).toBe("");
    expect(getKeys().size).toBe(0);
  });

  it("notifies subscribers", () => {
    let hits = 0;
    const unsub = subscribe(() => { hits++; });
    setName("x");
    toggleKey("a");
    unsub();
    setName("y");
    expect(hits).toBe(2); // not 3 — unsubscribed before the last
  });
});
