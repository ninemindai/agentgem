// packages/console/src/panels/Observe/index.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { observeRawRoute, inventoryRoute, makeClient, type ObserveRange, type ObserveFilter } from "../../api/routes.js";
import { setPendingContribution } from "../../pendingAnalyze.js";
import { aggregateObserve, type SessionStat } from "@agentgem/insight/observeAggregate";
import { Dashboard } from "./Dashboard.js";
import { TranscriptViewer } from "./TranscriptViewer.js";
import { TranscriptDiff } from "./TranscriptDiff.js";
import { Loading } from "../../shell/Loading.js";

type Ref = { agent: "claude" | "codex"; sessionId: string };

// Sub-route under #/inspect:
//   #/inspect/<agent>/<sessionId>              → single-session transcript viewer
//   #/inspect/<agent>/<sessionId>?vs=<a>:<id>  → side-by-side diff vs. another run
// Anything else (incl. bare #/inspect) is the aggregate dashboard.
function parseSelection(hash: string): { a: Ref; b: Ref | null } | null {
  const [path, query] = hash.split("?");
  const m = /^#\/inspect\/(claude|codex)\/(.+)$/.exec(path);
  if (!m) return null;
  const a: Ref = { agent: m[1] as Ref["agent"], sessionId: decodeURIComponent(m[2]) };
  const vs = new URLSearchParams(query ?? "").get("vs");
  const vm = vs ? /^(claude|codex):(.+)$/.exec(vs) : null;
  const b: Ref | null = vm ? { agent: vm[1] as Ref["agent"], sessionId: decodeURIComponent(vm[2]) } : null;
  return { a, b };
}

export function Observe({ apiBase }: { apiBase: string }) {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const selection = parseSelection(hash);
  const [stats, setStats] = useState<SessionStat[] | null>(null);
  const [range, setRange] = useState<ObserveRange>("7d");
  const [filter, setFilter] = useState<ObserveFilter>({ minMsgs: 100 });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // The heavy cost is the disk scan, so fetch the raw stats ONCE (and on Refresh)
  // and derive every range/filter view locally via the shared aggregateObserve —
  // range tabs and filters then cost zero API calls. freshRef forces ?refresh=true
  // for a manual reload while staying out of the dep array.
  const freshRef = useRef(false);

  useEffect(() => {
    let alive = true;
    setPending(true);
    setError(null);
    const fresh = freshRef.current; freshRef.current = false;
    observeRawRoute.call(makeClient(apiBase), { query: fresh ? { refresh: true } : {} })
      .then((p) => { if (alive) setStats(p.sessions); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setPending(false); });
    return () => { alive = false; };
  }, [apiBase, reloadKey]);

  const onRefresh = () => { freshRef.current = true; setReloadKey((k) => k + 1); };

  // "Share my setup" (light) and "Publish" (heavy) both need the inventory, but
  // only when the user acts — Inspect doesn't otherwise scan it. Both fetch it
  // lazily on click, so opening Inspect stays cheap and the data is always fresh.

  // Light path: resolve name+provenance (counts by kind) at click time. An empty
  // setup throws a user-facing message, surfaced inline instead of minting a
  // hollow "0 skills" card; a fetch failure throws the real error, not a false
  // "add skills first".
  const resolveSetupShare = async () => {
    const inv = await inventoryRoute.call(makeClient(apiBase));
    const parts = [
      [inv.skills.length, "skill"], [inv.mcpServers.length, "MCP"],
      [inv.instructions.length, "instruction"], [inv.hooks.length, "hook"],
    ] as const;
    const total = parts.reduce((n, [c]) => n + c, 0);
    if (total === 0) throw new Error("Nothing to share yet — add skills first");
    const provenance = parts.filter(([c]) => c > 0)
      .map(([c, w]) => `${c} ${w}${c === 1 ? "" : "s"}`).join(" · ");
    return { name: "my-setup", provenance };
  };

  // "Publish": bundle the whole inventory into a Gem via Curate's Publish flow.
  const onPublishSetup = async () => {
    try {
      const inv = await inventoryRoute.call(makeClient(apiBase));
      const keys = [
        ...inv.skills.map((a) => `skills::${a.name}`),
        ...inv.mcpServers.map((a) => `mcpServers::${a.name}`),
        ...inv.instructions.map((a) => `instructions::${a.name}`),
        ...inv.hooks.map((a) => `hooks::${a.name}`),
      ];
      setPendingContribution({ keys, skillCount: inv.skills.length, lessonCount: 0, name: "my-setup" });
      window.location.hash = "#/curate";
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  // Pure, instant re-derivation on any range/filter change — no network.
  const data = useMemo(
    () => (stats ? aggregateObserve(stats, range, Date.now(), filter) : null),
    [stats, range, filter.agent, filter.project, filter.model, filter.minMsgs],
  );

  if (selection) {
    const back = () => { window.location.hash = "#/inspect"; };
    return (
      <div className="obs">
        {selection.b
          ? <TranscriptDiff apiBase={apiBase} a={selection.a} b={selection.b} onBack={back} />
          : <TranscriptViewer apiBase={apiBase} agent={selection.a.agent} sessionId={selection.a.sessionId} onBack={back} />}
      </div>
    );
  }

  if (error) return <div className="obs"><p className="obs-error">Couldn't load Inspect: {error}</p></div>;
  if (!data) return <div className="obs"><Loading /></div>;
  // First run: the local session log is empty. Orient a brand-new user instead of showing a
  // hollow zeroed dashboard.
  if (stats && stats.length === 0) return (
    <div className="obs">
      <div className="obs-firstrun">
        <h2 className="obs-firstrun-title">Nothing to inspect yet</h2>
        <p className="obs-firstrun-text">
          Run an agent (Claude Code and friends) in a project, then come back — Inspect reads your
          local session log and shows what your agents actually did, so you can mine the good parts
          into gems.
        </p>
        <button type="button" className="ledger-sort" onClick={() => { window.location.hash = "#/gems/market"; }}>
          Get gems to try →
        </button>
      </div>
    </div>
  );
  return (
    <div className="obs">
      <Dashboard
        data={data} range={range} onRange={setRange} filter={filter} onFilter={setFilter}
        pending={pending} onRefresh={onRefresh}
        apiBase={apiBase} resolveSetupShare={resolveSetupShare} onPublishSetup={onPublishSetup}
      />
    </div>
  );
}

export const observePage = defineConsolePage({
  id: "observe", title: "Inspect", icon: "👁", order: 10, phase: "observe", category: "setup",
  route: "#/inspect", component: Observe,
});
