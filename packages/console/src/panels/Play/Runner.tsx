// packages/console/src/panels/Play/Runner.tsx
import { useEffect, useRef, useState } from "react";
import { sandboxDoc } from "../Watch/sandboxDoc.js";

// The sealed miniapp player: null-origin iframe (no allow-same-origin), strict CSP via sandboxDoc.
// Miniapps are usually full-window apps (html,body{height:100%;overflow:hidden}), so a short fixed
// iframe would CLIP them top-and-bottom. Instead render at a realistic virtual window (vw×vh) and
// scale that iframe down to the container width — the whole game shows, aspect preserved, no clipping.
export function Runner({ html, vw = 1200, vh = 780 }: { html: string; vw?: number; vh?: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return; // jsdom / non-browser: keep the default
    const measure = () => setScale(Math.min(1, (box.clientWidth || vw) / vw)); // never upscale past 1:1
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [vw]);

  return (
    <div ref={boxRef} style={{ width: "100%", height: Math.round(vh * scale), overflow: "hidden",
      border: "1px solid var(--border, #ccc)", borderRadius: 8, background: "#fff" }}>
      <iframe
        title="miniapp preview"
        sandbox="allow-scripts"
        srcDoc={sandboxDoc(html)}
        style={{ width: vw, height: vh, border: 0, display: "block", transform: `scale(${scale})`, transformOrigin: "top left" }}
      />
    </div>
  );
}
