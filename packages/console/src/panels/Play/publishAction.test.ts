// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { resolvePublishAction } from "./publishAction.js";

describe("resolvePublishAction", () => {
  it("publishes 0.1.0 for a brand-new app", () => {
    expect(resolvePublishAction({ exists: false, ownedByMe: false, latestVersion: null })).toEqual({ kind: "publish", version: "0.1.0" });
  });
  it("asks to confirm overwrite vs next version when the app is mine", () => {
    expect(resolvePublishAction({ exists: true, ownedByMe: true, latestVersion: "0.1.4" }))
      .toEqual({ kind: "confirm", latestVersion: "0.1.4", nextVersion: "0.1.5" });
  });
  it("reports 'taken' when the app exists under another account", () => {
    expect(resolvePublishAction({ exists: true, ownedByMe: false, latestVersion: "2.0.0" })).toEqual({ kind: "taken" });
  });
  it("falls back to 0.1.0 as the latest when mine but version is missing", () => {
    expect(resolvePublishAction({ exists: true, ownedByMe: true, latestVersion: null }))
      .toEqual({ kind: "confirm", latestVersion: "0.1.0", nextVersion: "0.1.1" });
  });
});
