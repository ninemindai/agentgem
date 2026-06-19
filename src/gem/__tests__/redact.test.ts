// tests/gem/redact.test.ts
import { describe, it, expect } from "vitest";
import { redactMcpConfig } from "../redact.js";

describe("redactMcpConfig", () => {
  it("redacts every value under env and headers but keeps the keys", () => {
    const { config: out } = redactMcpConfig({
      command: "npx",
      args: ["-y", "server", "--port", "8080"],
      env: { GITHUB_TOKEN: "ghp_realsecret", REGION: "us" },
      headers: { Authorization: "Bearer abc123" },
    });
    expect(out.command).toBe("npx");
    expect(out.args).toEqual(["-y", "server", "--port", "8080"]);
    expect(out.env).toEqual({ GITHUB_TOKEN: "<redacted>", REGION: "<redacted>" });
    expect(out.headers).toEqual({ Authorization: "<redacted>" });
  });

  it("redacts secret-looking string values elsewhere, preserves benign ones", () => {
    const { config: out } = redactMcpConfig({
      url: "https://mcp.example.com/sse",
      apiKey: "sk-1234567890",
      label: "my server",
    });
    expect(out.url).toBe("https://mcp.example.com/sse");
    expect(out.apiKey).toBe("<redacted>");
    expect(out.label).toBe("my server");
  });

  it("redacts long high-entropy tokens, not long sentences/paths/urls", () => {
    const { config: out } = redactMcpConfig({
      token: "AbCdEf0123456789AbCdEf0123456789xy",
      note: "this is a perfectly ordinary long human sentence value",
      path: "/usr/local/bin/some/long/path/to/a/binary/executable",
    });
    expect(out.token).toBe("<redacted>");
    expect(out.note).toBe("this is a perfectly ordinary long human sentence value");
    expect(out.path).toBe("/usr/local/bin/some/long/path/to/a/binary/executable");
  });

  it("redacts a short value whose key name is obviously secret", () => {
    const { config: out } = redactMcpConfig({ myPassword: "hunter2", authToken: "abc", apiSecret: "x" });
    expect(out.myPassword).toBe("<redacted>");
    expect(out.authToken).toBe("<redacted>");
    expect(out.apiSecret).toBe("<redacted>");
  });

  it("does not redact prose that merely mentions secret words (only whitespace-free tokens)", () => {
    const { config } = redactMcpConfig({ label: "test bearer authentication flow" });
    expect(config.label).toBe("test bearer authentication flow");
  });

  it("still preserves benign keys with benign values", () => {
    const { config: out } = redactMcpConfig({ label: "my server", port: 8080, command: "npx" });
    expect(out.label).toBe("my server");
    expect(out.port).toBe(8080);
    expect(out.command).toBe("npx");
  });

  it("records the name + location of every redacted value, never the value", () => {
    const { config, secrets } = redactMcpConfig({
      command: "npx",
      env: { GITHUB_TOKEN: "ghp_realsecret", REGION: "us" },
      headers: { Authorization: "Bearer abc123" },
      apiKey: "sk-1234567890",
    });
    // values gone
    expect((config.env as Record<string, string>).GITHUB_TOKEN).toBe("<redacted>");
    // names + locations recorded
    const byLoc = Object.fromEntries(secrets.map((s) => [s.location, s.name]));
    expect(byLoc["env.GITHUB_TOKEN"]).toBe("GITHUB_TOKEN");
    expect(byLoc["env.REGION"]).toBe("REGION");           // under env => redacted by map rule
    expect(byLoc["headers.Authorization"]).toBe("Authorization");
    expect(byLoc["apiKey"]).toBe("apiKey");
    // no secret value leaks into the manifest
    expect(JSON.stringify(secrets)).not.toContain("ghp_realsecret");
    expect(JSON.stringify(secrets)).not.toContain("abc123");
  });
});
