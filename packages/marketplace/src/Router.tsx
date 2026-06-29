import { useEffect, useState } from "react";
import type { makeApi } from "./api";
import { Leaderboard } from "./pages/Leaderboard";
import { Ingredient } from "./pages/Ingredient";

// Navigation is intercepted globally in App (same-origin <a> clicks → pushState + popstate),
// so pages just use plain <a href> and this Router reacts to popstate.
export function Router({ api }: { api: ReturnType<typeof makeApi> }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const ing = path.match(/^\/ingredient\/(.+)$/);
  if (ing) return <Ingredient api={api} id={decodeURIComponent(ing[1])} />;
  return <Leaderboard api={api} />;
}
