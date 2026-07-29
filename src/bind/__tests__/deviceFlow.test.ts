// src/bind/__tests__/deviceFlow.test.ts
import { describe, it, expect } from "vitest";
import { requestDeviceCode, pollForToken } from "@agentgem/app/bind/deviceFlow";

function jsonFetch(...responses: unknown[]): typeof fetch {
  let i = 0;
  return (async () => { const body = responses[Math.min(i++, responses.length - 1)]; return { ok: true, status: 200, json: async () => body }; }) as unknown as typeof fetch;
}
const noSleep = async () => {};

describe("device flow", () => {
  it("requestDeviceCode maps the GitHub response", async () => {
    const f = jsonFetch({ device_code: "DC", user_code: "WXYZ-1234", verification_uri: "https://github.com/login/device", interval: 5 });
    expect(await requestDeviceCode("cid", f)).toEqual({ deviceCode: "DC", userCode: "WXYZ-1234", verificationUri: "https://github.com/login/device", interval: 5, expiresInSec: 900 });
  });
  it("requestDeviceCode captures verification_uri_complete when GitHub returns it", async () => {
    const f = jsonFetch({ device_code: "DC", user_code: "WXYZ-1234", verification_uri: "https://github.com/login/device", verification_uri_complete: "https://github.com/login/device?user_code=WXYZ-1234", interval: 5 });
    expect(await requestDeviceCode("cid", f)).toMatchObject({ verificationUriComplete: "https://github.com/login/device?user_code=WXYZ-1234" });
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

  it("requestDeviceCode keeps GitHub's expires_in, and assumes 900s when it is absent", async () => {
    const withIt = jsonFetch({ device_code: "DC", user_code: "U", verification_uri: "https://x", interval: 5, expires_in: 599 });
    expect((await requestDeviceCode("cid", withIt)).expiresInSec).toBe(599);
    const without = jsonFetch({ device_code: "DC", user_code: "U", verification_uri: "https://x", interval: 5 });
    expect((await requestDeviceCode("cid", without)).expiresInSec).toBe(900);
  });

  // The deadline used to be 60 attempts, so how long we actually waited depended on the
  // interval GitHub happened to send — 60x5s is five minutes, 60x10s is ten. It is a time
  // budget now, and holds whatever the interval is.
  it("pollForToken spends a time budget, not a fixed number of attempts", async () => {
    let polls = 0;
    const pending = (async () => { polls++; return { ok: true, status: 200, json: async () => ({ error: "authorization_pending" }) }; }) as unknown as typeof fetch;
    await expect(pollForToken("cid", "DC", { fetchImpl: pending, sleep: noSleep, budgetSec: 20, intervalSec: 5 }))
      .rejects.toThrow(/timed out/);
    expect(polls).toBe(5); // t=0,5,10,15,20 — one last poll at the edge, then give up

    polls = 0;
    await expect(pollForToken("cid", "DC", { fetchImpl: pending, sleep: noSleep, budgetSec: 20, intervalSec: 10 }))
      .rejects.toThrow(/timed out/);
    expect(polls).toBe(3); // t=0,10,20 — same 20s, a slower interval, no extra waiting
  });

  it("pollForToken reports each wait so a caller can prove it is still alive", async () => {
    const pending = (async () => ({ ok: true, status: 200, json: async () => ({ error: "authorization_pending" }) })) as unknown as typeof fetch;
    const seen: number[] = [];
    await expect(pollForToken("cid", "DC", {
      fetchImpl: pending, sleep: noSleep, budgetSec: 20, intervalSec: 5,
      onPending: ({ remainingSec }) => seen.push(remainingSec),
    })).rejects.toThrow(/timed out/);
    expect(seen).toEqual([15, 10, 5, 0]);
  });

  it("pollForToken backs off on slow_down and still returns the token", async () => {
    const slept: number[] = [];
    const f = jsonFetch({ error: "slow_down" }, { error: "authorization_pending" }, { access_token: "gho_z" });
    const token = await pollForToken("cid", "DC", { fetchImpl: f, intervalSec: 5, sleep: async (ms) => { slept.push(ms); } });
    expect(token).toBe("gho_z");
    expect(slept).toEqual([10_000, 10_000]); // 5s -> 10s after the slow_down, and it stays there
  });
});
