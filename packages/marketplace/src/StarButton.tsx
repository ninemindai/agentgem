import { useEffect, useState } from "react";
import type { makeStars } from "./stars";
import { NotSignedIn } from "./stars";

export function StarButton({ kind, id, count, starred, signedIn, loginUrl, api }: {
  kind: string; id: string; count: number; starred: boolean; signedIn: boolean;
  loginUrl: () => string; api: ReturnType<typeof makeStars>;
}) {
  const [on, setOn] = useState(starred);
  const [n, setN] = useState(count);
  const [busy, setBusy] = useState(false);
  // Props arrive after the page's star-fetch resolves (server counts + mine);
  // useState only reads them at mount, so sync when they actually change.
  useEffect(() => { setOn(starred); setN(count); }, [starred, count]);

  const click = async (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (!signedIn) { window.location.assign(loginUrl()); return; }
    if (busy) return;
    const prevOn = on, prevN = n;
    setOn(!on); setN(n + (on ? -1 : 1)); setBusy(true);   // optimistic
    try {
      const r = await api.toggle(kind, id);
      setOn(r.starred); setN(r.count);                    // reconcile
    } catch (err) {
      setOn(prevOn); setN(prevN);                          // revert
      if (err instanceof NotSignedIn) window.location.assign(loginUrl());
    } finally { setBusy(false); }
  };

  return (
    <button type="button" className={"ex-star" + (on ? " is-on" : "")} onClick={click}
      aria-pressed={on} aria-label={on ? "Unstar" : "Star"} disabled={busy}>
      <span className="ex-star-ico" aria-hidden="true">{on ? "★" : "☆"}</span>
      <span className="ex-star-n">{n}</span>
    </button>
  );
}
