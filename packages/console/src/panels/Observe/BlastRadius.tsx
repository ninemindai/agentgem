// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/Observe/BlastRadius.tsx
//
// Session blast radius (Inspect → Session): a replayable map of everything the
// session touched — project files by directory, outside-project paths, skills,
// subagents, MCP servers, commands — with a bucketed cool/warm playback deck.
// Scrub or play the run and watch the map light up; click a target to pin its
// visit history; click a visit to jump the playhead. Claude-only, like the
// context timeline (the scan reads Claude transcripts). Inspired by
// cosmtrek/mindwalk's touch-depth night map.
import { useEffect, useMemo, useRef, useState } from "react";
import { blastRoute, makeClient, type BlastReport } from "../../api/routes.js";
import { buildBlast, depthAt, visitsAt, type BlastTarget } from "./blastModel.js";
import { fmtTime } from "./data.js";
import { useSplit } from "../../shell/useSplit.js";

const KIND_COLOR: Record<BlastTarget["kind"], string> = {
  file: "var(--blue)", skill: "var(--purple)", agent: "var(--pink)", mcp: "var(--teal)", exec: "var(--slate)",
};

function cellColor(t: BlastTarget, playhead: number): string | undefined {
  const depth = depthAt(t, playhead);
  if (depth === 0) return undefined;
  const base = depth === 2 ? "var(--green)" : KIND_COLOR[t.kind];
  const c = visitsAt(t, playhead);
  const pct = c >= 4 ? 58 : c >= 2 ? 40 : 24;
  return `color-mix(in srgb, ${base} ${pct}%, transparent)`;
}

export function BlastRadius({ apiBase, agent, sessionId }: { apiBase: string; agent: "claude" | "codex"; sessionId: string }) {
  const [rep, setRep] = useState<BlastReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [playhead, setPlayhead] = useState(Infinity);   // seq of last fired event; Infinity = full map
  const [playing, setPlaying] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const deckRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (agent !== "claude") return;
    let alive = true;
    setLoading(true); setError(null); setRep(null); setPlayhead(Infinity); setPlaying(false); setPinned(null);
    blastRoute.call(makeClient(apiBase), { query: { id: sessionId, agent } })
      .then((r) => { if (alive) setRep(r); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [apiBase, agent, sessionId]);

  const m = useMemo(() => (rep ? buildBlast(rep) : null), [rep]);
  const head = m ? Math.min(playhead, m.n - 1) : -1;

  // Playback: advance a fixed fraction per tick so any session replays in ~15s.
  useEffect(() => {
    if (!playing || !m) return;
    const step = Math.max(1, Math.round(m.n / 250));
    const id = setInterval(() => {
      setPlayhead((p) => {
        const cur = Math.min(p, m.n - 1);
        const next = cur + step;
        if (next >= m.n - 1) { setPlaying(false); return m.n - 1; }
        return next;
      });
    }, 60);
    return () => clearInterval(id);
  }, [playing, m]);

  // Hooks above the early returns (rules of hooks); the rail is the resizable pane.
  const split = useSplit("blast", { initial: 288, min: 240, max: 460, side: "end" });

  if (agent !== "claude") return null;
  if (loading) return <div className="obs br"><div className="obs-muted">Mapping blast radius…</div></div>;
  if (error) return <div className="obs br"><div className="obs-error">{error}</div></div>;
  if (!m || m.n === 0) return null;

  const seek = (seq: number) => { setPlaying(false); setPlayhead(Math.max(-1, seq)); };
  const nextFrom = (list: number[]) => list.find((s) => s > head);
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); seek(Math.min(m.n - 1, head + step)); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); seek(head - step); }
    else if (e.key === "Home") { e.preventDefault(); seek(-1); }
    else if (e.key === "End") { e.preventDefault(); seek(m.n - 1); }
    else if (e.key === "e" || e.key === "E") { const s = nextFrom(m.edits); if (s !== undefined) seek(s); }
    else if (e.key === "x" || e.key === "X") { const s = nextFrom(m.errors); if (s !== undefined) seek(s); }
  };
  const togglePlay = () => {
    if (playing) { setPlaying(false); return; }
    if (head >= m.n - 1) setPlayhead(-1);
    setPlaying(true);
  };

  // Playback deck geometry.
  const B = m.buckets.length;
  const W = Math.max(360, B * 9), H = 56, AXIS = H - 12;
  const ymax = Math.max(1, ...m.buckets.map((b) => b.observe + b.mutate + b.marks));
  const bw = W / B;
  const curBucket = m.buckets.reduce((acc, b) => (b.fromSeq !== -1 && b.fromSeq <= head ? b.i : acc), -1);
  const deckSeek = (clientX: number) => {
    const el = deckRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const i = Math.min(B - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * B)));
    seek(m.buckets[i].toSeq);
  };

  const pinnedT = pinned ? m.groups.flatMap((g) => g.targets).find((t) => t.key === pinned) : undefined;

  return (
    <div
      className={"obs br" + (split.containerProps.className ? " " + split.containerProps.className : "")}
      style={split.containerProps.style}
      onKeyDown={onKey}
      tabIndex={0}
      role="application"
      aria-label="Session blast radius — space plays, arrows step, E next edit, X next error"
    >
      <div className="br-main">
        <div className="br-head">
          <span className="rail-h br-title">Blast radius</span>
          {rep?.meta.project && <span className="obs-muted br-proj">{rep.meta.project}</span>}
          <span className="br-chips">
            <span className="obs-chip">{m.summary.files} files</span>
            <span className="obs-chip">{m.summary.edited} edited</span>
            {m.summary.outside > 0 && <span className="obs-chip br-chip-warn">{m.summary.outside} outside</span>}
            {m.summary.skills > 0 && <span className="obs-chip">{m.summary.skills} skills</span>}
            {m.summary.agents > 0 && <span className="obs-chip">{m.summary.agents} subagents</span>}
            {m.summary.errors > 0 && <span className="obs-chip br-chip-err">{m.summary.errors} errors</span>}
          </span>
        </div>

        <div className="br-map">
          {m.groups.map((g) => (
            <div className="br-group" key={g.label}>
              <div className="br-group-label">{g.label}</div>
              <div className="br-cells">
                {g.targets.map((t) => {
                  const depth = depthAt(t, head);
                  const bg = cellColor(t, head);
                  return (
                    <button
                      type="button"
                      key={t.key}
                      className={"br-cell" + (depth === 0 ? " is-future" : "") + (t.sidechainOnly ? " is-side" : "") + (pinned === t.key ? " is-pinned" : "")}
                      style={bg ? { background: bg } : undefined}
                      title={`${t.full} — ${t.visits.length} visit${t.visits.length === 1 ? "" : "s"}${t.edited ? " · edited" : ""}${t.sidechainOnly ? " · subagent" : ""}`}
                      onClick={() => setPinned(pinned === t.key ? null : t.key)}
                    >
                      {t.name}
                      {t.error && depth > 0 && <span className="br-err" aria-label="had an error" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="br-deck">
          <button type="button" className="br-play" onClick={togglePlay} aria-label={playing ? "pause replay" : "play replay"}>
            {playing ? "❚❚" : "▶"}
          </button>
          <svg
            ref={deckRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="br-hist"
            role="img"
            aria-label={`Activity over the session (${m.axis === "time" ? "wall clock" : "event order"})`}
            onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); deckSeek(e.clientX); }}
            onPointerMove={(e) => { if (e.buttons & 1) deckSeek(e.clientX); }}
          >
            {m.buckets.map((b) => {
              const total = b.observe + b.mutate + b.marks;
              if (!total) return null;
              const h = (total / ymax) * (AXIS - 6);
              const hm = (b.mutate / ymax) * (AXIS - 6);
              const x = b.i * bw + 1;
              return (
                <g key={b.i}>
                  <rect x={x} y={AXIS - h} width={Math.max(1, bw - 2)} height={h - hm} fill="color-mix(in srgb, var(--blue) 45%, transparent)" />
                  {hm > 0 && <rect x={x} y={AXIS - hm} width={Math.max(1, bw - 2)} height={hm} fill="var(--green)" />}
                  {b.marks > 0 && <rect x={x} y={Math.max(0, AXIS - h - 4)} width={Math.max(1, bw - 2)} height={2} fill="var(--purple)" />}
                  {b.errors > 0 && <circle cx={x + bw / 2 - 1} cy={AXIS + 5} r={2} fill="var(--red)" />}
                </g>
              );
            })}
            <line x1={0} y1={AXIS} x2={W} y2={AXIS} stroke="color-mix(in srgb, var(--muted) 40%, transparent)" strokeWidth={1} />
            {curBucket >= 0 && (
              <line x1={(curBucket + 1) * bw} y1={0} x2={(curBucket + 1) * bw} y2={H} stroke="var(--accent)" strokeWidth={1.5} />
            )}
          </svg>
          <span className="obs-muted br-pos">{head + 1}/{m.n}</span>
        </div>
      </div>

      {split.handle}
      <div className="br-rail">
        {pinnedT ? (
          <>
            <div className="rail-h br-rail-title">{pinnedT.full}</div>
            <div className="br-rail-meta">
              <span className="obs-chip">{pinnedT.kind === "file" ? pinnedT.zone : pinnedT.kind}</span>
              {pinnedT.edited && <span className="obs-chip">edited</span>}
              {pinnedT.sidechainOnly && <span className="obs-chip">subagent only</span>}
            </div>
            <ul className="br-visits">
              {pinnedT.visits.map((v) => (
                <li key={v.seq}>
                  <button type="button" className={"br-visit" + (v.seq <= head ? " is-past" : "")} onClick={() => seek(v.seq)}>
                    <span className="mono br-visit-t">{v.tsMs ? fmtTime(v.tsMs) : `#${v.seq + 1}`}</span>
                    <span className="br-visit-tool">{v.tool}</span>
                    <span className="obs-muted">{v.action}</span>
                    {v.error && <span className="br-chip-err">error</span>}
                    {v.sidechain && <span className="obs-muted">· subagent</span>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="rail-h">What this session touched</div>
            <p className="obs-muted br-hint">
              Cells light up as the run progresses — blue when observed, green once edited; deeper color means more visits.
              Scrub the strip or press play; click any cell to see its visit history.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
