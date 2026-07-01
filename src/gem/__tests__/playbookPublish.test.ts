// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { publishPlaybookCore } from "../playbookPublishCore.js";

describe("publishPlaybookCore", () => {
  it("publishes to the registry AND mints a share card, returning both refs", async () => {
    const calls: string[] = [];
    const r = await publishPlaybookCore({
      publish: async () => { calls.push("publish"); return { ref: "@me/my-playbook", version: "1.0.0" }; },
      share: async () => { calls.push("share"); return { id: "abc", url: "https://agentgem.ai/share/abc" }; },
    });
    expect(r).toEqual({ exploreRef: "@me/my-playbook", version: "1.0.0", shareUrl: "https://agentgem.ai/share/abc" });
    expect(calls).toEqual(["publish", "share"]);
  });

  it("still returns the explore ref if the share card fails (publish is the data-critical leg)", async () => {
    const r = await publishPlaybookCore({
      publish: async () => ({ ref: "@me/p", version: "1.0.0" }),
      share: async () => { throw new Error("share down"); },
    });
    expect(r).toMatchObject({ exploreRef: "@me/p", shareUrl: "" }); // share is best-effort
  });
});
