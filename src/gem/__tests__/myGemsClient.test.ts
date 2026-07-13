// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import type { Identity } from "@agentgem/model";
import { postMyGems, type MyGemsHttp } from "../myGemsClient.js";

function signer(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = "ed25519:" + publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return {
    publicKey: pubkey,
    sign: (data: string) => edSign(null, Buffer.from(data, "utf8"), privateKey).toString("base64"),
  } as Identity;
}

describe("postMyGems", () => {
  it("POSTs a signed request to /api/aggregator/my-gems and returns the owned gems on 200", async () => {
    const identity = signer();
    const gems = [{ key: "@octocat/demo", version: "0.1.0", name: "demo" }];
    let seenUrl = "";
    let seenBody: any;
    const http: MyGemsHttp = async (url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(init.body);
      return { status: 200, json: async () => ({ gems }) };
    };
    const result = await postMyGems({ identity, endpoint: "https://x", http, now: () => 1000 });
    expect(seenUrl).toBe("https://x/api/aggregator/my-gems");
    expect(seenBody).toEqual({ pubkey: identity.publicKey, signedAt: 1000, signature: expect.any(String) });
    expect(result).toEqual(gems);
  });

  it("returns [] on a non-2xx response", async () => {
    const identity = signer();
    const http: MyGemsHttp = async () => ({ status: 500, json: async () => ({}) });
    expect(await postMyGems({ identity, endpoint: "https://x", http })).toEqual([]);
  });

  it("returns [] when http throws", async () => {
    const identity = signer();
    const http: MyGemsHttp = async () => { throw new Error("network"); };
    expect(await postMyGems({ identity, endpoint: "https://x", http })).toEqual([]);
  });

  it("returns [] when the response body is missing gems", async () => {
    const identity = signer();
    const http: MyGemsHttp = async () => ({ status: 200, json: async () => ({}) });
    expect(await postMyGems({ identity, endpoint: "https://x", http })).toEqual([]);
  });
});
