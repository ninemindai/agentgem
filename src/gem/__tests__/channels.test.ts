import { describe, it, expect } from "vitest";
import { CHANNEL_REGISTRY, channelScaffold, makeChannelArtifact } from "../channels.js";
import type { ChannelPlatform } from "../types.js";

const PLATFORMS: ChannelPlatform[] = ["slack", "telegram", "discord", "teams", "twilio", "github"];

describe("CHANNEL_REGISTRY", () => {
  it("has a complete entry for every platform", () => {
    for (const p of PLATFORMS) {
      const spec = CHANNEL_REGISTRY[p];
      expect(spec.platform).toBe(p);
      expect(spec.eveImport).toMatch(/^eve\/channels\//);
      expect(spec.factory).toMatch(/Channel$/);
      expect(spec.secrets.length).toBeGreaterThan(0);
    }
  });

  it("registry key matches the spec.platform field (no copy-paste drift)", () => {
    for (const p of PLATFORMS) expect(CHANNEL_REGISTRY[p].platform).toBe(p);
  });
});

describe("channelScaffold", () => {
  it("imports the factory and references each env var", () => {
    const out = channelScaffold("slack");
    expect(out).toContain('from "eve/channels/slack"');
    expect(out).toContain("slackChannel");
    expect(out).toContain("export default slackChannel()");
    expect(out).toContain("SLACK_BOT_TOKEN");
  });

  it("emits the required config arg for twilio (allowFrom)", () => {
    const out = channelScaffold("twilio");
    expect(out).toContain('from "eve/channels/twilio"');
    expect(out).toContain("twilioChannel({");
    expect(out).toContain("allowFrom");
  });
});

describe("makeChannelArtifact", () => {
  it("builds a channel artifact with env-located secretRefs from the registry", () => {
    const a = makeChannelArtifact("slack");
    expect(a.type).toBe("channel");
    expect(a.name).toBe("slack");
    expect(a.platform).toBe("slack");
    expect(a.secretRefs).toContainEqual({ name: "SLACK_BOT_TOKEN", location: "env.SLACK_BOT_TOKEN" });
  });

  it("honors an explicit name", () => {
    expect(makeChannelArtifact("telegram", "tg").name).toBe("tg");
  });
});
