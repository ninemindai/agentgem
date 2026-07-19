import { useEffect, useState, useCallback } from "react";
import { makeAuth, type Me } from "../auth";
import { makeGroups, type GroupSummary } from "../groups";
import { useLocationSearch, navigate } from "../nav";

export function GroupsPanel({ me, base }: { me: Me | null; base: string }) {
  const api = makeGroups(base);
  const search = useLocationSearch();
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);

  const stripJoin = () => {
    const qs = new URLSearchParams(window.location.search);
    qs.delete("join");
    const rest = qs.toString();
    navigate(window.location.pathname + (rest ? "?" + rest : ""));
  };

  const refresh = useCallback(() => { api.list().then(setGroups).catch((e) => setErr(String(e instanceof Error ? e.message : e))); }, [base]);

  // Invite links land here as /groups?join=<token> (or /@handle?tab=groups&join=<token> inside the
  // profile hub). Redeem once, then strip only the join param — keeping the current path and any
  // other params — and refresh.
  useEffect(() => {
    if (!me) return;
    const token = new URLSearchParams(search).get("join");
    if (!token) { refresh(); return; }
    api.redeem(token)
      .then(() => { setJoined("You've joined the group."); stripJoin(); refresh(); })
      .catch((e) => { setErr(e instanceof Error ? e.message : String(e)); stripJoin(); refresh(); });
  }, [me, search]);

  if (!me) {
    const signIn = (p: "github" | "google" | "twitter") => makeAuth(base).signIn(p, window.location.href).catch((e) => setErr(String(e)));
    return (
      <div className="ex-card">
        <p>Sign in to create and manage groups. <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("github"); }}>Sign in with GitHub</a> <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("google"); }}>Sign in with Google</a> <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("twitter"); }}>Sign in with X</a></p>
        {err && <p className="ex-error">{err}</p>}
      </div>
    );
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); setErr(null);
    try { await api.create(name.trim()); setName(""); refresh(); }
    catch (e2) { setErr(e2 instanceof Error ? e2.message : String(e2)); }
    finally { setBusy(false); }
  };

  return (
    <div className="ex-card">
      <h2>Your groups</h2>
      {joined && <p className="ex-empty" style={{ color: "var(--verified)" }}>{joined}</p>}
      {err && <p className="ex-error">{err}</p>}
      <form onSubmit={create} style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <input aria-label="group name" className="ex-search" style={{ margin: 0 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="New group name" />
        <button type="submit" className="ex-signin" disabled={busy}>{busy ? "Creating…" : "Create group"}</button>
      </form>
      {groups === null ? <p className="ex-empty">Loading…</p>
        : groups.length === 0 ? <p className="ex-empty">You're not in any groups yet. Create one above.</p>
        : (
          <ul className="ex-groups" style={{ listStyle: "none", padding: 0 }}>
            {groups.map((g) => (
              <li key={g.id} style={{ padding: "6px 0" }}>
                <a href={"/groups/" + encodeURIComponent(g.id)}>{g.name}</a> <span className="ex-chip">{g.role}</span>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

/** Route wrapper: mirrors Account's shim — handle-having users go to their profile's Groups tab
 *  (forwarding query params so an invite /groups?join=<token> lands on /@handle?tab=groups&join=…);
 *  handle-less users get the panel inline; signed-out falls through to the panel's sign-in prompt. */
export function Groups({ me, base }: { me: Me | null; base: string }) {
  useEffect(() => {
    if (!me?.handle) return;
    const qs = window.location.search ? "&" + window.location.search.slice(1) : "";
    navigate(`/@${encodeURIComponent(me.handle)}?tab=groups${qs}`);
  }, [me]);
  if (me?.handle) return null;
  return <GroupsPanel me={me} base={base} />;
}
