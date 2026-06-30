/** Web sign-in client. All calls are credentialed so the parent-domain session cookie travels. */
export interface Me { login: string; avatarUrl: string | null }

export function makeAuth(base: string) {
  return {
    async getMe(): Promise<Me | null> {
      try {
        const r = await fetch(base + "/api/auth/me", { credentials: "include" });
        if (!r.ok) return null;
        const j = (await r.json()) as { login?: string; avatarUrl?: string | null; authenticated?: boolean };
        return j.login ? { login: j.login, avatarUrl: j.avatarUrl ?? null } : null;
      } catch { return null; }
    },
    async logout(): Promise<void> {
      try { await fetch(base + "/api/auth/logout", { method: "POST", credentials: "include" }); } catch { /* ignore */ }
    },
    loginUrl(returnTo: string): string {
      return base + "/api/auth/github/login?return=" + encodeURIComponent(returnTo);
    },
  };
}
