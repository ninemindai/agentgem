import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { Me } from "../auth";
import type { Profile as ProfileT } from "../types";
import { StoneRating } from "../StoneRating";

type View = { status: "loading" } | { status: "notfound" } | { status: "ok"; profile: ProfileT };

export function Profile({ api, login, me }: { api: ReturnType<typeof makeApi>; login: string; me?: Me | null }) {
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

      {/* Own-profile only: org memberships are never in the public profile payload, so private
          org memberships are visible to their owner alone. NOTE: `me.orgs` is currently always
          empty — the old /api/auth/me sourced it from getAccountScopes; better-auth's get-session
          has no equivalent yet (see auth.ts, task-1b-2-report.md). This section is dormant until
          a follow-up wires a real source. */}
      {me && me.login === p.login && me.orgs.length > 0 && (
        <section className="ex-profile-orgs" aria-label="your orgs">
          <h3 className="ex-profile-subhead">Your orgs <span className="ex-profile-orgs-note">(only you see this)</span></h3>
          <ul className="ex-org-chips">
            {me.orgs.map((o) => (
              <li key={o.scope} className="ex-org-chip">
                <a className="ex-org-chip-name" href={"/orgs/" + encodeURIComponent(o.scope)}>@{o.scope}</a>
                {o.role === "admin" && <span className="ex-org-chip-role">admin</span>}
                <a className="ex-org-chip-usage" href={`/orgs/${encodeURIComponent(o.scope)}/usage`}>Team Pulse →</a>
              </li>
            ))}
          </ul>
        </section>
      )}
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

      {(p.reviews ?? []).length > 0 && (
        <section className="ex-profile-reviews">
          <h3 className="ex-profile-subhead">Reviews written</h3>
          <ul className="ex-reviews-list">
            {(p.reviews ?? []).map((r, i) => (
              <li key={r.sourceId + "/" + r.path + i} className="ex-review">
                <div className="ex-review-meta">
                  <a href={`/skill/${encodeURIComponent(r.sourceId)}/${r.path}`}>{r.name}</a>
                  <span className="ex-scope">{r.sourceId}</span>
                  <span className="ex-review-rating" aria-label={`${r.rating} of 5`}>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</span>
                  <time className="ex-review-date" dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleDateString()}</time>
                </div>
                {r.body && <p className="ex-review-body">{r.body}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
