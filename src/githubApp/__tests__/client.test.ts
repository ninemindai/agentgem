// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { appConfigFromEnv, appJwt, InstallationTokens, listAppInstallations, listOrgMembers, listInstallationRepos } from "../client.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const cfg = { appId: "12345", privateKey: pem };

function fakeFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const hit = Object.entries(routes).find(([k]) => u.includes(k));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    const r = hit[1](init);
    return { ok: (r.status ?? 200) < 300, status: r.status ?? 200, json: async () => r.body } as unknown as Response;
  }) as typeof fetch;
  return { f, calls };
}

describe("appConfigFromEnv", () => {
  it("null unless all three are set", () => {
    expect(appConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(appConfigFromEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem } as NodeJS.ProcessEnv)).toBeNull();
    expect(appConfigFromEnv({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_APP_WEBHOOK_SECRET: "s" } as NodeJS.ProcessEnv))
      .toEqual({ appId: "1", privateKey: pem, webhookSecret: "s" });
  });
});

describe("appJwt", () => {
  it("mints a valid RS256 JWT with iss/iat/exp", () => {
    const jwt = appJwt(cfg, 1_000_000);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "12345" });
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("InstallationTokens", () => {
  it("mints via POST with a JWT bearer, caches until near expiry, refreshes after", async () => {
    let n = 0;
    const { f, calls } = fakeFetch({
      "/app/installations/7/access_tokens": () => ({ body: { token: `tok-${++n}`, expires_at: new Date(2_000_000_000).toISOString() } }),
    });
    const tokens = new InstallationTokens(cfg, f);
    expect(await tokens.tokenFor(7, 1_000_000_000)).toBe("tok-1");
    expect(await tokens.tokenFor(7, 1_100_000_000)).toBe("tok-1"); // cached (expiry - 5min still ahead)
    expect(await tokens.tokenFor(7, 1_999_800_000)).toBe("tok-2"); // within 5min of expiry → refresh
    expect(calls[0].init?.method).toBe("POST");
    expect(String((calls[0].init?.headers as Record<string, string>).Authorization)).toMatch(/^Bearer eyJ/);
  });
});

describe("list APIs", () => {
  it("listAppInstallations keeps only Organization installs, normalizes fields", async () => {
    const { f } = fakeFetch({
      "/app/installations?": () => ({ body: [
        { id: 7, account: { login: "Acme", type: "Organization" }, repository_selection: "selected", suspended_at: null },
        { id: 8, account: { login: "someuser", type: "User" }, repository_selection: "all", suspended_at: null },
        { id: 9, account: { login: "Globex", type: "Organization" }, repository_selection: "all", suspended_at: "2026-01-01T00:00:00Z" },
      ] }),
    });
    expect(await listAppInstallations(cfg, f)).toEqual({ installations: [
      { installationId: 7, orgScope: "acme", repoSelection: "selected", suspended: false },
      { installationId: 9, orgScope: "globex", repoSelection: "all", suspended: true },
    ], truncated: false });
  });

  it("listOrgMembers merges the admin and member role pages, lowercased", async () => {
    const { f } = fakeFetch({
      "role=admin": () => ({ body: [{ login: "Alice" }] }),
      "role=member": () => ({ body: [{ login: "bob" }] }),
    });
    const { members, truncated } = await listOrgMembers("t", "acme", f);
    expect(truncated).toBe(false);
    expect(members.sort((a, b) => a.login.localeCompare(b.login)))
      .toEqual([{ login: "alice", role: "admin" }, { login: "bob", role: "member" }]);
  });

  it("listInstallationRepos returns full_name + default_branch", async () => {
    const { f } = fakeFetch({
      "/installation/repositories": () => ({ body: { repositories: [{ full_name: "acme/skills", default_branch: "trunk" }] } }),
    });
    expect(await listInstallationRepos("t", f)).toEqual({ repos: [{ repo: "acme/skills", defaultBranch: "trunk" }], truncated: false });
  });

  it("paginates past page 1 and warns when the page cap truncates", async () => {
    const { vi } = await import("vitest");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const customFetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("role=admin")) {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      } else if (u.includes("role=member")) {
        // Always return 100 items (simulates pages 1-20 all having data, triggering cap truncation warning)
        const items = Array.from({ length: 100 }, (_, i) => ({ login: `u${i}` }));
        return { ok: true, status: 200, json: async () => items } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => [] } as unknown as Response;
    }) as typeof fetch;

    const { members, truncated } = await listOrgMembers("t", "acme", customFetch);
    expect(members).toHaveLength(100);
    expect(members[0]).toEqual({ login: "u0", role: "member" });
    expect(truncated).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("truncated"));
    errorSpy.mockRestore();
  });

  it("an exact multiple of 100 followed by an empty page is NOT truncation (no false warn)", async () => {
    const { vi } = await import("vitest");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const pagedFetch = (async (url: string | URL) => {
      const u = String(url);
      const page = Number(new URL(u).searchParams.get("page") ?? "1");
      if (u.includes("role=admin")) return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      if (u.includes("role=member")) {
        // Page 1: exactly 100 members; page 2: empty — the org has exactly 100 members.
        const body = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ login: `u${i}` })) : [];
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => [] } as unknown as Response;
    }) as typeof fetch;
    const { members, truncated } = await listOrgMembers("t", "acme", pagedFetch);
    expect(members).toHaveLength(100);
    expect(truncated).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
