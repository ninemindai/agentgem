// src/play/__tests__/mcpEnv.test.ts
import { describe, it, expect } from "vitest";
import { buildSpawnEnv } from "@agentgem/play";

const PROC = { PATH: "/usr/bin:/bin", HOME: "/home/u", OPENAI_API_KEY: "sk-live", UNRELATED: "leak-me" } as NodeJS.ProcessEnv;

describe("buildSpawnEnv", () => {
  it("passes PATH and HOME through, and NOTHING else from process.env by default", () => {
    const { env } = buildSpawnEnv({ config: {} }, PROC);
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.UNRELATED).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("carries the gem's OWN raw config.env verbatim (literal values the user configured)", () => {
    const { env } = buildSpawnEnv({ config: { env: { GITHUB_TOKEN: "ghp_literal", NODE_ENV: "production" } } }, PROC);
    expect(env.GITHUB_TOKEN).toBe("ghp_literal");
    expect(env.NODE_ENV).toBe("production");
  });

  it("resolves a declared secretRefs name from process.env when the gem config did not carry it", () => {
    const gem = { config: { command: "openai-mcp" }, secretRefs: [{ name: "OPENAI_API_KEY" }] };
    const { env, missingSecrets } = buildSpawnEnv(gem, PROC);
    expect(env.OPENAI_API_KEY).toBe("sk-live");   // pulled by NAME — it's an allowlisted secret this gem declared
    expect(missingSecrets).toEqual([]);
  });

  it("does NOT let a secretRef name pull an unrelated process.env var the gem never declared", () => {
    // UNRELATED is in process.env but not a secretRef and not in config.env → excluded.
    const { env } = buildSpawnEnv({ config: {}, secretRefs: [{ name: "OPENAI_API_KEY" }] }, PROC);
    expect(env.UNRELATED).toBeUndefined();
  });

  it("reports a declared secret that is absent from BOTH config.env and process.env (D14 fast-fail input)", () => {
    const gem = { config: { command: "gh-mcp" }, secretRefs: [{ name: "GITHUB_TOKEN" }] };
    const { env, missingSecrets } = buildSpawnEnv(gem, PROC);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(missingSecrets).toEqual(["GITHUB_TOKEN"]);
  });

  it("treats a config.env value of the redaction sentinel as NOT satisfying the secret", () => {
    // Defensive: if a redacted gem ever reaches here, "<redacted>" is not a real value.
    const gem = { config: { env: { GITHUB_TOKEN: "<redacted>" } }, secretRefs: [{ name: "GITHUB_TOKEN" }] };
    const { missingSecrets } = buildSpawnEnv(gem, { ...PROC, GITHUB_TOKEN: undefined });
    expect(missingSecrets).toEqual(["GITHUB_TOKEN"]);
  });
});
