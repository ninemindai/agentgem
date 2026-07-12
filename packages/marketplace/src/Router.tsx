import { useEffect, useState } from "react";
import type { makeApi } from "./api";
import { defaultApiBase } from "./api";
import type { makeStars } from "./stars";
import type { makeReviews } from "./reviews";
import type { Me } from "./auth";
import { CatalogSkill } from "./pages/CatalogSkill";
import { Leaderboard } from "./pages/Leaderboard";
import { PopularSkills } from "./pages/PopularSkills";
import { Ingredient } from "./pages/Ingredient";
import { Gems } from "./pages/Gems";
import { Gem } from "./pages/Gem";
import { Publish } from "./pages/Publish";
import { Profile } from "./pages/Profile";
import { Account } from "./pages/Account";
import { MyApps } from "./pages/MyApps";
import { OrgCatalog } from "./pages/OrgCatalog";
import { TeamUsage } from "./pages/TeamUsage";
import { Sources } from "./pages/Sources";
import { Minigames } from "./pages/Minigames";
import { Play } from "./pages/Play";
import { parseGamePath } from "./entityPath";

// `loginUrl` triggers sign-in (better-auth's social sign-in is POST-only, so there is no
// synchronous URL to hand to an anchor's href anymore) — the name is kept for a minimal diff
// across the many call sites/mocks that already carry it; only its shape changed, string → void.
export interface StarsCtx { signedIn: boolean; loginUrl: () => void; api: ReturnType<typeof makeStars> }
export interface ReviewsCtx { signedIn: boolean; loginUrl: () => void; api: ReturnType<typeof makeReviews> }

type Ctx = { api: ReturnType<typeof makeApi>; stars: StarsCtx; reviews: ReviewsCtx; me: Me | null };
// match returns a truthy VALUE the render closure consumes (a RegExpMatchArray for regex routes,
// the parsed game key `string` for games, `true` for exact-string panels/home), or null/false.
type MatchVal = RegExpMatchArray | string | true;
export type RouteDef = {
  id: string;
  kind: "home" | "panel" | "collection" | "profile" | "alias";
  collection?: string;                 // the plural segment, for kind "collection"
  match(path: string): MatchVal | null | false;
  render(m: MatchVal, ctx: Ctx): React.ReactNode;
  canonical?(path: string): string;    // aliases only: the plural URL to replaceState to
};

// The single source of truth for what paths this SPA serves. The Router iterates it (first match
// wins, top to bottom — entity-before-collection order preserved); the conformance test enumerates
// it. A NEW route MUST be added here, and pass the conformance rule (see Router.conformance.test).
export const ROUTES: RouteDef[] = [
  { id: "publish", kind: "panel", match: (p) => p === "/publish", render: (_m, c) => <Publish api={c.api} me={c.me} base={defaultApiBase()} /> },
  // Signed-in guard lives inside Account itself (mirrors Publish's !me gate) rather than here.
  { id: "account", kind: "panel", match: (p) => p === "/account", render: (_m, c) => <Account api={c.api} me={c.me} base={defaultApiBase()} /> },
  // Owner play of private gems lives here — never in Explore/Minigames, which are public-only.
  { id: "my-apps", kind: "panel", match: (p) => p === "/my-apps", render: (_m, c) => <MyApps api={c.api} me={c.me} /> },
  { id: "sources", kind: "panel", match: (p) => p === "/sources", render: (_m, c) => <Sources api={c.api} /> },
  // Miniapps is the home tab. "/minigames" is the old path, kept alive for shared links and the
  // desktop deep-link; "/" is home. The ingredients board moved to its own "/ingredients".
  { id: "home", kind: "home", match: (p) => p === "/" || p === "/miniapps" || p === "/minigames", render: (_m, c) => <Minigames api={c.api} stars={c.stars} /> },
  { id: "games", kind: "collection", collection: "games", match: (p) => parseGamePath(p), render: (m, c) => <Play api={c.api} gemKey={m as string} /> },
  { id: "gems-detail", kind: "collection", collection: "gems", match: (p) => p.match(/^\/gems\/(.+)$/), render: (m, c) => <Gem api={c.api} keyName={decodeURIComponent((m as RegExpMatchArray)[1])} stars={c.stars} me={c.me} /> },
  { id: "gems", kind: "collection", collection: "gems", match: (p) => p === "/gems", render: (_m, c) => <Gems api={c.api} stars={c.stars} /> },
  { id: "ingredients", kind: "collection", collection: "ingredients", match: (p) => p.match(/^\/ingredients\/(.+)$/), render: (m, c) => <Ingredient api={c.api} id={decodeURIComponent((m as RegExpMatchArray)[1])} stars={c.stars} /> },
  // /skills/:sourceId/*path — the catalog-skill page (repo+path identity) hosting reviews + preview.
  { id: "skills", kind: "collection", collection: "skills", match: (p) => p.match(/^\/skills\/([^/]+)\/(.+)$/), render: (m, c) => <CatalogSkill api={c.api} reviews={c.reviews} sourceId={decodeURIComponent((m as RegExpMatchArray)[1])} path={(m as RegExpMatchArray)[2]} /> },
  // Legacy singular forms — old shared links. canonicalize() rewrites the URL to plural before the
  // render loop runs, so these never actually render; they exist for the conformance test.
  { id: "ingredient-alias", kind: "alias", match: (p) => /^\/ingredient\/.+$/.test(p), canonical: (p) => p.replace(/^\/ingredient\//, "/ingredients/"), render: () => null },
  { id: "skill-alias", kind: "alias", match: (p) => /^\/skill\/[^/]+\/.+$/.test(p), canonical: (p) => p.replace(/^\/skill\//, "/skills/"), render: () => null },
  { id: "profile", kind: "profile", match: (p) => p.match(/^\/@([^/]+)$/), render: (m, c) => <Profile api={c.api} login={decodeURIComponent((m as RegExpMatchArray)[1])} me={c.me} /> },
  // Member-only team dashboard — must match before the public /orgs/:scope catalog.
  { id: "org-usage", kind: "collection", collection: "orgs", match: (p) => p.match(/^\/orgs\/([^/]+)\/usage$/), render: (m, c) => <TeamUsage api={c.api} scope={decodeURIComponent((m as RegExpMatchArray)[1])} stars={c.stars} /> },
  { id: "org", kind: "collection", collection: "orgs", match: (p) => p.match(/^\/orgs\/([^/]+)$/), render: (m, c) => <OrgCatalog api={c.api} scope={decodeURIComponent((m as RegExpMatchArray)[1])} /> },
];

// Declared classifications the conformance test checks against.
export const COLLECTIONS = ["games", "gems", "ingredients", "skills", "orgs"];  // plural
export const PANELS = ["publish", "account", "sources", "my-apps"];

// A legacy singular alias (e.g. /ingredient/x) is rewritten to its plural canonical form (e.g.
// /ingredients/x) via replaceState — old shared links keep working, and the URL bar shows canonical.
// replaceState does not fire popstate, so this can't loop.
function canonicalize(path: string): string {
  for (const r of ROUTES) {
    if (r.kind === "alias" && r.canonical && r.match(path)) {
      const to = r.canonical(path);
      window.history.replaceState({}, "", to);
      return to;
    }
  }
  return path;
}

// Navigation is intercepted globally in App (same-origin <a> clicks → pushState + popstate),
// so pages just use plain <a href> and this Router reacts to popstate.
export function Router({ api, stars, reviews, me }: { api: ReturnType<typeof makeApi>; stars: StarsCtx; reviews: ReviewsCtx; me: Me | null }) {
  const [path, setPath] = useState(() => canonicalize(window.location.pathname));
  useEffect(() => {
    const onPop = () => setPath(canonicalize(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const ctx: Ctx = { api, stars, reviews, me };
  for (const r of ROUTES) {
    const m = r.match(path);
    if (m) return <>{r.render(m, ctx)}</>;   // m is a truthy MatchVal here
  }
  return (
    <>
      <PopularSkills api={api} stars={stars} reviews={reviews} />
      <h2 className="ex-section-title">Adoption leaderboard</h2>
      <Leaderboard api={api} stars={stars} />
    </>
  );
}
