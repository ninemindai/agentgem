import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { OrgBenchmark, OrgModelBenchmarkRow, OrgMemberBenchmarkRow, AggEffectiveness } from "../types";
import type { StarsCtx } from "../Router";

type View =
  | { status: "loading" }
  | { status: "signedout" }
  | { status: "forbidden" }
  | { status: "forbidden-admin" }
  | { status: "stale" }
  | { status: "error"; message: string }
  | { status: "ok"; benchmark: OrgBenchmark };

const pct = (n: number): string => `${Math.round(n * 100)}%`;

export function Benchmark({ api, scope, stars }: { api: ReturnType<typeof makeApi>; scope: string; stars: StarsCtx }) {
  const [view, setView] = useState<View>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    setView({ status: "loading" });
    api.getOrgBenchmark(scope)
      .then((r) => {
        if (!alive) return;
        if (r.status === "unauthenticated") setView({ status: "signedout" });
        else if (r.status === "forbidden") setView({ status: "forbidden" });
        else if (r.status === "forbidden-admin") setView({ status: "forbidden-admin" });
        else if (r.status === "stale") setView({ status: "stale" });
        else setView({ status: "ok", benchmark: r.benchmark });
      })
      .catch((e) => { if (alive) setView({ status: "error", message: String((e as Error)?.message ?? e) }); });
    return () => { alive = false; };
    // api is a stable module-level singleton (App.tsx) — excluded so re-renders don't refetch.
  }, [scope]);

  return (
    <div className="ex-benchmark">
      <header className="ex-benchmark-head">
        <h1>
          <a href={"/orgs/" + encodeURIComponent(scope)} className="ex-benchmark-scope">{scope}</a> · Benchmark
        </h1>
        <p className="ex-sub">Model success rates, gem effectiveness, and per-member breakdowns — scoped to <strong>{scope}</strong>&apos;s members. Org admins only.</p>
      </header>

      {view.status === "loading" && <p className="ex-empty">Loading…</p>}
      {view.status === "error" && <p className="ex-error">Couldn&apos;t load the benchmark: {view.message}</p>}
      {view.status === "signedout" && (
        <div className="ex-usage-gate">
          <p>This benchmark is private to <strong>{scope}</strong> admins.</p>
          <a className="ex-usage-signin" href="#" onClick={(e) => { e.preventDefault(); stars.loginUrl(); }}>Sign in with GitHub</a>
        </div>
      )}
      {view.status === "forbidden" && (
        <div className="ex-usage-gate">
          <p>You&apos;re signed in, but not a member of <strong>{scope}</strong>.</p>
          <p className="ex-sub">Membership comes from your GitHub orgs, captured when you sign in or bind.</p>
        </div>
      )}
      {view.status === "forbidden-admin" && (
        <div className="ex-usage-gate">
          <p>You&apos;re a member of <strong>{scope}</strong>, but the benchmark is admins only.</p>
          <p className="ex-sub">Ask an org admin to view or share this dashboard.</p>
        </div>
      )}
      {view.status === "stale" && (
        <div className="ex-usage-gate">
          <p>Your <strong>{scope}</strong> membership check has expired.</p>
          <p className="ex-sub">Memberships are re-checked against GitHub periodically — refresh to continue.</p>
          <a className="ex-usage-signin" href="#" onClick={(e) => { e.preventDefault(); stars.loginUrl(); }}>Refresh membership</a>
        </div>
      )}

      {view.status === "ok" && <BenchmarkBody benchmark={view.benchmark} />}
    </div>
  );
}

function BenchmarkBody({ benchmark }: { benchmark: OrgBenchmark }) {
  const { modelBenchmark, effectiveness, members } = benchmark;
  if (modelBenchmark.length === 0 && effectiveness.length === 0 && members.length === 0) {
    return (
      <div className="ex-benchmark-empty">
        <p>No contributing members yet.</p>
        <p className="ex-sub">
          Benchmark rows appear once a member&apos;s bound account has produced a judged attestation.
          Orgs without the AgentGem GitHub App installed (membership via account scopes only) stay empty
          until their members are bridged to a roster.
        </p>
      </div>
    );
  }
  return (
    <>
      <ModelBenchmarkSection rows={modelBenchmark} />
      <EffectivenessSection rows={effectiveness} />
      <MembersSection rows={members} />
    </>
  );
}

function ModelBenchmarkSection({ rows }: { rows: OrgModelBenchmarkRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="model benchmark">
      <h2 className="ex-section-title">Models</h2>
      <p className="ex-benchmark-cols ex-benchmark-cols-model" aria-hidden="true">
        <span>model</span><span>producers</span><span>success rate</span><span>outcomes</span>
      </p>
      <ol className="ex-usage-rows">
        {rows.map((m) => (
          <li key={m.model} className="ex-usage-row ex-benchmark-row-model">
            <span className="ex-benchmark-name">{m.model || "unknown"}</span>
            <span className="ex-benchmark-producers">{m.producers}</span>
            <span className="ex-usage-tokens">
              <span className="ex-usage-tokens-n">{pct(m.successRate)}</span>
              <span className="ex-usage-bar"><span className="ex-usage-bar-fill" style={{ width: `${Math.max(2, Math.round(m.successRate * 100))}%` }} /></span>
            </span>
            <span className="ex-benchmark-outcomes">{m.mostly} mostly · {m.partially} partial · {m.notAchieved} missed</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function EffectivenessSection({ rows }: { rows: AggEffectiveness[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="gem effectiveness">
      <h2 className="ex-section-title">Gem Effectiveness</h2>
      <p className="ex-benchmark-cols ex-benchmark-cols-gem" aria-hidden="true">
        <span>gem</span><span>producers</span><span>score</span><span>judged</span>
      </p>
      <ol className="ex-usage-rows">
        {rows.map((g) => (
          <li key={g.gemName} className="ex-usage-row ex-benchmark-row-gem">
            <a className="ex-benchmark-name ex-benchmark-gem-link" href={"/gems/" + encodeURIComponent(g.gemName)}>{g.gemName}</a>
            <span className="ex-benchmark-producers">{g.producers}</span>
            <span className="ex-usage-tokens">
              <span className="ex-usage-tokens-n">{Math.round(g.score)}</span>
              <span className="ex-usage-bar"><span className="ex-usage-bar-fill" style={{ width: `${Math.max(2, Math.round(g.score))}%` }} /></span>
            </span>
            <span className="ex-benchmark-outcomes">{g.judged} judged</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MembersSection({ rows }: { rows: OrgMemberBenchmarkRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="member breakdown">
      <h2 className="ex-section-title">Members</h2>
      <p className="ex-benchmark-cols ex-benchmark-cols-member" aria-hidden="true">
        <span>member</span><span>gems</span><span>attestations</span><span>outcomes</span>
      </p>
      <ol className="ex-usage-rows">
        {rows.map((m) => (
          <li key={m.login} className="ex-usage-row ex-benchmark-row-member">
            <a className="ex-benchmark-name" href={"/@" + encodeURIComponent(m.login)}>{m.login}</a>
            <span className="ex-benchmark-producers">{m.gems}</span>
            <span className="ex-benchmark-producers">{m.attestations}</span>
            <span className="ex-benchmark-outcomes">{m.mostly} mostly · {m.partially} partial · {m.notAchieved} missed</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
