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
