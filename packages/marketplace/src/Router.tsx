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
import { OrgCatalog } from "./pages/OrgCatalog";
import { TeamUsage } from "./pages/TeamUsage";
import { Sources } from "./pages/Sources";
import { Minigames } from "./pages/Minigames";

export interface StarsCtx { signedIn: boolean; loginUrl: () => string; api: ReturnType<typeof makeStars> }
export interface ReviewsCtx { signedIn: boolean; loginUrl: () => string; api: ReturnType<typeof makeReviews> }

// Navigation is intercepted globally in App (same-origin <a> clicks → pushState + popstate),
// so pages just use plain <a href> and this Router reacts to popstate.
export function Router({ api, stars, reviews, me }: { api: ReturnType<typeof makeApi>; stars: StarsCtx; reviews: ReviewsCtx; me: Me | null }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (path === "/publish") return <Publish api={api} me={me} base={defaultApiBase()} />;
  if (path === "/sources") return <Sources api={api} />;
  if (path === "/minigames") return <Minigames api={api} />;

  const gemDetail = path.match(/^\/gems\/(.+)$/);
  if (gemDetail) return <Gem api={api} keyName={decodeURIComponent(gemDetail[1])} stars={stars} me={me} />;
  if (path === "/gems") return <Gems api={api} stars={stars} />;

  const ing = path.match(/^\/ingredient\/(.+)$/);
  if (ing) return <Ingredient api={api} id={decodeURIComponent(ing[1])} stars={stars} />;

  // /skill/:sourceId/*path — the catalog-skill page (repo+path identity) hosting reviews + preview.
  const skill = path.match(/^\/skill\/([^/]+)\/(.+)$/);
  if (skill) return <CatalogSkill api={api} reviews={reviews} sourceId={decodeURIComponent(skill[1])} path={skill[2]} />;

  const prof = path.match(/^\/@([^/]+)$/);
  if (prof) return <Profile api={api} login={decodeURIComponent(prof[1])} me={me} />;

  // Member-only team dashboard — must match before the public /orgs/:scope catalog.
  const orgUsage = path.match(/^\/orgs\/([^/]+)\/usage$/);
  if (orgUsage) return <TeamUsage api={api} scope={decodeURIComponent(orgUsage[1])} stars={stars} />;

  const org = path.match(/^\/orgs\/([^/]+)$/);
  if (org) return <OrgCatalog api={api} scope={decodeURIComponent(org[1])} />;

  return (
    <>
      <PopularSkills api={api} stars={stars} reviews={reviews} />
      <h2 className="ex-section-title">Adoption leaderboard</h2>
      <Leaderboard api={api} stars={stars} />
    </>
  );
}
