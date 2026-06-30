// tests/gem/redact.test.ts
import { describe, it, expect } from "vitest";
import { redactMcpConfig } from "@agentgem/base";

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

  // Egress backstop: credentials whose value carries special characters (so the high-entropy
  // charset check fails) and whose key is benign (so the key-name check fails) used to leak.
  it("redacts a JWT stored under a benign key", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const { config: out } = redactMcpConfig({ token_hint: jwt, label: "ok" });
    expect(out.token_hint).toBe("<redacted>");
    expect(out.label).toBe("ok");
    expect(JSON.stringify(out)).not.toContain("dozjgNry");
  });

  it("redacts the password inside a connection string, preserving the rest of the shape", () => {
    const { config: out } = redactMcpConfig({ database: "postgres://app:Hunter2@db.host:5432/prod" });
    expect(out.database).toBe("postgres://app:<redacted>@db.host:5432/prod");
    expect(JSON.stringify(out)).not.toContain("Hunter2");
  });

  it("does not touch a plain URL with no embedded credentials", () => {
    const { config: out } = redactMcpConfig({ url: "https://mcp.example.com/sse" });
    expect(out.url).toBe("https://mcp.example.com/sse");
  });

  it("redacts provider-prefixed tokens embedded in free text", () => {
    // Short enough (<32 chars) that the high-entropy heuristic misses it; only the prefix net catches it.
    const { config: out } = redactMcpConfig({ note: "run with ghp_abcd1234efgh5678 then retry" });
    expect(out.note).toBe("run with <redacted> then retry");
  });

  it("redacts a PEM private key block", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBg+kqh/kiG9w0=\n-----END PRIVATE KEY-----";
    const { config: out } = redactMcpConfig({ key_pem: pem });
    expect(out.key_pem).toBe("<redacted>");
    expect(JSON.stringify(out)).not.toContain("MIIBVAIBADAN");
  });

  it("redacts secret-named scalars and values under extended credential containers", () => {
    const { config: out } = redactMcpConfig({
      password: 123456, // numeric secret under a secret-named key
      environment: { DB_PASS: "s3cr3t", COUNT: 5 }, // non-standard env container -> default-deny
      port: 8080, // benign scalar, untouched
    });
    expect(out.password).toBe("<redacted>");
    expect((out.environment as Record<string, unknown>).DB_PASS).toBe("<redacted>");
    expect((out.environment as Record<string, unknown>).COUNT).toBe("<redacted>");
    expect(out.port).toBe(8080);
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
