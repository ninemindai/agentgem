// src/gem/__tests__/acpSession.test.ts
import { describe, it, expect } from "vitest";
import { localAgentEnv } from "@agentgem/base";

describe("localAgentEnv", () => {
  it("strips stored provider credentials (Anthropic + OpenAI) so the agent uses its own local login", () => {
    const out = localAgentEnv({
      ANTHROPIC_API_KEY: "sk-publish-key",
      ANTHROPIC_AUTH_TOKEN: "tok",
      OPENAI_API_KEY: "sk-openai",   // codex would otherwise inherit this
      PATH: "/usr/bin",
      HOME: "/home/me",
    } as NodeJS.ProcessEnv);
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    // everything else is preserved
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/me");
  });

  it("is a no-op when no Anthropic overrides are present", () => {
    expect(localAgentEnv({ PATH: "/usr/bin" } as NodeJS.ProcessEnv)).toEqual({ PATH: "/usr/bin" });
  });
});
