import { describe, it, expect, afterEach } from "vitest";
import { readNotifyPref, writeNotifyPref, LS_NOTIFY } from "./prefs.js";

afterEach(() => {
  localStorage.clear();
  delete (window as { agentgem?: unknown }).agentgem;
});

describe("notify prefs", () => {
  it("defaults to off when unset in a plain browser (no native bridge)", () => {
    expect(readNotifyPref()).toBe(false);
  });
  it("defaults to on when unset and the desktop native bridge is present", () => {
    (window as { agentgem?: unknown }).agentgem = { notify: () => {} };
    expect(readNotifyPref()).toBe(true);
  });
  it("an explicit stored preference wins over the platform default", () => {
    (window as { agentgem?: unknown }).agentgem = { notify: () => {} };
    writeNotifyPref(false);
    expect(readNotifyPref()).toBe(false); // off beats the desktop default-on
  });
  it("round-trips on/off", () => {
    writeNotifyPref(true);
    expect(localStorage.getItem(LS_NOTIFY)).toBe("on");
    expect(readNotifyPref()).toBe(true);
    writeNotifyPref(false);
    expect(readNotifyPref()).toBe(false);
  });
});
