import { useEffect, useState, useCallback } from "react";
import { makeAuth, type Me } from "../auth";
import { makeGroups, type GroupSummary } from "../groups";
import { useLocationSearch, navigate } from "../nav";

export function Groups({ me, base }: { me: Me | null; base: string }) {
  const api = makeGroups(base);
  const search = useLocationSearch();
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [joined, setJoined] = useState<string | null>(null);

  const refresh = useCallback(() => { api.list().then(setGroups).catch((e) => setErr(String(e instanceof Error ? e.message : e))); }, [base]);

  // Invite links land here as /groups?join=<token>. Redeem once, then strip the param and refresh.
  useEffect(() => {
    if (!me) return;
    const token = new URLSearchParams(search).get("join");
    if (!token) { refresh(); return; }
    api.redeem(token)
      .then(() => { setJoined("You've joined the group."); navigate("/groups"); refresh(); })
      .catch((e) => { setErr(e instanceof Error ? e.message : String(e)); navigate("/groups"); refresh(); });
  }, [me, search]);

  if (!me) {
    const signIn = (p: "github" | "google") => makeAuth(base).signIn(p, window.location.href).catch((e) => setErr(String(e)));
    return (
      <div className="ex-card">
        <p>Sign in to create and manage groups. <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("github"); }}>Sign in with GitHub</a> <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("google"); }}>Sign in with Google</a></p>
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
