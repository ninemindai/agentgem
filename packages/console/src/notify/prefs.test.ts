import { describe, it, expect, afterEach } from "vitest";
import { readNotifyPref, writeNotifyPref, LS_NOTIFY } from "./prefs.js";

afterEach(() => localStorage.clear());

describe("notify prefs", () => {
  it("defaults to off when unset", () => {
    expect(readNotifyPref()).toBe(false);
  });
  it("round-trips on/off", () => {
    writeNotifyPref(true);
    expect(localStorage.getItem(LS_NOTIFY)).toBe("on");
    expect(readNotifyPref()).toBe(true);
    writeNotifyPref(false);
    expect(readNotifyPref()).toBe(false);
  });
});
