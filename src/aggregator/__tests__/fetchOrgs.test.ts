// src/aggregator/__tests__/fetchOrgs.test.ts
import { describe, it, expect } from "vitest";
import { fetchOrgs } from "@agentgem/aggregator";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}
const throwingFetch: typeof fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;

describe("fetchOrgs", () => {
  it("extracts org logins from GitHub /user/orgs", async () => {
    const f = fakeFetch(200, [{ login: "ninemind", id: 1 }, { login: "acme", id: 2 }]);
    expect(await fetchOrgs("tok", f)).toEqual(["ninemind", "acme"]);
  });
  it("returns [] on a non-2xx response", async () => {
    expect(await fetchOrgs("tok", fakeFetch(403, { message: "forbidden" }))).toEqual([]);
  });
  it("returns [] when the body is not an array", async () => {
    expect(await fetchOrgs("tok", fakeFetch(200, { message: "unexpected" }))).toEqual([]);
  });
  it("skips malformed entries (missing/non-string login)", async () => {
    const f = fakeFetch(200, [{ login: "ninemind" }, { id: 9 }, { login: 5 }]);
    expect(await fetchOrgs("tok", f)).toEqual(["ninemind"]);
  });
  it("returns [] when fetch throws", async () => {
    expect(await fetchOrgs("tok", throwingFetch)).toEqual([]);
  });
});
