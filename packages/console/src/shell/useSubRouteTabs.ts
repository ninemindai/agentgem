import { useEffect, useState } from "react";
import { useRovingTabIndex } from "./useRovingTabIndex.js";

/** A deep-linkable tab bar backed by hash sub-routes (Gems, Setup). The active tab is
 *  derived from the hash PATH — ignoring any `?query`, so `#/gems/market?install=x` still
 *  resolves to the market tab — re-derived on every hashchange. Returns the active index,
 *  a `go(i)` navigator (sets the hash to that tab's route), and roving-tabindex props for
 *  the tablist. Consumers own their own role/aria + any query-param state. */
export function useSubRouteTabs(routes: readonly string[]) {
  const indexOf = () => {
    const base = window.location.hash.split("?")[0];
    const i = routes.findIndex((r) => r === base);
    return i === -1 ? 0 : i;
  };
  const [idx, setIdx] = useState(indexOf);
  useEffect(() => {
    const onHash = () => setIdx(indexOf());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const go = (i: number) => { window.location.hash = routes[i]; };
  const roving = useRovingTabIndex({ count: routes.length, selectedIndex: idx, onSelect: go });
  return { idx, go, roving };
}
