import type { AggIngredient, AggCoOccurrence, AggEffectiveness, AdoptionPoint, RegistryGem, Profile, OrgCatalog, OrgUsage, OrgUsageRange, OrgSettingsView,
  CuratedSource, SourceDivision, SourceAgentRef, ImportedSkill, PopularSkill, PopularSkillGroup, OrgAppStatus, OrgSkill } from "./types";

/** The team-usage read is auth-gated: the caller distinguishes "sign in" from "not a member"
 *  from "member, but the GitHub-org capture aged out" (stale → offer a one-click refresh). */
export type OrgUsageResult =
  | { status: "ok"; usage: OrgUsage }
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "stale" }
  | { status: "disabled" };

export type OrgSettingsResult =
  | { status: "ok"; settings: OrgSettingsView }
  | { status: "denied" };

export interface GameMeta { title: string; genre: "replay" | "skill-run" | "project-fun" | "session-heatmap"; version: string }

// A gem as seen by its owner in "My apps" — spans every visibility (public/unlisted/private),
// unlike RegistryGem which is only ever populated from the public registry listing.
export interface MyGem {
  key: string;
  version: string;
  description: string;
  artifactKinds: string[];
  visibility: "public" | "unlisted" | "private";
  installable: boolean;
}

// Detailed gem view for the owner — includes metadata and artifacts.
export interface MyGemDetail {
  key: string;
  version: string;
  publishedBy: string;
  description: string;
  tags: string[];
  artifactKinds: string[];
  artifacts: unknown[];
  grade: string;
  visibility: "public" | "unlisted" | "private";
  installable: boolean;
}

type Query = Record<string, string | number | undefined>;

// The ONE querystring encoder: undefined params are dropped, everything else (incl. "" and 0)
// serializes. Callers that treat empty-string as absent pass undefined instead.
function buildQs(query: Query): string {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `?${qs}` : "";
}

async function get<T>(base: string, path: string, query: Query = {}): Promise<T> {
  const res = await fetch(base + path + buildQs(query));
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return JSON.parse(await res.text()) as T;
}

// Credentialed sibling of `get` — the parent-domain session cookie travels, for the owner-only
// catalog routes (my-gems, owner game-meta/game-html). Mirrors getAccountProviders's fetch shape.
async function getCred<T>(base: string, path: string, query: Query = {}): Promise<T> {
  const res = await fetch(base + path + buildQs(query), { credentials: "include" });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return JSON.parse(await res.text()) as T;
}

export function makeApi(base: string) {
  return {
    getPopularity: (q: { kind?: string; limit?: number } = {}) =>
      get<AggIngredient[]>(base, "/api/aggregator/popularity", q),
    getPopularSkills: (limit?: number) =>
      get<{ skills: PopularSkill[] }>(base, "/api/aggregator/popular-skills", limit ? { limit } : {}).then((r) => r.skills),
    getPopularSkillGroups: (sources = 12, perSource = 6) =>
      get<{ groups: PopularSkillGroup[] }>(base, "/api/aggregator/popular-skills", { sources, perSource }).then((r) => r.groups),
    getCoOccurrence: (q: { id: string; limit?: number }) =>
      get<AggCoOccurrence[]>(base, "/api/aggregator/co-occurrence", q),
    getEffectiveness: (q: { gemName?: string; sort?: "producers" | "score"; minConfidence?: number } = {}) =>
      get<AggEffectiveness[]>(base, "/api/aggregator/effectiveness", q),
    getAdoption: (q: { id: string; bucket?: "week" | "month" }) =>
      get<AdoptionPoint[]>(base, "/api/aggregator/adoption", q),
    getGems: () =>
      get<{ gems: RegistryGem[] }>(base, "/api/registry/gems").then((r) => r.gems),
    // Owner-only unpublish (hard delete) of a published gem. Credentialed so the parent-domain session
    // cookie travels; the server enforces ownership (login === publishedBy). Throws with the status so
    // the caller can distinguish 401 (signed out) / 403 (not owner) / other.
    unpublishGem: async (key: string, version: string): Promise<void> => {
      const res = await fetch(base + "/api/catalog/gem" + buildQs({ key, version }), { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error(`unpublish -> ${res.status}`);
    },
    // The owner's own "My apps" view — every gem they own, across all visibilities (private
    // included). Credentialed; the server derives ownership from the session, never a client-sent id.
    getMyGems: async (): Promise<{ gems: MyGem[] }> => {
      const res = await fetch(base + "/api/catalog/my-gems", { credentials: "include" });
      if (!res.ok) throw new Error(`/api/catalog/my-gems -> ${res.status}`);
      return JSON.parse(await res.text()) as { gems: MyGem[] };
    },
    // Owner-only siblings of getGameMeta/getGameHtml: resolve a private gem's game for My apps'
    // inline Play, gated to the session's own gems (a non-owner gets the same 404 as an unknown key).
    getOwnerGameMeta: (key: string) =>
      getCred<GameMeta>(base, "/api/catalog/game-meta", { key }),
    getOwnerGameHtml: (key: string, version: string) =>
      getCred<{ html: string }>(base, "/api/catalog/game-html", { key, version }).then((r) => r.html),
    // Owner-only detail view of a gem (including metadata and artifacts), gated to the session's own gems.
    getMyGem: (key: string) =>
      getCred<MyGemDetail>(base, "/api/catalog/gem-detail", { key }),
    // Owner-only gem archive base64 (for download/install), gated to the session's own gems.
    getOwnerGemArchive: (key: string, version: string) =>
      getCred<{ archiveBase64: string }>(base, "/api/catalog/gem-archive", { key, version }).then((r) => r.archiveBase64),
    // Sealed HTML of a gem's game artifact (for the playable Minigames arcade). 404s a non-game gem.
    getGameHtml: (key: string, version: string) =>
      get<{ html: string }>(base, "/api/aggregator/game-html", { key, version }).then((r) => r.html),
    // Title/genre for a game addressed by bare key; omitting version asks the server for latest.
    // buildQs drops undefined, so this sends ?key=… alone.
    getGameMeta: (key: string, version?: string) =>
      get<GameMeta>(base, "/api/aggregator/game-meta", { key, version }),
    // The beacon: the reader clicked into fullscreen play. NOT sent when the arcade grid renders a
    // thumbnail — every card fetches its html on mount, so that would count page views. Never rejects
    // (a game must open even when the beacon is blocked); resolves false instead, so an optimistic
    // count can take back a play the server never recorded.
    recordPlay: async (gemKey: string, version: string, visitorId: string): Promise<boolean> => {
      try {
        const res = await fetch(base + "/api/aggregator/game-play", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(visitorId ? { gemKey, version, visitorId } : { gemKey, version }),
        });
        return res.ok;
      } catch { return false; } // telemetry is never worth a broken game
    },
    // Plays per gem for the arcade cards. Plays, not people — see visitor.ts.
    getGamePlays: (keys: string[]) =>
      get<{ items: { gemKey: string; plays: number }[] }>(base, "/api/aggregator/game-plays", { keys: keys.join(",") })
        .then((r) => Object.fromEntries(r.items.map((i) => [i.gemKey, i.plays]))),
    // Base64 of a gem's .gem archive bytes — the marketplace turns this into a file download so a user
    // can save the gem and import it into the local app (or double-click it once desktop associates .gem).
    getGemArchiveBase64: (key: string, version: string) =>
      get<{ archiveBase64: string }>(base, "/api/aggregator/gem-archive", { key, version }).then((r) => r.archiveBase64),
    gemAdoption: (keys: string[]): Promise<Record<string, { installs: number; verifiedInstalls: number }>> =>
      keys.length === 0 ? Promise.resolve({}) :
      get<{ items: { gemKey: string; installs: number; verifiedInstalls: number }[] }>(base, "/api/aggregator/gem-adoption", { keys: keys.join(",") })
        .then((r) => Object.fromEntries(r.items.map((i) => [i.gemKey, { installs: i.installs, verifiedInstalls: i.verifiedInstalls }])))
        .catch(() => ({})),                       // adoption is best-effort; never breaks the page
    getProfile: async (login: string): Promise<Profile | null> => {
      const res = await fetch(base + "/api/aggregator/profile?login=" + encodeURIComponent(login));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`/api/aggregator/profile -> ${res.status}`);
      return JSON.parse(await res.text()) as Profile;
    },
    getOrgCatalog: async (scope: string): Promise<OrgCatalog | null> => {
      const res = await fetch(base + "/api/aggregator/org-catalog?scope=" + encodeURIComponent(scope));
      if (res.status === 400 || res.status === 404) return null;
      if (!res.ok) throw new Error(`/api/aggregator/org-catalog -> ${res.status}`);
      return JSON.parse(await res.text()) as OrgCatalog;
    },
    getOrgUsage: async (scope: string, range: OrgUsageRange, filters: { member?: string; agent?: string; model?: string } = {}): Promise<OrgUsageResult> => {
      // credentialed: the org dashboard is member-only, gated by the web session cookie.
      // Filters compose: member (drill-down), agent, model — all inside the org-scope boundary.
      const url = base + "/api/usage/org" + buildQs({
        scope, range,
        member: filters.member || undefined, agent: filters.agent || undefined, model: filters.model || undefined,
      });
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 401) return { status: "unauthenticated" };
      if (res.status === 403) {
        const body = await res.json().catch(() => ({})) as { reason?: string };
        if (body.reason === "stale") return { status: "stale" };
        if (body.reason === "disabled") return { status: "disabled" };
        return { status: "forbidden" };
      }
      if (!res.ok) throw new Error(`/api/usage/org -> ${res.status}`);
      return { status: "ok", usage: JSON.parse(await res.text()) as OrgUsage };
    },
    getOrgSettings: async (scope: string): Promise<OrgSettingsResult> => {
      const res = await fetch(base + "/api/usage/settings?scope=" + encodeURIComponent(scope), { credentials: "include" });
      if (res.status === 401 || res.status === 403) return { status: "denied" };
      if (!res.ok) throw new Error(`/api/usage/settings -> ${res.status}`);
      return { status: "ok", settings: JSON.parse(await res.text()) as OrgSettingsView };
    },
    // Partial update: send only the fields being changed — the server keeps the rest, so
    // concurrent edits from two tabs can't clobber each other's untouched settings.
    putOrgSettings: async (scope: string, values: { retentionDays?: number | null; dashboardEnabled?: boolean }): Promise<OrgSettingsResult> => {
      const res = await fetch(base + "/api/usage/settings?scope=" + encodeURIComponent(scope), {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (res.status === 401 || res.status === 403) return { status: "denied" };
      if (!res.ok) throw new Error(`/api/usage/settings -> ${res.status}`);
      return { status: "ok", settings: JSON.parse(await res.text()) as OrgSettingsView };
    },
    getOrgApp: async (scope: string): Promise<OrgAppStatus | null> => {
      try {
        const res = await fetch(base + "/api/orgs/app?scope=" + encodeURIComponent(scope), { credentials: "include" });
        return res.ok ? ((await res.json()) as OrgAppStatus) : null;
      } catch { return null; }
    },
    getOrgSkills: async (scope: string): Promise<OrgSkill[] | null> => {
      try {
        const res = await fetch(base + "/api/orgs/skills?scope=" + encodeURIComponent(scope), { credentials: "include" });
        if (!res.ok) return null;
        return ((await res.json()) as { skills: OrgSkill[] }).skills;
      } catch { return null; }
    },
    // Task 6's route: the providers linked to the caller's own account. Credentialed — 401s when
    // signed out, which the caller (Account.tsx) never sends this from since the page itself is
    // gated on `me`. Raw ids from better-auth's `account` table are provider-agnostic (e.g.
    // "credential" if email/password sign-up is ever enabled) — the caller filters to the known set.
    getAccountProviders: async (): Promise<{ connected: string[] }> => {
      const res = await fetch(base + "/api/account/providers", { credentials: "include" });
      if (!res.ok) throw new Error(`/api/account/providers -> ${res.status}`);
      return JSON.parse(await res.text()) as { connected: string[] };
    },
    // Flow B's consumer side (account/install.ts's absorbHandler): merges the provider the caller
    // just OAuth'd via `auth.connect` (server-verified, stashed as a pending link) into the caller's
    // current account. `other` is never supplied by the client — the server reads it off the
    // session-scoped pending-link row. A 409 covers two distinct server reasons ("no provider
    // awaiting connection" and "both accounts have activity, merge not supported") — the caller
    // surfaces whichever message the server sent rather than guessing which one applies.
    absorbAccount: async (): Promise<{ keep: string; connected: string[] }> => {
      const res = await fetch(base + "/api/account/absorb", { method: "POST", credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `/api/account/absorb -> ${res.status}`);
      }
      return JSON.parse(await res.text()) as { keep: string; connected: string[] };
    },
    getSources: () =>
      get<{ sources: CuratedSource[] }>(base, "/api/sources").then((r) => r.sources),
    getSourceDivisions: (source: string) =>
      get<{ divisions: SourceDivision[] }>(base, "/api/sources/divisions", { source }).then((r) => r.divisions),
    getSourceAgents: (source: string, division: string) =>
      get<{ agents: SourceAgentRef[] }>(base, "/api/sources/agents", { source, division }).then((r) => r.agents),
    importSourceSkill: (source: string, path: string) =>
      get<ImportedSkill>(base, "/api/sources/import", { source, path }),
  };
}

export function defaultApiBase(): string {
  // Fallback must be the API's custom domain: the GitHub OAuth app + session cookies are
  // registered against api.agentgem.ai, so auth via the raw onrender.com host fails.
  return (import.meta.env?.VITE_API_BASE as string | undefined) ?? "https://api.agentgem.ai";
}
