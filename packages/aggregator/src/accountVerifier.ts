// src/aggregator/accountVerifier.ts
// The provider seam: the only network dependency in the binding path. Tests inject a fake.
export interface VerifiedAccount { provider: string; accountId: string; login: string; }
export interface AccountVerifier { verify(token: string): Promise<VerifiedAccount>; }

export class GitHubVerifier implements AccountVerifier {
  constructor(private fetchImpl: typeof fetch = fetch) {}
  async verify(token: string): Promise<VerifiedAccount> {
    const res = await this.fetchImpl("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "agentgem", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`github /user: ${res.status}`);
    const u = (await res.json()) as { id?: unknown; login?: unknown };
    if (typeof u.id !== "number" || typeof u.login !== "string") throw new Error("github /user: unexpected shape");
    // accountId is the numeric id as text (stable across login renames); login is for display only.
    return { provider: "github", accountId: String(u.id), login: u.login };
  }
}
