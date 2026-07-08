// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { deepLinkHash, argvDeepLink } from "../deeplink.js";

describe("deepLinkHash", () => {
  it("maps get-gems with a q param to the pre-searched console route (q re-encoded)", () => {
    expect(deepLinkHash("agentgem://get-gems?q=@raymondfeng/my-setup")).toBe("#/get-gems?q=%40raymondfeng%2Fmy-setup");
  });
  it("maps get-gems with no q to the bare tab route", () => {
    expect(deepLinkHash("agentgem://get-gems")).toBe("#/get-gems");
  });
  it("forwards install + version so an installable gem auto-installs (previously dropped)", () => {
    expect(deepLinkHash("agentgem://get-gems?install=raymondfeng/agentgem-biz&v=0.1.0"))
      .toBe("#/get-gems?install=raymondfeng%2Fagentgem-biz&v=0.1.0");
  });
  it("forwards every param verbatim (nothing is dropped)", () => {
    const h = deepLinkHash("agentgem://get-gems?install=@o/k&v=1.2.3");
    expect(h).toContain("install=%40o%2Fk");
    expect(h).toContain("v=1.2.3");
  });
  it("maps play with a seed to the Play route (the marketplace 'Make your own' link)", () => {
    const h = deepLinkHash('agentgem://play?new=1&title=duel-remix&prompt=Build my own "@me/duel"');
    expect(h?.startsWith("#/play?")).toBe(true);
    const q = new URLSearchParams(h!.split("?")[1]);
    expect(q.get("new")).toBe("1");
    expect(q.get("title")).toBe("duel-remix");
    expect(q.get("prompt")).toBe('Build my own "@me/duel"'); // survives round-trip unmangled
  });
  it("maps play with no query to the bare tab route", () => {
    expect(deepLinkHash("agentgem://play")).toBe("#/play");
  });
  it("returns null for a non-agentgem scheme", () => {
    expect(deepLinkHash("http://get-gems?q=x")).toBeNull();
    expect(deepLinkHash("https://app.agentgem.ai/gems/x")).toBeNull();
  });
  it("returns null for an unknown route", () => {
    expect(deepLinkHash("agentgem://deploy?ref=x")).toBeNull();
  });
  it("returns null for a malformed url", () => {
    expect(deepLinkHash("not a url")).toBeNull();
    expect(deepLinkHash("")).toBeNull();
  });
});

describe("argvDeepLink", () => {
  it("finds the agentgem:// url among launch args", () => {
    expect(argvDeepLink(["/path/to/AgentGem", "--flag", "agentgem://get-gems?q=k"])).toBe("agentgem://get-gems?q=k");
  });
  it("returns null when no deep link is present", () => {
    expect(argvDeepLink(["/path/to/AgentGem", "--flag"])).toBeNull();
  });
});
