import { useEffect, useRef, useState } from "react";
import { openDashboardStream } from "./dashboardStream.js";
import { sandboxDoc } from "./sandboxDoc.js"; // NOT ./index.js — avoids the index↔Dashboard cycle (#10)

// Two stacked iframes, cross-faded. A new render is written into the HIDDEN buffer;
// on its load we fade it in and flip `visible`. No white flash, no scroll-reset — this
// is what makes the wholesale-HTML update read as "evolve in place" (design D2).
export function Dashboard({ apiBase, file }: { apiBase: string; file: string }) {
  const [bufs, setBufs] = useState<[string, string]>(["", ""]);
  const [visible, setVisible] = useState(0); // index of the on-screen buffer
  const [rendered, setRendered] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [failed, setFailed] = useState(false);
  // Has a `rendering` burst ever been seen this subscription? Distinguishes a quiet
  // session (no activity yet) from "first dashboard is being built" (spec: Interaction states).
  const [seenRendering, setSeenRendering] = useState(false);
  // A `failed` that arrives before any successful render — the "building" copy would
  // otherwise sit there forever with no signal that something went wrong (spec: Error handling).
  const [firstFailed, setFirstFailed] = useState(false);
  const [announce, setAnnounce] = useState("");
  // The stream callback is created ONCE per [apiBase,file], so it must NOT read `visible`/
  // `rendered` state (stale — that broke the double-buffer entirely; see eng-review Q1).
  // Mirror them in refs and compute the write-target from the refs.
  const visibleRef = useRef(0);
  const renderedRef = useRef(false);
  const targetRef = useRef(0); // buffer we last wrote into

  useEffect(() => {
    setBufs(["", ""]); setVisible(0); setRendered(false); setRendering(false); setFailed(false);
    setSeenRendering(false); setFirstFailed(false); setAnnounce("");
    visibleRef.current = 0; renderedRef.current = false;
    return openDashboardStream(apiBase, file, (m) => {
      if (m.type === "rendering") { setRendering(true); setSeenRendering(true); }
      else if (m.type === "failed") {
        setRendering(false);
        if (renderedRef.current) setFailed(true); else setFirstFailed(true);
      }
      else if (m.type === "render") {
        setRendering(false); setFailed(false); setFirstFailed(false);
        const write = renderedRef.current ? (visibleRef.current === 0 ? 1 : 0) : 0; // hidden buffer, or buffer 0 first time
        targetRef.current = write;
        setBufs((prev) => { const next: [string, string] = [prev[0], prev[1]]; next[write] = sandboxDoc(m.html); return next; });
        setAnnounce("dashboard updated");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, file]);

  // When the freshly-written buffer paints, flip visibility to it (cross-fade via CSS)
  // and advance the refs so the NEXT render targets the other buffer.
  const onBufLoad = (idx: number) => {
    if (!bufs[idx]) return;
    if (idx === targetRef.current) {
      visibleRef.current = idx; renderedRef.current = true;
      setVisible(idx); setRendered(true);
    }
  };

  return (
    <div className="dash-pane">
      <div className="run-status" style={{ gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        {rendering && <span className="run-badge run-running">rendering</span>}
        {failed && <span className="run-badge" title="the last dashboard failed to update">showing last render</span>}
      </div>
      {!rendered && !failed && (
        firstFailed ? (
          <p className="ledger-empty"><strong style={{ display: "block" }}>Couldn't render yet</strong>
            The agent had trouble with the first dashboard. Retrying on the next update.</p>
        ) : seenRendering ? (
          <p className="ledger-empty"><strong style={{ display: "block" }}>Reading the session…</strong>
            Building the first dashboard from what the agent has done. Usually a few seconds.</p>
        ) : (
          <p className="ledger-empty"><strong style={{ display: "block" }}>Quiet session</strong>
            The dashboard appears once the agent acts.</p>
        )
      )}
      <div className="dash-frames" data-empty={!rendered}>
        {[0, 1].map((i) => (
          bufs[i] ? (
            <iframe
              key={i}
              title="session dashboard"
              aria-label="session dashboard"
              sandbox="allow-scripts"
              srcDoc={bufs[i]}
              className={"dash-frame" + (visible === i ? " is-visible" : "")}
              onLoad={() => onBufLoad(i)}
            />
          ) : null
        ))}
      </div>
      <div role="status" aria-live="polite" className="sr-only">{announce}</div>
    </div>
  );
}
