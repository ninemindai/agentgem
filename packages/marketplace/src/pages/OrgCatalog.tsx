import { useEffect, useMemo, useState } from "react";
import type { makeApi } from "../api";
import type { OrgCatalog as OrgCatalogT, OrgAppStatus, OrgSkill } from "../types";
import { CutBadge } from "../CutBadge";
import { StoneRating } from "../StoneRating";
import { RubricRing } from "../RubricRing";

type View = { status: "loading" } | { status: "notfound" } | { status: "error" } | { status: "ok"; catalog: OrgCatalogT };
type Sort = "grade" | "stone";

export function OrgCatalog({ api, scope }: { api: ReturnType<typeof makeApi>; scope: string }) {
  const [view, setView] = useState<View>({ status: "loading" });
  const [q, setQ] = useState("");
  const [cut, setCut] = useState("");
  const [sort, setSort] = useState<Sort>("grade");
  const [open, setOpen] = useState<string | null>(null);
  const [appStatus, setAppStatus] = useState<OrgAppStatus | null>(null);
  const [internal, setInternal] = useState<OrgSkill[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.getOrgCatalog(scope)
      .then((c) => { if (alive) setView(c ? { status: "ok", catalog: c } : { status: "notfound" }); })
      .catch(() => { if (alive) setView({ status: "error" }); });
    return () => { alive = false; };
  }, [api, scope]);

  useEffect(() => {
    let alive = true;
    api.getOrgApp(scope).then((s) => {
      if (!alive) return;
      setAppStatus(s);
      if (s?.isMember) api.getOrgSkills(scope).then((sk) => { if (alive) setInternal(sk); });
    });
    return () => { alive = false; };
  }, [api, scope]);

  const gems = view.status === "ok" ? view.catalog.gems : [];
  const cuts = useMemo(() => [...new Set(gems.map((g) => g.cut).filter((c): c is string => !!c))].sort(), [gems]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = gems.filter((g) =>
      (!cut || g.cut === cut) &&
      (!needle || g.key.toLowerCase().includes(needle) || (g.description ?? "").toLowerCase().includes(needle)));
    return [...filtered].sort((a, b) =>
      sort === "stone"
        ? b.stars - a.stars || (b.grade ?? 0) - (a.grade ?? 0) || a.key.localeCompare(b.key)
        : (b.grade ?? 0) - (a.grade ?? 0) || b.stars - a.stars || a.key.localeCompare(b.key));
  }, [gems, q, cut, sort]);

  if (view.status === "loading") return <div className="ex-orgcat"><p className="ex-empty">Loading…</p></div>;
  if (view.status === "notfound") return <div className="ex-orgcat"><p className="ex-empty">No catalog for @{scope}.</p></div>;
  if (view.status === "error") return <div className="ex-orgcat"><p className="ex-empty">Couldn't load the catalog for @{scope}. Please try again.</p></div>;

  const c = view.catalog;
  return (
    <div className="ex-orgcat">
      <header className="ex-orgcat-head">
        <h2 className="ex-orgcat-title">@{c.scope}</h2>
        <span className="ex-orgcat-counts">{c.gemCount} gems · {c.ownerCount} owners</span>
        <a className="ex-orgcat-usage-link" href={`/orgs/${encodeURIComponent(c.scope)}/usage`}>Team Pulse (members) →</a>
        <a className="ex-orgcat-usage-link" href={`/orgs/${encodeURIComponent(c.scope)}/benchmark`}>Benchmark (admins) →</a>
      </header>
      {appStatus && !appStatus.installed && (
        <p className="ex-orgcat-appcta">
          <a href="https://github.com/apps/agentgem/installations/new" target="_blank" rel="noreferrer">
            Install the AgentGem GitHub App
          </a>
          {" "}to sync private membership and index internal skills.
        </p>
      )}
      {appStatus?.isMember && internal && internal.length > 0 && (
        <section className="ex-orgcat-internal">
          <h3>Internal skills</h3>
          <ul className="ex-internal-list">
            {internal.map((s) => (
              <li key={s.sourceId + "/" + s.path} className="ex-internal-item">
                <span className="ex-internal-name">{s.name}</span>
                <span className="ex-internal-repo">{s.repo}</span>
                {s.description && <span className="ex-internal-desc">{s.description}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {c.gemCount === 0 ? (
        <p className="ex-empty">No gems published under @{c.scope} yet.</p>
      ) : (
        <>
          <div className="ex-orgcat-controls">
            <input className="ex-orgcat-search" type="search" placeholder="Search gems…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search gems" />
            <select className="ex-orgcat-cut" value={cut} onChange={(e) => setCut(e.target.value)} aria-label="Filter by cut">
              <option value="">All cuts</option>
              {cuts.map((ct) => <option key={ct} value={ct}>{ct}</option>)}
            </select>
            <select className="ex-orgcat-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
              <option value="grade">Sort: grade</option>
              <option value="stone">Sort: stone</option>
            </select>
          </div>
          <ul className="ex-gem-list">
            {shown.map((g) => (
              <li key={g.key} className="ex-gem-item">
                <div className="ex-gem-card">
                  <span className="ex-gem-head">
                    <a className="ex-gem-key" href={"/gems/" + encodeURIComponent(g.key)}>{g.key}</a>
                    <CutBadge cut={g.cut ?? undefined} />
                    <StoneRating cut={g.cut ?? undefined} grade={g.grade ?? undefined} stars={g.stars} installs={g.installs} verifiedInstalls={g.verifiedInstalls} />
                    <RubricRing checks={g.rubric.checks} />
                    <button type="button" className="ex-rubric-toggle" aria-expanded={open === g.key} onClick={() => setOpen(open === g.key ? null : g.key)}>
                      {open === g.key ? "Hide rubric" : "Rubric"}
                    </button>
                  </span>
                  {g.description && <span className="ex-gem-desc">{g.description}</span>}
                  {open === g.key && (
                    <ul className="ex-rubric-detail">
                      {g.rubric.checks.map((ch) => (
                        <li key={ch.id} className="ex-rubric-check" data-pass={ch.pass ? "true" : "false"}>
                          <span className="ex-rubric-mark">{ch.pass ? "✓" : "✗"}</span>
                          <span className="ex-rubric-label">{ch.label}</span>
                          {!ch.pass && <span className="ex-rubric-fix">{ch.howToFix}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
