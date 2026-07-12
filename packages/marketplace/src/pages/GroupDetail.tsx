import { useEffect, useState, useCallback } from "react";
import { makeAuth, type Me } from "../auth";
import { makeGroups, type GroupMember, type GroupInvite, type GroupGem, type MintedInvite } from "../groups";
import { navigate } from "../nav";

export function GroupDetail({ id, me, base }: { id: string; me: Me | null; base: string }) {
  const api = makeGroups(base);
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [invites, setInvites] = useState<GroupInvite[] | null>(null);
  const [gems, setGems] = useState<GroupGem[] | null>(null);
  const [minted, setMinted] = useState<MintedInvite | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  const iAmAdmin = (members ?? []).find((m) => m.accountId === me?.id)?.role === "admin";

  const load = useCallback(() => {
    setNotFound(false);
    api.members(id)
      .then((m) => { setMembers(m); setGems(null); api.groupGems(id).then(setGems).catch(() => setGems([])); api.invites(id).then(setInvites).catch(() => setInvites(null)); })
      .catch((e) => { if ((e as { status?: number }).status === 404) setNotFound(true); else setErr(e instanceof Error ? e.message : String(e)); });
  }, [id, base]);

  useEffect(() => { if (me) load(); }, [me, id]);

  if (!me) {
    const signIn = (p: "github" | "google") => makeAuth(base).signIn(p, window.location.href).catch((e) => setErr(String(e)));
    return <div className="ex-card"><p>Sign in to view this group. <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("github"); }}>Sign in with GitHub</a> <a href="#" className="ex-signin" onClick={(e) => { e.preventDefault(); signIn("google"); }}>Sign in with Google</a></p>{err && <p className="ex-error">{err}</p>}</div>;
  }
  if (notFound) return <div className="ex-card"><p className="ex-empty">Group not found, or you're not a member.</p></div>;
  if (members === null) return <div className="ex-card"><p className="ex-empty">Loading…</p></div>;

  const mint = async () => { setErr(null); try { setMinted(await api.createInvite(id, { role: "member" })); api.invites(id).then(setInvites).catch(() => {}); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const revoke = async (inviteId: string) => { try { await api.revokeInvite(id, inviteId); api.invites(id).then(setInvites).catch(() => {}); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const remove = async (account: string) => { try { await api.removeMember(id, account); load(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const del = async () => { if (!window.confirm("Delete this group? This can't be undone.")) return; try { await api.remove(id); navigate("/groups"); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } };
  const inviteLink = minted ? `${window.location.origin}/groups?join=${encodeURIComponent(minted.token)}` : "";

  return (
    <div className="ex-card">
      <h2>Group</h2>
      {err && <p className="ex-error">{err}</p>}

      <h3>Members</h3>
      <ul className="ex-members" style={{ listStyle: "none", padding: 0 }}>
        {members.map((m) => (
          <li key={m.accountId} style={{ padding: "4px 0" }}>
            {m.login ?? "user"} <span className="ex-chip">{m.role}</span>
            {iAmAdmin && m.accountId !== me.id && <button type="button" className="ex-copy" onClick={() => remove(m.accountId)}>Remove</button>}
          </li>
        ))}
      </ul>

      {iAmAdmin && (
        <section>
          <h3>Invites</h3>
          <button type="button" className="ex-signin" onClick={mint}>Create invite link</button>
          {minted && (
            <p className="ex-empty">Share this link (shown once): <code className="ex-key">{inviteLink}</code></p>
          )}
          <ul style={{ listStyle: "none", padding: 0 }}>
            {(invites ?? []).filter((i) => !i.revokedAt).map((i) => (
              <li key={i.id} style={{ padding: "4px 0" }}>Invite {i.id.slice(0, 8)} <span className="ex-chip">{i.role}</span> <button type="button" className="ex-copy" onClick={() => revoke(i.id)}>Revoke</button></li>
            ))}
          </ul>
        </section>
      )}

      <h3>Apps shared with this group</h3>
      {gems === null ? <p className="ex-empty">Loading…</p>
        : gems.length === 0 ? <p className="ex-empty">No apps shared with this group yet.</p>
        : (
          <ul className="ex-shared-gems" style={{ listStyle: "none", padding: 0 }}>
            {gems.map((g) => (
              <li key={g.gemKey} style={{ padding: "4px 0" }}><a href={"/gems/" + encodeURIComponent(g.gemKey)}>{g.gemKey}</a> <span className="ex-gem-version">v{g.version}</span></li>
            ))}
          </ul>
        )}

      {iAmAdmin && (
        <section className="ex-card ex-danger" style={{ marginTop: 16 }}>
          <h3>Danger zone</h3>
          <button type="button" className="ex-unpublish" onClick={del}>Delete group</button>
        </section>
      )}
    </div>
  );
}
