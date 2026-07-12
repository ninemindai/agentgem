import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { Me } from "../auth";
import type { Profile as ProfileT } from "../types";
import { StoneRating } from "../StoneRating";
import { ratingStars } from "../reviews";
import { useLocationSearch, navigate } from "../nav";
import { AccountPanel } from "./Account";
import { GroupsPanel } from "./Groups";

type View = { status: "loading" } | { status: "notfound" } | { status: "ok"; profile: ProfileT };

const TABS = [
  { id: "apps", label: "Apps", owner: false },
  { id: "reviews", label: "Reviews", owner: false },
  { id: "orgs", label: "Orgs", owner: true },
  { id: "groups", label: "Groups", owner: true },
  { id: "account", label: "Account", owner: true },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function Profile({ api, login, me, base }: { api: ReturnType<typeof makeApi>; login: string; me?: Me | null; base: string }) {
  const [view, setView] = useState<View>({ status: "loading" });
  const search = useLocationSearch();

  useEffect(() => {
    let alive = true;
    api.getProfile(login)
      .then((p) => { if (alive) setView(p ? { status: "ok", profile: p } : { status: "notfound" }); })
      .catch(() => { if (alive) setView({ status: "notfound" }); });
    return () => { alive = false; };
  }, [api, login]);

  const isOwner = !!(me?.handle && me.handle.toLowerCase() === login.toLowerCase());
  const requested = new URLSearchParams(search).get("tab") as TabId | null;
  const canSee = (t: (typeof TABS)[number]) => !t.owner || isOwner;
  const active: TabId = TABS.find((t) => t.id === requested && canSee(t)) ? (requested as TabId) : "apps";
  const setTab = (id: TabId) => navigate(`/@${encodeURIComponent(login)}?tab=${id}`);

  if (view.status === "loading") return <div className="ex-profile"><p className="ex-empty">Loading…</p></div>;
  if (view.status === "notfound") return <div className="ex-profile"><p className="ex-empty">No profile for @{login}.</p></div>;
  const p = view.profile;

  return (
    <div className="ex-profile">
      <header className="ex-profile-head">
        {p.avatarUrl && <img className="ex-avatar-lg" src={p.avatarUrl} alt="" width={64} height={64} />}
        <h2 className="ex-profile-login">
          {p.githubUrl ? <a href={p.githubUrl} target="_blank" rel="noreferrer">@{p.login}</a> : <span>@{p.login}</span>}
          {p.verified && <span className="ex-verified" title="Verified GitHub identity"> ✓ Verified</span>}
        </h2>
        <span className="ex-profile-stars">★ {p.totalStars}</span>
      </header>

      <div className="ex-tabs" role="tablist" aria-label="profile sections">
        {TABS.filter(canSee).map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === active}
            className={"ex-tab" + (t.id === active ? " is-active" : "")} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {active === "apps" && (
        p.gems.length === 0
          ? <p className="ex-empty">@{p.login} hasn't published any gems yet.</p>
          : <ul className="ex-gem-list">{p.gems.map((g) => (
              <li key={g.key} className="ex-gem-item">
                <a className="ex-gem-card" href={"/gems/" + encodeURIComponent(g.key)}>
                  <span className="ex-gem-head"><span className="ex-gem-key">{g.key}</span>
                    <StoneRating grade={g.grade ?? undefined} stars={g.stars} installs={g.installs} verifiedInstalls={g.verifiedInstalls} /></span>
                  {g.description && <span className="ex-gem-desc">{g.description}</span>}
                </a>
              </li>))}</ul>
      )}

      {active === "reviews" && (
        (p.reviews ?? []).length === 0
          ? <p className="ex-empty">No reviews written yet.</p>
          : <ul className="ex-reviews-list">{(p.reviews ?? []).map((r, i) => (
              <li key={r.sourceId + "/" + r.path + i} className="ex-review">
                <div className="ex-review-meta">
                  <a href={`/skills/${encodeURIComponent(r.sourceId)}/${r.path}`}>{r.name}</a>
                  <span className="ex-scope">{r.sourceId}</span>
                  <span className="ex-review-rating" aria-label={`${r.rating} of 5`}>{ratingStars(r.rating)}</span>
                  <time className="ex-review-date" dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleDateString()}</time>
                </div>
                {r.body && <p className="ex-review-body">{r.body}</p>}
              </li>))}</ul>
      )}

      {active === "orgs" && isOwner && (
        (me?.orgs.length ?? 0) === 0
          ? <p className="ex-empty">You're not in any orgs.</p>
          : <section className="ex-profile-orgs" aria-label="your orgs">
              <ul className="ex-org-chips">{me!.orgs.map((o) => (
                <li key={o.scope} className="ex-org-chip">
                  <a className="ex-org-chip-name" href={"/orgs/" + encodeURIComponent(o.scope)}>@{o.scope}</a>
                  {o.role === "admin" && <span className="ex-org-chip-role">admin</span>}
                  <a className="ex-org-chip-usage" href={`/orgs/${encodeURIComponent(o.scope)}/usage`}>Team Pulse →</a>
                </li>))}</ul>
            </section>
      )}

      {active === "groups" && isOwner && <GroupsPanel me={me!} base={base} />}
      {active === "account" && isOwner && <AccountPanel api={api} me={me!} base={base} />}
    </div>
  );
}
