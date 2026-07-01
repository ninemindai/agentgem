import { describe, it, expect, vi } from "vitest";
import { finishConnect } from "../connectCore.js";
import type { Identity } from "@agentgem/model";

const identity: Identity = { publicKey: "ed25519:PUB", sign: (d) => "sig(" + d.length + ")" };

function httpReturning(status: number, body: unknown) {
  return vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => ({ status, json: async () => body }));
}

describe("finishConnect", () => {
  it("binds and writes on a successful hosted bind", async () => {
    const write = vi.fn();
    const http = httpReturning(200, { bound: true, provider: "github", login: "octocat", accountId: "42" });
    const res = await finishConnect({
      clientId: "cid", deviceCode: "dc", interval: 5, base: "https://api.agentgem.ai",
      identity, pollForToken: async () => "gh-token", http, now: () => 1_000_000, write,
    });
    expect(res).toEqual({ connected: true, login: "octocat" });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ provider: "github", login: "octocat", accountId: "42" }));
    // forwarded to the hosted bind endpoint with the signed payload
    const [url, init] = http.mock.calls[0];
    expect(url).toBe("https://api.agentgem.ai/api/aggregator/bind");
    expect(JSON.parse(init.body)).toMatchObject({ pubkey: "ed25519:PUB", token: "gh-token", signedAt: 1_000_000 });
  });

  it("returns rejected without writing when the hosted side refuses", async () => {
    const write = vi.fn();
    const http = httpReturning(200, { bound: false, rejected: "unknown-producer" });
    const res = await finishConnect({
      clientId: "cid", deviceCode: "dc", interval: 5, base: "https://api.agentgem.ai",
      identity, pollForToken: async () => "gh-token", http, now: () => 1, write,
    });
    expect(res).toEqual({ connected: false, rejected: "unknown-producer" });
    expect(write).not.toHaveBeenCalled();
  });
});
