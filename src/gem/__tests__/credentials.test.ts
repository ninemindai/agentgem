import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCredential, credentialsEnvPath, CREDENTIAL_KEYS } from "@agentgem/capture";

let home: string;
let prev: Record<string, string | undefined>;
const KEYS = ["ANTHROPIC_API_KEY", "VERCEL_TOKEN", "CLOUDFLARE_API_TOKEN"] as const;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "cred-")); prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); });
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of KEYS) { if (prev[k] !== undefined) process.env[k] = prev[k]; else delete process.env[k]; }
});

describe("server credential store", () => {
  it("allowlists the deploy/publish credential keys", () => {
    expect([...CREDENTIAL_KEYS]).toEqual(["ANTHROPIC_API_KEY", "VERCEL_TOKEN", "CLOUDFLARE_API_TOKEN"]);
  });

  it("sets the running env and persists to <home>/.agentgem/.env", () => {
    setCredential("ANTHROPIC_API_KEY", "sk-ant-xyz", home);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-xyz");
    const file = credentialsEnvPath(home);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("ANTHROPIC_API_KEY=sk-ant-xyz");
  });

  it("writes the env file 0600 (user read/write only)", () => {
    setCredential("VERCEL_TOKEN", "tok_abc", home);
    expect(statSync(credentialsEnvPath(home)).mode & 0o777).toBe(0o600);
  });

  it("upserts: replaces the same key, keeps other lines", () => {
    setCredential("VERCEL_TOKEN", "first", home);
    setCredential("CLOUDFLARE_API_TOKEN", "cf1", home);
    setCredential("VERCEL_TOKEN", "second", home);
    const txt = readFileSync(credentialsEnvPath(home), "utf8");
    expect(txt).toContain("VERCEL_TOKEN=second");
    expect(txt).not.toContain("VERCEL_TOKEN=first");
    expect(txt).toContain("CLOUDFLARE_API_TOKEN=cf1");
  });

  it("rejects empty or multi-line values", () => {
    expect(() => setCredential("VERCEL_TOKEN", "   ", home)).toThrow();
    expect(() => setCredential("VERCEL_TOKEN", "a\nb", home)).toThrow();
    // Reported as a client-input error (400) so the caller learns the rule, not a 500.
    expect(() => setCredential("VERCEL_TOKEN", "a\nb", home)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
