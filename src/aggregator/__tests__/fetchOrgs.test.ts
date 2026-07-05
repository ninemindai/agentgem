// src/aggregator/__tests__/fetchOrgs.test.ts
import { describe, it, expect } from "vitest";
import { fetchOrgMemberships } from "@agentgem/aggregator";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}
const throwingFetch: typeof fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;

describe("fetchOrgMemberships", () => {
  it("extracts org login + role from GitHub /user/memberships/orgs", async () => {
    const f = fakeFetch(200, [
      { organization: { login: "ninemind" }, role: "admin", state: "active" },
      { organization: { login: "acme" }, role: "member", state: "active" },
    ]);
    expect(await fetchOrgMemberships("tok", f)).toEqual([
      { login: "ninemind", role: "admin" },
      { login: "acme", role: "member" },
    ]);
  });
  it("defaults unknown roles to member", async () => {
    const f = fakeFetch(200, [{ organization: { login: "ninemind" }, role: "billing_manager" }]);
    expect(await fetchOrgMemberships("tok", f)).toEqual([{ login: "ninemind", role: "member" }]);
  });
  it("returns [] on a non-2xx response", async () => {
    expect(await fetchOrgMemberships("tok", fakeFetch(403, { message: "forbidden" }))).toEqual([]);
  });
  it("returns [] when the body is not an array", async () => {
    expect(await fetchOrgMemberships("tok", fakeFetch(200, { message: "unexpected" }))).toEqual([]);
  });
  it("skips malformed entries (missing/non-string org login)", async () => {
    const f = fakeFetch(200, [{ organization: { login: "ninemind" }, role: "member" }, { id: 9 }, { organization: { login: 5 } }]);
    expect(await fetchOrgMemberships("tok", f)).toEqual([{ login: "ninemind", role: "member" }]);
  });
  it("returns [] when fetch throws", async () => {
    expect(await fetchOrgMemberships("tok", throwingFetch)).toEqual([]);
  });
});
