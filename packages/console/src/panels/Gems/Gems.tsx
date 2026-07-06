import { useEffect, useState } from "react";
import { useRovingTabIndex } from "../../shell/useRovingTabIndex.js";
import { Workspaces } from "../Workspaces/index.js";
import { Received } from "../Received/index.js";
import { GetGems } from "../GetGems/index.js";

// Yours / Received / Get-more folded into one screen (design Variant B). Each tab is a
// deep-linkable sub-route; the body is the existing panel component, reused verbatim.
// Received is a redeem/apply FORM, not an inbox — there is no server list of received gems.
const TABS = [
  { id: "yours", label: "Yours", route: "#/gems", Body: Workspaces },
  { id: "received", label: "Received", route: "#/gems/received", Body: Received },
  { id: "market", label: "Get more", route: "#/gems/market", Body: GetGems },
] as const;

/** Select the tab from the PATH portion of the hash, so `#/gems/market?install=x`
 *  still resolves to the market tab. Unknown → Yours. */
function tabIndexFromHash(): number {
  const base = window.location.hash.split("?")[0];
  const i = TABS.findIndex((t) => t.route === base);
  return i === -1 ? 0 : i;
}

export function Gems({ apiBase }: { apiBase: string }) {
  const [idx, setIdx] = useState(tabIndexFromHash);

  useEffect(() => {
    const onHash = () => setIdx(tabIndexFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (i: number) => { window.location.hash = TABS[i].route; };
  const roving = useRovingTabIndex({ count: TABS.length, selectedIndex: idx, onSelect: go });
  const Body = TABS[idx].Body;

  return (
    <div className="gems">
      <div className="gems-tabs" role="tablist" aria-label="Gems" {...roving.containerProps}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={i === idx}
            className={"gems-tab" + (i === idx ? " is-active" : "")}
            {...roving.getTabProps(i)}
            onClick={() => go(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* Unmount-on-switch: only the active tab's body is mounted, so it fetches on open
          and GetGems' hash-reactive install effect fires cleanly. */}
      <div role="tabpanel" className="gems-panel">
        <Body apiBase={apiBase} />
      </div>
    </div>
  );
}
