// packages/console/src/panels/Play/__tests__/consent.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { getMcpConsent, setMcpConsent, clearMcpConsent, getConsent, setConsent } from "../consent.js";

beforeEach(() => localStorage.clear());

describe("mcp consent (digest-pinned)", () => {
  it("stores and reads a {decision, digest} record", () => {
    setMcpConsent("app1", "github", "granted", "sha256:aaa");
    expect(getMcpConsent("app1", "github")).toEqual({ decision: "granted", digest: "sha256:aaa" });
  });

  it("is scoped per (miniapp, server)", () => {
    setMcpConsent("app1", "github", "granted", "sha256:aaa");
    expect(getMcpConsent("app2", "github")).toBeNull();
    expect(getMcpConsent("app1", "slack")).toBeNull();
  });

  it("stores a denial with its digest", () => {
    setMcpConsent("app1", "github", "denied", "sha256:bbb");
    expect(getMcpConsent("app1", "github")).toEqual({ decision: "denied", digest: "sha256:bbb" });
  });

  it("FAILS CLOSED on a legacy bare-string value (never a digest-pinned grant)", () => {
    // Simulate an old-scheme grant written under a colliding key.
    localStorage.setItem("agentgem:play:mcp-consent:app1:github", "granted");
    expect(getMcpConsent("app1", "github")).toBeNull();
  });

  it("FAILS CLOSED on malformed JSON / missing fields", () => {
    localStorage.setItem("agentgem:play:mcp-consent:app1:github", "{not json");
    expect(getMcpConsent("app1", "github")).toBeNull();
    localStorage.setItem("agentgem:play:mcp-consent:app1:slack", JSON.stringify({ decision: "granted" }));
    expect(getMcpConsent("app1", "slack")).toBeNull(); // no digest → not a valid pin
  });

  it("does not collide with the legacy per-cap getConsent scheme", () => {
    setConsent("app1", "local-project-access", "granted");
    expect(getMcpConsent("app1", "local-project-access")).toBeNull();
    expect(getConsent("app1", "local-project-access")).toBe("granted");
  });

  it("clearMcpConsent removes the record so the next read is null", () => {
    setMcpConsent("app1", "github", "granted", "sha256:aaa");
    clearMcpConsent("app1", "github");
    expect(getMcpConsent("app1", "github")).toBeNull();
  });
});
