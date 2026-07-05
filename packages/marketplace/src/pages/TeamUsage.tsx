import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { OrgUsage, OrgUsageRange, OrgUsageDay, OrgSettingsView } from "../types";
import type { StarsCtx } from "../Router";

const RANGES: { value: OrgUsageRange; label: string }[] = [
  { value: "7d", label: "Last 7 Days" },
  { value: "30d", label: "Last 30 Days" },
  { value: "all", label: "All Time" },
];

const DAY_MS = 86_400_000;

/** 7,657,219,219 — the leaderboard headline format. */
export const fmtFull = (n: number): string => Math.round(n).toLocaleString("en-US");

/** 7.3B / 17.3M / 5.8K — the stat-card format. */
export function fmtCompact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "K";
  return String(Math.round(n));
}

/** 583h 28m / 46m — session-duration format. */
export function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export interface HeatCell { date: string; weekday: number; week: number; tokens: number; sessions: number; level: number }

/** GitHub-contribution grid: rows = weekday (Sun..Sat), columns = weeks; level 0-4 vs the busiest day. */
export function heatCells(daily: OrgUsageDay[]): HeatCell[] {
  if (daily.length === 0) return [];
  const max = Math.max(...daily.map((d) => d.tokens));
  const firstMs = Date.parse(daily[0].date + "T00:00:00Z");
  const firstSunday = firstMs - new Date(firstMs).getUTCDay() * DAY_MS;
  return daily.map((d) => {
    const ms = Date.parse(d.date + "T00:00:00Z");
    const ratio = max > 0 ? d.tokens / max : 0;
    return {
      date: d.date,
      weekday: new Date(ms).getUTCDay(),
      week: Math.floor((ms - firstSunday) / (7 * DAY_MS)),
      tokens: d.tokens,
      sessions: d.sessions,
      level: d.tokens === 0 ? 0 : ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1,
    };
  });
}

const medal = (rank: number): string | null => (rank === 1 ? "🏆" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null);

type View =
  | { status: "loading" }
  | { status: "signedout" }
  | { status: "forbidden" }
  | { status: "stale" }
  | { status: "disabled" }
  | { status: "error"; message: string }
  | { status: "ok"; usage: OrgUsage };

/** The ?member= drill-down target from the current URL (same route, query-param navigation). */
const memberFromLocation = (): string => new URLSearchParams(window.location.search).get("member") ?? "";

/** Leaderboard rows as a CSV document (spreadsheet-ready export of the current view). Pure. */
export function membersCsv(usage: OrgUsage): string {
  const esc = (v: string | number | null) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = "rank,login,sessions,messages,active_hours,active_days,tokens_in,tokens_out,tokens_cache,tokens_total,last_active";
  const rows = usage.members.map((m, i) =>
    [i + 1, m.login, m.sessions, m.msgs, (m.activeMs / 3_600_000).toFixed(2), m.activeDays, m.tokensIn, m.tokensOut, m.tokensCache, m.tokens, m.lastActive ?? ""].map(esc).join(","));
  return [header, ...rows].join("\n") + "\n";
}

function downloadCsv(usage: OrgUsage): void {
  const blob = new Blob([membersCsv(usage)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${usage.scope}-usage-${usage.range}.csv`;
  // Firefox needs the anchor in the document for a programmatic download click, and the
  // revoke must wait until the navigation has read the blob — synchronous revoke can abort it.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function TeamUsage({ api, scope, stars }: { api: ReturnType<typeof makeApi>; scope: string; stars: StarsCtx }) {
  const [range, setRange] = useState<OrgUsageRange>("7d");
  const [member, setMember] = useState<string>(() => memberFromLocation());
  const [view, setView] = useState<View>({ status: "loading" });

  // The drill-down navigates by query param on the same path; the Router only re-renders on
  // pathname changes, so track ?member= here (App's link interception dispatches popstate).
  useEffect(() => {
    const onPop = () => setMember(memberFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    let alive = true;
    setView({ status: "loading" });
    api.getOrgUsage(scope, range, member || undefined)
      .then((r) => {
        if (!alive) return;
        if (r.status === "unauthenticated") setView({ status: "signedout" });
        else if (r.status === "forbidden") setView({ status: "forbidden" });
        else if (r.status === "stale") setView({ status: "stale" });
        else if (r.status === "disabled") setView({ status: "disabled" });
        else setView({ status: "ok", usage: r.usage });
      })
      .catch((e) => { if (alive) setView({ status: "error", message: String((e as Error)?.message ?? e) }); });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, [scope, range, member]);

  return (
    <div className="ex-usage">
      <header className="ex-usage-head">
        <h1>
          <a href={"/orgs/" + encodeURIComponent(scope)} className="ex-usage-scope">{scope}</a> · Team Pulse
          {member && <span className="ex-usage-member-crumb"> · @{member}</span>}
        </h1>
        <p className="ex-sub">Agent usage across the team — each member&apos;s local agentgem reports it on a schedule. Members only. Counts only work in <strong>{scope}</strong>-owned repos; personal and other-org sessions stay out.</p>
        {member && <p className="ex-usage-backlink"><a href={`/orgs/${encodeURIComponent(scope)}/usage`}>← Full team</a></p>}
      </header>
      <div className="ex-tabs" role="tablist" aria-label="time range">
        {RANGES.map((r) => (
          <button key={r.value} type="button" role="tab" aria-selected={r.value === range}
            className={"ex-tab" + (r.value === range ? " is-active" : "")}
            onClick={() => setRange(r.value)}>{r.label}</button>
        ))}
      </div>

      {view.status === "loading" && <p className="ex-empty">Loading…</p>}
      {view.status === "error" && <p className="ex-error">Couldn&apos;t load team usage: {view.message}</p>}
      {view.status === "signedout" && (
        <div className="ex-usage-gate">
          <p>This dashboard is private to <strong>{scope}</strong> members.</p>
          <a className="ex-usage-signin" href={stars.loginUrl()}>Sign in with GitHub</a>
        </div>
      )}
      {view.status === "forbidden" && (
        <div className="ex-usage-gate">
          <p>You&apos;re signed in, but not a member of <strong>{scope}</strong>.</p>
          <p className="ex-sub">Membership comes from your GitHub orgs, captured when you sign in or bind.</p>
        </div>
      )}
      {view.status === "stale" && (
        <div className="ex-usage-gate">
          <p>Your <strong>{scope}</strong> membership check has expired.</p>
          <p className="ex-sub">Memberships are re-checked against GitHub periodically — refresh to continue.</p>
          <a className="ex-usage-signin" href={stars.loginUrl()}>Refresh membership</a>
        </div>
      )}

      {view.status === "disabled" && (
        <div className="ex-usage-gate">
          <p>The <strong>{scope}</strong> dashboard is currently disabled by an org admin.</p>
          <p className="ex-sub">Your usage is still reported and retained per org policy — only the view is off.</p>
        </div>
      )}

      {view.status === "ok" && <TeamUsageBody usage={view.usage} member={member} scope={scope} />}
      {/* Settings stay reachable on the disabled state so an admin can flip the dashboard back on. */}
      {(view.status === "ok" || view.status === "disabled") && !member && <OrgSettingsPanel api={api} scope={scope} />}
    </div>
  );
}

const RETENTION_CHOICES: { value: string; label: string }[] = [
  { value: "forever", label: "Keep forever" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year" },
];

/** Org settings footer. Everyone sees the policy; only GitHub org ADMINS (role captured at
 *  sign-in) get the editable control — the first role-gated write surface. */
function OrgSettingsPanel({ api, scope }: { api: ReturnType<typeof makeApi>; scope: string }) {
  const [settings, setSettings] = useState<OrgSettingsView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getOrgSettings(scope)
      .then((r) => { if (alive && r.status === "ok") setSettings(r.settings); })
      .catch(() => { /* settings are an extra — never break the dashboard */ });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, [scope]);

  if (!settings) return null;
  const current = settings.retentionDays === null ? "forever" : String(settings.retentionDays);
  const isAdmin = settings.viewerRole === "admin" || settings.viewerRole === "self";

  // Each control saves ONLY its own field (server merges) — two admins editing different
  // settings from different tabs can't overwrite each other's changes.
  const save = (patch: { retentionDays?: number | null; dashboardEnabled?: boolean }) => {
    setSaving(true); setError(null);
    api.putOrgSettings(scope, patch)
      .then((r) => {
        if (r.status === "ok") setSettings(r.settings);
        else setError("org admins only");
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setSaving(false));
  };

  return (
    <section className="ex-usage-settings" aria-label="org settings">
      <span className="ex-usage-settings-label">Usage retention</span>
      {isAdmin ? (
        <select className="ex-usage-settings-select" aria-label="usage retention" value={current} disabled={saving}
          onChange={(e) => save({ retentionDays: e.target.value === "forever" ? null : Number(e.target.value) })}>
          {RETENTION_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      ) : (
        <span className="ex-usage-settings-value">{RETENTION_CHOICES.find((c) => c.value === current)?.label ?? current}</span>
      )}
      {/* Admin-only (NOT "self"): the personal view is never gated by org policy, so a
          visibility toggle there would persist a flag that has no effect. */}
      {settings.viewerRole === "admin" && (
        <label className="ex-usage-settings-toggle">
          <input type="checkbox" aria-label="dashboard visible to members" checked={settings.dashboardEnabled} disabled={saving}
            onChange={(e) => save({ dashboardEnabled: e.target.checked })} />
          Visible to members
        </label>
      )}
      {settings.updatedBy && <span className="ex-usage-settings-meta">set by {settings.updatedBy}</span>}
      {error && <span className="ex-error">{error}</span>}
    </section>
  );
}

function TeamUsageBody({ usage, member, scope }: { usage: OrgUsage; member: string; scope: string }) {
  const { totals, members, daily } = usage;
  if (members.length === 0) {
    return (
      <div className="ex-usage-gate">
        {member ? (
          <p>No usage attributed to <strong>{scope}</strong> by @{member} in this range.</p>
        ) : (
          <>
            <p>No usage reported for this range yet.</p>
            <p className="ex-sub">Each member reports from their machine: run <code>agentgem bind</code> once, then <code>agentgem warm --watch</code> (or <code>agentgem usage report</code> to push now).</p>
          </>
        )}
      </div>
    );
  }
  const cells = heatCells(daily);
  const weeks = cells.length > 0 ? Math.max(...cells.map((c) => c.week)) + 1 : 0;
  const maxTokens = members[0]?.tokens ?? 0;
  return (
    <>
      <div className="ex-usage-cards">
        <StatCard label="Total Tokens" value={totals.tokens} sub={`${fmtFull(totals.tokens)} all counted`} />
        <StatCard label="Input Tokens" value={totals.tokensIn} sub="prompts & context" />
        <StatCard label="Output Tokens" value={totals.tokensOut} sub="responses & reasoning" />
        <StatCard label="Cached Tokens" value={totals.tokensCache} sub={totals.tokensIn > 0 ? `${Math.round((totals.tokensCache / totals.tokensIn) * 100)}% hit rate` : "cache reads"} />
      </div>
      <p className="ex-usage-pulse">
        <span>{fmtFull(totals.sessions)} sessions</span> · <span>{fmtDuration(totals.activeMs)}</span> · <span>{usage.memberCount} active member{usage.memberCount === 1 ? "" : "s"}</span> · <span>{totals.activeDays} active day{totals.activeDays === 1 ? "" : "s"}</span>
      </p>

      {cells.length > 0 && (
        <section className="ex-usage-activity" aria-label="activity heatmap">
          <h2 className="ex-section-title">Activity</h2>
          <div className="ex-usage-heat-wrap">
            <div className="ex-usage-heat" style={{ gridTemplateRows: "repeat(7, 1fr)", gridTemplateColumns: `repeat(${weeks}, 1fr)` }}>
              {cells.map((c) => (
                <div key={c.date} className={"ex-usage-heat-cell lvl-" + c.level}
                  style={{ gridRow: c.weekday + 1, gridColumn: c.week + 1 }}
                  title={`${c.date}: ${c.sessions} sessions · ${fmtCompact(c.tokens)} tokens`} />
              ))}
            </div>
          </div>
        </section>
      )}

      {usage.models.length > 0 && (
        <section aria-label="models">
          <h2 className="ex-section-title">Models</h2>
          {usage.agents.length > 0 && (
            <p className="ex-usage-agents">
              {usage.agents.map((a) => (
                <span key={a.agent} className="ex-usage-agent-chip">
                  <strong>{a.agent || "unknown"}</strong> {fmtFull(a.sessions)} sessions · {fmtCompact(a.tokens)}
                </span>
              ))}
            </p>
          )}
          <ol className="ex-usage-models">
            {usage.models.map((m) => {
              const top = usage.models[0]?.tokens ?? 0;
              return (
                <li key={m.agent + "\n" + m.model} className="ex-usage-model">
                  <span className="ex-usage-model-name">{m.model || "unknown"}<span className="ex-usage-model-agent">{m.agent}</span></span>
                  <span className="ex-usage-model-sessions">{fmtFull(m.sessions)}</span>
                  <span className="ex-usage-tokens">
                    <span className="ex-usage-tokens-n">{fmtCompact(m.tokens)}</span>
                    <span className="ex-usage-bar"><span className="ex-usage-bar-fill" style={{ width: `${top > 0 ? Math.max(2, Math.round((m.tokens / top) * 100)) : 0}%` }} /></span>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <section aria-label="leaderboard">
        <div className="ex-usage-lb-head">
          <h2 className="ex-section-title">{member ? "Member" : "Leaderboard"}</h2>
          <button type="button" className="ex-usage-export" onClick={() => downloadCsv(usage)}>Export CSV</button>
        </div>
        <p className="ex-usage-cols" aria-hidden="true"><span>rank · member</span><span>sessions</span><span>duration</span><span>tokens</span></p>
        <ol className="ex-usage-rows">
          {members.map((m, i) => {
            const rank = i + 1;
            return (
              <li key={m.login} className="ex-usage-row">
                <span className="ex-usage-rank">{medal(rank) ?? rank}</span>
                {m.avatarUrl
                  ? <img className="ex-usage-avatar" src={m.avatarUrl} alt="" />
                  : <span className="ex-usage-avatar ex-usage-avatar-fallback">{m.login.slice(0, 1).toUpperCase()}</span>}
                <span className="ex-usage-who">
                  <a href={"/@" + encodeURIComponent(m.login)}>{m.login}</a>
                  <span className="ex-usage-meta">
                    {m.activeDays} active day{m.activeDays === 1 ? "" : "s"}{m.lastActive ? ` · last ${m.lastActive}` : ""}
                    {!member && <> · <a className="ex-usage-drill" href={`/orgs/${encodeURIComponent(scope)}/usage?member=${encodeURIComponent(m.login)}`}>usage →</a></>}
                  </span>
                </span>
                <span className="ex-usage-sessions">{fmtFull(m.sessions)}</span>
                <span className="ex-usage-duration">{fmtDuration(m.activeMs)}</span>
                <span className="ex-usage-tokens">
                  <span className="ex-usage-tokens-n">{fmtFull(m.tokens)}</span>
                  <span className="ex-usage-bar"><span className="ex-usage-bar-fill" style={{ width: `${maxTokens > 0 ? Math.max(2, Math.round((m.tokens / maxTokens) * 100)) : 0}%` }} /></span>
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number; sub: string }) {
  return (
    <div className="ex-usage-card">
      <span className="ex-usage-card-label">{label}</span>
      <span className="ex-usage-card-value">{fmtCompact(value)}</span>
      <span className="ex-usage-card-sub">{sub}</span>
    </div>
  );
}
