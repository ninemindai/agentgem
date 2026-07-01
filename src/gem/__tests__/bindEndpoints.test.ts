// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/bindEndpoints.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useHermeticHome } from "../../__tests__/support/hermeticHome.js";
import { GemController } from "../../gem.controller.js";

// Fresh hermetic home PER TEST so tests are order-independent (a prior /bind/complete
// writing binding.json must not leak into another test's home).
let restore: () => void;
beforeEach(() => { restore = useHermeticHome(); });
afterEach(() => restore());

function jsonFetch(body: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

const fakeIdentity = { publicKey: "ed25519:FAKEKEY==", sign: (_data: string) => "FAKESIG==" };

const fakeCode = { deviceCode: "dc", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", interval: 5 };

describe("/bind/start", () => {
  it("returns {configured:false} when AGENTGEM_GITHUB_CLIENT_ID is unset", async () => {
    const prev = process.env.AGENTGEM_GITHUB_CLIENT_ID;
    delete process.env.AGENTGEM_GITHUB_CLIENT_ID;
    try {
      const controller = new GemController();
      const result = await controller.bindStart({ body: {} });
      expect(result).toEqual({ configured: false });
    } finally {
      if (prev !== undefined) process.env.AGENTGEM_GITHUB_CLIENT_ID = prev;
    }
  });

  it("returns {configured:true, ...deviceCode} when clientId is set", async () => {
    const prev = process.env.AGENTGEM_GITHUB_CLIENT_ID;
    process.env.AGENTGEM_GITHUB_CLIENT_ID = "test-client-id";
    try {
      const controller = new GemController();
      const result = await controller.bindStart({ body: {} }, { requestCode: async () => fakeCode });
      expect(result).toEqual({ configured: true, ...fakeCode });
    } finally {
      if (prev === undefined) delete process.env.AGENTGEM_GITHUB_CLIENT_ID;
      else process.env.AGENTGEM_GITHUB_CLIENT_ID = prev;
    }
  });
});

describe("/bind/status", () => {
  it("returns {bound:false} on empty home (hermetic)", async () => {
    const controller = new GemController();
    const result = await controller.bindStatus({ query: {} });
    expect(result).toEqual({ bound: false });
  });
});

describe("/bind/complete", () => {
  it("threads deviceCode+interval to completeDeviceBind and returns the result", async () => {
    const prev1 = process.env.AGENTGEM_GITHUB_CLIENT_ID;
    const prev2 = process.env.AGENTGEM_AGGREGATOR_URL;
    process.env.AGENTGEM_GITHUB_CLIENT_ID = "test-client-id";
    process.env.AGENTGEM_AGGREGATOR_URL = "http://agg.local";
    try {
      const controller = new GemController();
      const result = await controller.bindComplete(
        { body: { deviceCode: "dc-test", interval: 5 } },
        { poll: async () => "tok-xyz", identity: fakeIdentity, fetchImpl: jsonFetch({ bound: true, provider: "github", login: "bob", accountId: "2" }) },
      );
      expect(result).toEqual({ bound: true, provider: "github", login: "bob", accountId: "2" });
    } finally {
      if (prev1 === undefined) delete process.env.AGENTGEM_GITHUB_CLIENT_ID;
      else process.env.AGENTGEM_GITHUB_CLIENT_ID = prev1;
      if (prev2 === undefined) delete process.env.AGENTGEM_AGGREGATOR_URL;
      else process.env.AGENTGEM_AGGREGATOR_URL = prev2;
    }
  });
});
