// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/emitAdoption.test.ts
import { describe, it, expect, vi } from "vitest";
import { emitAdoption } from "../../registry/emitAdoption.js";
import { loadOrCreateIdentity } from "@agentgem/model";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALLED = [{ gemKey: "@acme/kit", version: "1.2.3", gemDigest: "" }];

describe("emitAdoption", () => {
  it("posts nothing when shareAdoption is false", async () => {
    const post = vi.fn().mockResolvedValue({ ingestId: "x" });
    await emitAdoption(INSTALLED, {
      enabled: () => false,
      adoptUrl: "https://example.com/adopt",
      post,
    });
    expect(post).toHaveBeenCalledTimes(0);
  });

  it("posts one signed event per installed ref when enabled and url set", async () => {
    const identity = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "ag-emit-")));
    const post = vi.fn().mockResolvedValue({ ingestId: "test-id" });
    await emitAdoption(INSTALLED, {
      enabled: () => true,
      adoptUrl: "https://example.com/adopt",
      identity,
      post,
      now: 1234,
    });
    expect(post).toHaveBeenCalledTimes(1);
    const args = post.mock.calls[0][0] as { adoption: { gemKey: string; version: string; producer: { publicKey: string } }; endpoint: string };
    expect(args.adoption.gemKey).toBe("@acme/kit");
    expect(args.adoption.version).toBe("1.2.3");
    expect(args.adoption.producer.publicKey).toMatch(/^ed25519:/);
    expect(args.endpoint).toBe("https://example.com/adopt");
  });

  it("resolves (never rejects) when post throws", async () => {
    const identity = loadOrCreateIdentity(mkdtempSync(join(tmpdir(), "ag-emit-throw-")));
    const post = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      emitAdoption(INSTALLED, {
        enabled: () => true,
        adoptUrl: "https://example.com/adopt",
        identity,
        post,
      })
    ).resolves.toBeUndefined();
  });
});
