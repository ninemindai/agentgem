// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseRecallFrame } from "./recallStream.js";

describe("parseRecallFrame", () => {
  it("parses a session_done frame", () => {
    expect(parseRecallFrame("session_done", JSON.stringify({ type: "session_done", sessionId: "s1", answered: true })))
      .toEqual({ type: "session_done", sessionId: "s1", answered: true });
  });
  it("maps the server 'failed' frame to a failed event", () => {
    expect(parseRecallFrame("failed", JSON.stringify({ error: "boom" }))).toEqual({ type: "failed", error: "boom" });
  });
  it("returns null for unknown/garbage", () => {
    expect(parseRecallFrame("weird", "{}")).toBeNull();
    expect(parseRecallFrame("done", "not json")).toBeNull();
  });
});
