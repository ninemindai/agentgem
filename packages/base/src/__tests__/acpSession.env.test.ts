import { describe, it, expect } from "vitest";
import { spawnEnv } from "../acpSession.js";

describe("spawnEnv", () => {
  it("overlays descriptor.env onto the sanitized base env", () => {
    const base = { PATH: "/bin", OPENAI_API_KEY: "should-be-gone-by-localAgentEnv" };
    const out = spawnEnv({ id: "x", name: "X", command: ["x"], env: { ELECTRON_RUN_AS_NODE: "1" } }, base);
    expect(out.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(out.PATH).toBe("/bin");
  });
  it("is a no-op overlay when descriptor has no env", () => {
    const out = spawnEnv({ id: "x", name: "X", command: ["x"] }, { PATH: "/bin" });
    expect(out).toEqual({ PATH: "/bin" });
  });
  it("passes an ANTHROPIC_MODEL overlay through to the spawned env", () => {
    const out = spawnEnv({ id: "x", name: "X", command: ["x"], env: { ANTHROPIC_MODEL: "claude-haiku-4-5" } }, { PATH: "/bin" });
    expect(out.ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
    expect(out.PATH).toBe("/bin");
  });
  it("strips credentials even when a model overlay is present", () => {
    const out = spawnEnv(
      { id: "x", name: "X", command: ["x"], env: { ANTHROPIC_MODEL: "claude-haiku-4-5", ANTHROPIC_API_KEY: "leaked" } },
      { PATH: "/bin" },
    );
    expect(out.ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  });
  it("never lets a descriptor.env overlay reintroduce a stripped credential", () => {
    const out = spawnEnv(
      { id: "x", name: "X", command: ["x"], env: { OPENAI_API_KEY: "leaked", ANTHROPIC_API_KEY: "leaked", ELECTRON_RUN_AS_NODE: "1" } },
      { PATH: "/bin" },
    );
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(out.PATH).toBe("/bin");
  });
});
