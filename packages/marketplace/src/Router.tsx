import { useEffect, useState } from "react";
import type { makeApi } from "./api";
import { defaultApiBase } from "./api";
import type { makeStars } from "./stars";
import type { Me } from "./auth";
import { Leaderboard } from "./pages/Leaderboard";
import { Ingredient } from "./pages/Ingredient";
import { Gems } from "./pages/Gems";
import { Gem } from "./pages/Gem";
import { Publish } from "./pages/Publish";

export interface StarsCtx { signedIn: boolean; loginUrl: () => string; api: ReturnType<typeof makeStars> }

// Navigation is intercepted globally in App (same-origin <a> clicks → pushState + popstate),
// so pages just use plain <a href> and this Router reacts to popstate.
export function Router({ api, stars, me }: { api: ReturnType<typeof makeApi>; stars: StarsCtx; me: Me | null }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (path === "/publish") return <Publish api={api} me={me} base={defaultApiBase()} />;

  const gemDetail = path.match(/^\/gems\/(.+)$/);
  if (gemDetail) return <Gem api={api} keyName={decodeURIComponent(gemDetail[1])} stars={stars} />;
  if (path === "/gems") return <Gems api={api} stars={stars} />;

  const ing = path.match(/^\/ingredient\/(.+)$/);
  if (ing) return <Ingredient api={api} id={decodeURIComponent(ing[1])} stars={stars} />;
  return <Leaderboard api={api} stars={stars} />;
}
