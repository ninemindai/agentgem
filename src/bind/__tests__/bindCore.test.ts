// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/bind/__tests__/bindCore.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { useHermeticHome } from "../../__tests__/support/hermeticHome.js";
import { bindConfig, startDeviceBind, completeDeviceBind, readBindingStatus } from "../bindCore.js";

let restore: () => void;
beforeAll(() => { restore = useHermeticHome(); });
afterAll(() => restore());

// Minimal fake Identity: fixed key and deterministic signature.
const fakeIdentity = { publicKey: "ed25519:FAKEKEY==", sign: (_data: string) => "FAKESIG==" };

// Helper to build a minimal JSON fetch that returns the given body.
function jsonFetch(body: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;
}

describe("bindConfig", () => {
  it("falls back to the canonical hosted app when env vars unset", () => {
    const prev1 = process.env.AGENTGEM_GITHUB_CLIENT_ID;
    const prev2 = process.env.AGENTGEM_AGGREGATOR_URL;
    delete process.env.AGENTGEM_GITHUB_CLIENT_ID;
    delete process.env.AGENTGEM_AGGREGATOR_URL;
    try {
      const cfg = bindConfig();
      // Device-flow client IDs are public, so we ship a default so Connect works out of the box.
      expect(cfg.clientId).toBe("Ov23liCbBVnhr7AH9FkF");
      expect(cfg.base).toBe("https://api.agentgem.ai");
    } finally {
      if (prev1 !== undefined) process.env.AGENTGEM_GITHUB_CLIENT_ID = prev1;
      if (prev2 !== undefined) process.env.AGENTGEM_AGGREGATOR_URL = prev2;
    }
  });

  it("prefers env overrides when set", () => {
    const prev1 = process.env.AGENTGEM_GITHUB_CLIENT_ID;
    const prev2 = process.env.AGENTGEM_AGGREGATOR_URL;
    process.env.AGENTGEM_GITHUB_CLIENT_ID = "self-hosted-id";
    process.env.AGENTGEM_AGGREGATOR_URL = "http://agg.local";
    try {
      const cfg = bindConfig();
      expect(cfg.clientId).toBe("self-hosted-id");
      expect(cfg.base).toBe("http://agg.local");
    } finally {
      if (prev1 === undefined) delete process.env.AGENTGEM_GITHUB_CLIENT_ID;
      else process.env.AGENTGEM_GITHUB_CLIENT_ID = prev1;
      if (prev2 === undefined) delete process.env.AGENTGEM_AGGREGATOR_URL;
      else process.env.AGENTGEM_AGGREGATOR_URL = prev2;
    }
  });
});

describe("readBindingStatus", () => {
  it("returns {bound:false} on empty home", () => {
    expect(readBindingStatus()).toEqual({ bound: false });
  });

  it("returns {bound:true, login, provider} after a bound write", () => {
    const dir = join(homedir(), ".agentgem");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, "binding.json"),
      JSON.stringify({ provider: "github", login: "alice", accountId: "1", boundAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    expect(readBindingStatus()).toEqual({ bound: true, login: "alice", provider: "github" });
  });
});

describe("startDeviceBind", () => {
  it("throws when clientId is unset", async () => {
    await expect(startDeviceBind({})).rejects.toThrow("not configured");
  });

  it("calls requestCode with clientId", async () => {
    const calls: string[] = [];
    const fakeCode = { deviceCode: "dc", userCode: "UC", verificationUri: "https://example.com", interval: 5 };
    const requestCode = async (cid: string) => { calls.push(cid); return fakeCode; };
    const result = await startDeviceBind({ clientId: "myclientid" }, { requestCode });
    expect(calls).toEqual(["myclientid"]);
    expect(result).toEqual(fakeCode);
  });
});

describe("completeDeviceBind", () => {
  it("returns not-configured when clientId missing", async () => {
    const result = await completeDeviceBind({}, { deviceCode: "dc" });
    expect(result).toEqual({ bound: false, rejected: "not-configured" });
  });

  it("POSTs to aggregator and writes binding.json on {bound:true}", async () => {
    const fetched: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
      fetched.push({ url: url.toString(), body: JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown> });
      return { ok: true, status: 200, json: async () => ({ bound: true, provider: "github", login: "alice", accountId: "1" }) };
    }) as unknown as typeof fetch;

    const result = await completeDeviceBind(
      { clientId: "cid", base: "http://agg.local" },
      { deviceCode: "dc123", interval: 5 },
      { poll: async () => "tok-abc", identity: fakeIdentity, fetchImpl: fakeFetch, now: 12345678 },
    );

    expect(result).toEqual({ bound: true, provider: "github", login: "alice", accountId: "1" });
    expect(fetched).toHaveLength(1);
    expect(fetched[0].url).toMatch(/\/api\/aggregator\/bind$/);
    const body = fetched[0].body;
    expect(body.pubkey).toBe(fakeIdentity.publicKey);
    expect(body.token).toBe("tok-abc");
    expect(body.signedAt).toBe(12345678);
    expect(body.signature).toBe("FAKESIG==");

    // binding.json must exist and not contain the raw token
    const bindingRaw = readFileSync(join(homedir(), ".agentgem", "binding.json"), "utf8");
    const binding = JSON.parse(bindingRaw) as Record<string, unknown>;
    expect(binding.login).toBe("alice");
    expect(binding.provider).toBe("github");
    expect(binding.accountId).toBe("1");
    expect(bindingRaw).not.toContain("tok-abc");
  });

  it("does NOT write binding.json on {bound:false}", async () => {
    // Remove any previous binding.json first
    const bindPath = join(homedir(), ".agentgem", "binding.json");
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(bindPath);
    } catch { /* not present */ }

    const fakeFetch = jsonFetch({ bound: false, rejected: "bad-signature" });
    const result = await completeDeviceBind(
      { clientId: "cid", base: "http://agg.local" },
      { deviceCode: "dc-reject" },
      { poll: async () => "tok-bad", identity: fakeIdentity, fetchImpl: fakeFetch },
    );

    expect(result).toEqual({ bound: false, rejected: "bad-signature" });
    // binding.json must NOT have been created
    try {
      readFileSync(bindPath);
      expect.fail("binding.json should not exist after a rejected bind");
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});
