import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { Profile as ProfileT } from "../types";
import { StoneRating } from "../StoneRating";

type View = { status: "loading" } | { status: "notfound" } | { status: "ok"; profile: ProfileT };

export function Profile({ api, login }: { api: ReturnType<typeof makeApi>; login: string }) {
  const [view, setView] = useState<View>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    api.getProfile(login)
      .then((p) => { if (alive) setView(p ? { status: "ok", profile: p } : { status: "notfound" }); })
      .catch(() => { if (alive) setView({ status: "notfound" }); });
    return () => { alive = false; };
  }, [api, login]);

  if (view.status === "loading") return <div className="ex-profile"><p className="ex-empty">Loading…</p></div>;
  if (view.status === "notfound") return <div className="ex-profile"><p className="ex-empty">No profile for @{login}.</p></div>;

  const p = view.profile;
  return (
    <div className="ex-profile">
      <header className="ex-profile-head">
        {p.avatarUrl && <img className="ex-avatar-lg" src={p.avatarUrl} alt="" width={64} height={64} />}
        <h2 className="ex-profile-login">
          <a href={p.githubUrl} target="_blank" rel="noreferrer">@{p.login}</a>
          {p.verified && <span className="ex-verified" title="Verified GitHub identity"> ✓ Verified</span>}
        </h2>
        <span className="ex-profile-stars">★ {p.totalStars}</span>
      </header>
      {p.gems.length === 0 ? (
        <p className="ex-empty">@{p.login} hasn't published any gems yet.</p>
      ) : (
        <ul className="ex-gem-list">
          {p.gems.map((g) => (
            <li key={g.key} className="ex-gem-item">
              <a className="ex-gem-card" href={"/gems/" + encodeURIComponent(g.key)}>
                <span className="ex-gem-head">
                  <span className="ex-gem-key">{g.key}</span>
                  <StoneRating grade={g.grade ?? undefined} stars={g.stars} installs={g.installs} verifiedInstalls={g.verifiedInstalls} />
                </span>
                {g.description && <span className="ex-gem-desc">{g.description}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
