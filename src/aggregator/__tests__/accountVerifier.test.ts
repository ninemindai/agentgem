// src/aggregator/__tests__/accountVerifier.test.ts
import { describe, it, expect } from "vitest";
import { GitHubVerifier } from "@agentgem/aggregator";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe("GitHubVerifier", () => {
  it("maps GitHub /user to a VerifiedAccount", async () => {
    const v = new GitHubVerifier(fakeFetch(200, { id: 42, login: "octocat" }));
    expect(await v.verify("tok")).toEqual({ provider: "github", accountId: "42", login: "octocat" });
  });
  it("throws on a non-2xx response", async () => {
    const v = new GitHubVerifier(fakeFetch(401, { message: "Bad credentials" }));
    await expect(v.verify("tok")).rejects.toThrow();
  });
  it("throws on an unexpected body shape", async () => {
    const v = new GitHubVerifier(fakeFetch(200, { login: "octocat" })); // no id
    await expect(v.verify("tok")).rejects.toThrow();
  });
});
