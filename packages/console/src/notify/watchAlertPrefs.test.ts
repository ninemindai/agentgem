import { describe, it, expect, afterEach } from "vitest";
import { readWatchAlertPrefs, writeWatchAlertPrefs, enrolledFiles, LS_WATCH_ALERTS } from "./watchAlertPrefs.js";

afterEach(() => localStorage.clear());

describe("watchAlertPrefs", () => {
  it("defaults to alerting on all sessions", () => {
    expect(readWatchAlertPrefs()).toEqual({ mode: "all", files: [] });
  });

  it("round-trips a selected-mode pref", () => {
    writeWatchAlertPrefs({ mode: "selected", files: ["/t/a.jsonl"] });
    expect(readWatchAlertPrefs()).toEqual({ mode: "selected", files: ["/t/a.jsonl"] });
  });

  it("falls back to the default on malformed storage", () => {
    localStorage.setItem(LS_WATCH_ALERTS, "{nope");
    expect(readWatchAlertPrefs()).toEqual({ mode: "all", files: [] });
  });

  it("enrolledFiles: mode=all enrolls every session", () => {
    expect(enrolledFiles({ mode: "all", files: [] }, ["/a", "/b"])).toEqual(new Set(["/a", "/b"]));
  });

  it("enrolledFiles: mode=selected enrolls only the listed files", () => {
    expect(enrolledFiles({ mode: "selected", files: ["/a"] }, ["/a", "/b"])).toEqual(new Set(["/a"]));
  });
});
