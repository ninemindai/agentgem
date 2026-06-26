import { describe, it, expect } from "vitest";
import { materialize } from "../targets.js";
import { makeChannelArtifact } from "../channels.js";

const gemWith = (...platforms: string[]) => ({
  name: "demo", createdFrom: "test", checks: [], requiredSecrets: [],
  artifacts: platforms.map((p) => makeChannelArtifact(p as Parameters<typeof makeChannelArtifact>[0])),
});

describe("channel materialize", () => {
  it("Eve emits agent/channels/<name>.ts from the registry scaffold", () => {
    const r = materialize(gemWith("slack"), "eve");
    expect(r.files["agent/channels/slack.ts"]).toContain("slackChannel");
    expect(r.skipped.find((s) => s.type === "channel")).toBeUndefined();
  });

  it("Eve still emits the always-on web channel eve.ts alongside declared channels", () => {
    const r = materialize(gemWith("telegram"), "eve");
    expect(r.files["agent/channels/eve.ts"]).toBeDefined();
    expect(r.files["agent/channels/telegram.ts"]).toBeDefined();
  });

  it("a non-Eve target skips the channel with a reason and emits no channel file", () => {
    const r = materialize(gemWith("slack"), "flue");
    expect(Object.keys(r.files).some((p) => p.includes("channels/slack"))).toBe(false);
    expect(r.skipped).toContainEqual(expect.objectContaining({ artifact: "slack", type: "channel" }));
  });
});
