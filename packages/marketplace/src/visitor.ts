// packages/marketplace/src/visitor.ts
// An opaque per-browser id, minted on first use and kept in localStorage. It exists so a play count
// can be checked against distinct browsers — it is NOT an identity and must never be reported as a
// count of users: playing a mini-game needs no login, and this id dies with a cleared cache.
const KEY = "agentgem.visitorId";

export function visitorId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return ""; // storage denied (Safari private mode, embedded webview) — the play still counts, undeduped
  }
}
