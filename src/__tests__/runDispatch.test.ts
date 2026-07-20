// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { GemController } from "@agentgem/app/gem.controller";
import type { RunCloudDispatch } from "@agentgem/app/hostedBindings";

// GemController constructor params are all optional; runCloudDispatch is the last positional.
function makeController(dispatch?: RunCloudDispatch): GemController {
  return new GemController(undefined, dispatch);
}

describe("POST /api/run dispatch", () => {
  it("local mode never touches the cloud dispatch", async () => {
    // startLocal does real work on a missing workspace; we only assert routing, so tolerate
    // whatever it does and check the cloud dispatch was never consulted. (The happy local path
    // is covered by the integration suite in gem.controller.test.ts.)
    const dispatch = vi.fn();
    await makeController(dispatch as unknown as RunCloudDispatch)
      .run({ body: { name: "no-such-ws", target: "eve", mode: "local" } })
      .catch(() => undefined);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("cloud mode delegates to the injected dispatch with eveAuth", async () => {
    const dispatch = vi.fn(async () => ({ mode: "vercel" as const, state: "installing" as const, logTail: [] }));
    const state = await makeController(dispatch).run({
      body: { name: "ws", target: "eve", mode: "vercel", eveAuth: "public" },
    });
    expect(dispatch).toHaveBeenCalledWith("vercel", "ws", { eveAuth: "public" });
    expect(state.mode).toBe("vercel");
  });

  it("cloud mode with no dispatch bound rejects (deploy unavailable)", async () => {
    await expect(
      makeController(undefined).run({ body: { name: "ws", target: "flue", mode: "cloudflare" } }),
    ).rejects.toThrow(/not available/i);
  });
});
