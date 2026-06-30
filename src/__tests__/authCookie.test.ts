// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { SESSION_COOKIE, parseCookies, serializeSessionCookie, clearSessionCookie } from "../auth/cookie.js";

describe("auth cookie", () => {
  it("parses a Cookie header into a map", () => {
    expect(parseCookies("a=1; ag_session=tok123; b=2")[SESSION_COOKIE]).toBe("tok123");
    expect(parseCookies(undefined)).toEqual({});
  });
  it("serializes the session cookie with the security attributes + domain", () => {
    const c = serializeSessionCookie("tok123", { domain: ".agentgem.ai", maxAgeSec: 3600 });
    expect(c).toContain("ag_session=tok123");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Domain=.agentgem.ai");
    expect(c).toContain("Max-Age=3600");
  });
  it("omits Domain when not provided (dev)", () => {
    expect(serializeSessionCookie("t", { maxAgeSec: 60 })).not.toContain("Domain=");
  });
  it("clearSessionCookie expires it (Max-Age=0)", () => {
    expect(clearSessionCookie({ domain: ".agentgem.ai" })).toContain("Max-Age=0");
  });
});
