// src/bind/__tests__/deviceFlow.test.ts
import { describe, it, expect } from "vitest";
import { requestDeviceCode, pollForToken } from "../deviceFlow.js";

function jsonFetch(...responses: unknown[]): typeof fetch {
  let i = 0;
  return (async () => { const body = responses[Math.min(i++, responses.length - 1)]; return { ok: true, status: 200, json: async () => body }; }) as unknown as typeof fetch;
}
const noSleep = async () => {};

describe("device flow", () => {
  it("requestDeviceCode maps the GitHub response", async () => {
    const f = jsonFetch({ device_code: "DC", user_code: "WXYZ-1234", verification_uri: "https://github.com/login/device", interval: 5 });
    expect(await requestDeviceCode("cid", f)).toEqual({ deviceCode: "DC", userCode: "WXYZ-1234", verificationUri: "https://github.com/login/device", interval: 5 });
  });
  it("pollForToken returns the token after authorization_pending", async () => {
    const f = jsonFetch({ error: "authorization_pending" }, { access_token: "gho_abc" });
    expect(await pollForToken("cid", "DC", { fetchImpl: f, sleep: noSleep })).toBe("gho_abc");
  });
  it("pollForToken throws on access_denied", async () => {
    const f = jsonFetch({ error: "access_denied" });
    await expect(pollForToken("cid", "DC", { fetchImpl: f, sleep: noSleep })).rejects.toThrow(/access_denied/);
  });
  it("pollForToken throws on expired_token", async () => {
    const f = jsonFetch({ error: "expired_token" });
    await expect(pollForToken("cid", "DC", { fetchImpl: f, sleep: noSleep })).rejects.toThrow(/expired_token/);
  });
});
