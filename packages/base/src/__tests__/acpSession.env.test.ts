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
