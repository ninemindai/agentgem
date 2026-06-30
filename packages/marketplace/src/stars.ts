/** Star client. Credentialed so the parent-domain session cookie travels (counts also work signed-out). */
export class NotSignedIn extends Error { constructor() { super("not signed in"); this.name = "NotSignedIn"; } }

export interface StarState { counts: Record<string, number>; mine: string[] }

export function makeStars(base: string) {
  return {
    async get(kind: string, ids: string[]): Promise<StarState> {
      const r = await fetch(base + "/api/stars?kind=" + encodeURIComponent(kind) + "&ids=" + encodeURIComponent(ids.join(",")), { credentials: "include" });
      if (!r.ok) return { counts: {}, mine: [] };
      const j = (await r.json()) as Partial<StarState>;
      return { counts: j.counts ?? {}, mine: j.mine ?? [] };
    },
    async toggle(kind: string, id: string): Promise<{ starred: boolean; count: number }> {
      const r = await fetch(base + "/api/stars/toggle", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id }),
      });
      if (r.status === 401) throw new NotSignedIn();
      if (!r.ok) throw new Error("stars toggle -> " + r.status);
      return (await r.json()) as { starred: boolean; count: number };
    },
  };
}
