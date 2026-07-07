// packages/console/src/panels/Play/Runner.tsx
import { sandboxDoc } from "../Watch/sandboxDoc.js";

// The sealed miniapp player: null-origin iframe (no allow-same-origin), strict CSP via sandboxDoc.
export function Runner({ html, height = 520 }: { html: string; height?: number }) {
  return (
    <iframe
      title="miniapp preview"
      sandbox="allow-scripts"
      srcDoc={sandboxDoc(html)}
      style={{ width: "100%", height, border: "1px solid var(--border, #ccc)", borderRadius: 8, background: "#fff" }}
    />
  );
}
