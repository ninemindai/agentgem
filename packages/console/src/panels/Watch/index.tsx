import { useEffect, useRef, useState } from "react";
import { defineConsolePage } from "../../registry.js";
import { fetchSessions, openWatchStream, type WatchSession, type ArtifactVersion } from "./watchStream.js";
import { SessionFeed } from "./SessionFeed.js";
import { sandboxDoc } from "./sandboxDoc.js";

export { sandboxDoc };

const ageLabel = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
};

// The original Watch view: the session's HTML artifacts, each rendered in a
// null-origin sandboxed iframe. Owns its own artifact stream, keyed on `file`.
function ArtifactPane({ apiBase, file }: { apiBase: string; file: string }) {
  const [artifacts, setArtifacts] = useState<ArtifactVersion[]>([]);
  const [current, setCurrent] = useState<number | null>(null); // index into artifacts
  const [phase, setPhase] = useState<string>("connecting");
  const [mode, setMode] = useState<"transcript" | "file" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const followRef = useRef(true); // auto-advance to newest until the user picks a version

  useEffect(() => {
    setArtifacts([]); setCurrent(null); setPhase("connecting"); setMode(null); setError(null);
    followRef.current = true;
    return openWatchStream(apiBase, file, (e) => {
      if (e.type === "phase") { setPhase(e.phase); if (e.mode) setMode(e.mode); }
      else if (e.type === "failed") { setError(e.message); setPhase(""); }
      else if (e.type === "artifact") {
        setArtifacts((prev) => {
          const next = [...prev, e.artifact];
          if (followRef.current) setCurrent(next.length - 1);
          return next;
        });
      }
    });
  }, [apiBase, file]);

  const shown = current !== null ? artifacts[current] : undefined;

  return (
    <>
      <div className="run-status" style={{ gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        {phase && !error && <span className="run-badge run-running">{phase}</span>}
        {mode && !error && (
          <span className="ws-chip" title={mode === "file" ? "Rendering the file the agent wrote on disk" : "Reconstructed from the session transcript"}>
            {mode === "file" ? "file-driven" : "transcript"}
          </span>
        )}
        {artifacts.length > 0 && (
          <select
            className="ledger-search"
            aria-label="artifact version"
            style={{ width: "auto", marginBottom: 0 }}
            value={current ?? artifacts.length - 1}
            onChange={(e) => { followRef.current = false; setCurrent(Number(e.target.value)); }}
          >
            {artifacts.map((a, i) => (
              <option key={i} value={i}>{a.name} · v{a.version} ({a.tool})</option>
            ))}
          </select>
        )}
        {shown?.truncated && <span className="run-badge run-running">truncated</span>}
      </div>

      {error && <p className="ledger-error" role="alert">{error}</p>}
      {!shown && !error && <p className="ledger-empty">Waiting for the session to write an HTML file…</p>}
      {shown && (
        <iframe
          title="artifact preview"
          aria-label={`artifact ${shown.name} v${shown.version}`}
          sandbox="allow-scripts"
          srcDoc={sandboxDoc(shown.html)}
          style={{ width: "100%", height: 520, border: "1px solid var(--border, #ccc)", borderRadius: 8, background: "#fff" }}
        />
      )}
    </>
  );
}

export function Watch({ apiBase }: { apiBase: string }) {
  const [sessions, setSessions] = useState<WatchSession[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The live Dashboard tab was retired in favor of the History → Session
  // Dashboard lens (generated once + cached per transcript); the live side
  // keeps Feed (events) and Artifact (sandboxed HTML).
  const [view, setView] = useState<"feed" | "artifact">("feed");

  const loadSessions = () => {
    fetchSessions(apiBase).then(setSessions).catch(() => setSessions([]));
  };

  useEffect(loadSessions, [apiBase]);

  return (
    <section className="analyze">
      <div className="obs-head"><h2 className="obs-title">Watch</h2></div>
      <p className="analyze-intro">
        Watch a running coding session (Claude Code, Codex, Gemini, Cline, Continue) as it works — the live Feed streams every
        message and tool call as it happens, or switch to Artifact to preview an HTML page it builds. Content is redacted before it reaches this panel.
      </p>

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Left: active sessions */}
        <div style={{ flex: "1 1 260px", minWidth: 240 }}>
          <div className="run-status" style={{ justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontWeight: 600 }}>Active sessions</span>
            <button type="button" className="ledger-view" onClick={loadSessions}>Refresh</button>
          </div>
          <ul className="analyze-list" style={{ maxHeight: 520, overflowY: "auto" }}>
            {sessions === null && <li className="ledger-empty">Loading…</li>}
            {sessions !== null && sessions.length === 0 && (
              <li className="ledger-empty">No sessions active in the last few hours.</li>
            )}
            {(sessions ?? []).map((s) => (
              <li key={s.file}>
                <button
                  type="button"
                  className={"analyze-row" + (selected === s.file ? " is-active" : "")}
                  style={{ display: "block", width: "100%", textAlign: "left", cursor: "pointer" }}
                  onClick={() => setSelected(s.file)}
                >
                  <div className="analyze-row-head">
                    <span className="analyze-name">{s.project ?? s.id.slice(0, 8)}</span>
                    <span className="ws-chip">{s.agent}</span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    {s.msgs} msgs · {ageLabel(s.ageMs)}{s.model ? ` · ${s.model}` : ""}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Right: Feed (live events) or Artifact (sandboxed HTML) for the picked session */}
        <div style={{ flex: "2 1 460px", minWidth: 320 }}>
          {!selected && <p className="ledger-empty">Select a session to watch it.</p>}
          {selected && (
            <>
              <div className="feed-toggle" role="tablist" aria-label="watch mode" style={{ marginBottom: 8 }}>
                <button type="button" role="tab" aria-selected={view === "feed"}
                  className={"ledger-view" + (view === "feed" ? " is-active" : "")} onClick={() => setView("feed")}>Feed</button>
                <button type="button" role="tab" aria-selected={view === "artifact"}
                  className={"ledger-view" + (view === "artifact" ? " is-active" : "")} onClick={() => setView("artifact")}>Artifact</button>
              </div>
              {/* key on file so switching sessions remounts the pane and resets its stream */}
              {view === "feed"
                ? <SessionFeed key={selected} apiBase={apiBase} file={selected} />
                : <ArtifactPane key={selected} apiBase={apiBase} file={selected} />}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export const watchPage = defineConsolePage({
  id: "watch",
  title: "Watch",
  icon: "📺",
  order: 10,
  phase: "observe", category: "sessions",
  route: "#/watch",
  component: Watch,
});
