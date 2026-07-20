// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach } from "vitest";

// The proxy forwards to the hosted aggregator via postShare; mock it so the test stays offline
// and can assert exactly what would be forwarded.
const postShare = vi.hoisted(() => vi.fn());
vi.mock("../gem/shareClient.js", () => ({ postShare }));

import { ShareProxyController } from "../share.proxy.controller.js";

beforeEach(() => {
  postShare.mockReset();
  postShare.mockResolvedValue({ id: "abc1234567", url: "https://agentgem.ai/share/abc1234567" });
});

describe("ShareProxyController.create", () => {
  it("returns 422 for a whitespace-only gem name and does NOT forward upstream (was a 500)", async () => {
    const c = new ShareProxyController();
    await expect(
      c.create({ body: { kind: "gem", name: "   ", provenance: "x", generatedAtMs: 1 } }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(postShare).not.toHaveBeenCalled();
  });

  it("sanitizes name/provenance before forwarding a valid gem share", async () => {
    const c = new ShareProxyController();
    await c.create({ body: { kind: "gem", name: "  my-gem  ", provenance: "  from 3 sessions  ", generatedAtMs: 1 } });
    expect(postShare).toHaveBeenCalledTimes(1);
    expect((postShare.mock.calls[0][0] as { body: unknown }).body).toMatchObject({ kind: "gem", name: "my-gem", provenance: "from 3 sessions" });
  });

  it("forwards a certificate share unchanged", async () => {
    const c = new ShareProxyController();
    const res = await c.create({ body: { kind: "certificate", counts: { breadth: 5, battleTested: 2, portable: 1 }, generatedAtMs: 1 } });
    expect(postShare).toHaveBeenCalledTimes(1);
    expect(res.url).toContain("/share/");
  });
});
