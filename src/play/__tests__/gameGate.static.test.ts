// src/play/__tests__/gameGate.static.test.ts
import { describe, it, expect } from "vitest";
import { staticGate } from "@agentgem/play";

const sealed = `<!doctype html><html><head><style>body{margin:0}</style></head>
<body><canvas></canvas><script>const x=1;</script></body></html>`;

describe("staticGate", () => {
  it("passes a self-contained bundle (inline JS/CSS, no external refs)", () => {
    expect(staticGate(sealed)).toEqual({ ok: true, failures: [] });
  });

  it("fails on an external script src", () => {
    const r = staticGate(`<script src="https://cdn.example/x.js"></script>`);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("external"))).toBe(true);
  });

  it("fails on a network call in inline script", () => {
    const r = staticGate(`<script>fetch("http://localhost:9999/api")</script>`);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("network"))).toBe(true);
  });

  it("ignores network/URL words inside the inert game-data JSON (session content, not code)", () => {
    // A replay bundle bakes the session transcript, which naturally contains "fetch"/"WebSocket"/https URLs.
    const data = JSON.stringify({ timeline: [{ role: "user", text: "use fetch and WebSocket, see https://example.com" }] });
    const html = `${sealed.replace("</body>", "")}<script id="game-data" type="application/json">${data}</script></body></html>`;
    expect(staticGate(html)).toEqual({ ok: true, failures: [] });
  });

  it("still fails a real network call even when a data blob is present", () => {
    const data = `<script id="game-data" type="application/json">{"ok":1}</script>`;
    const r = staticGate(`${data}<script>new WebSocket("wss://x")</script>`);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("network"))).toBe(true);
  });

  it("is not fooled by a fake JSON-script open inside an executable string literal", () => {
    // The '<script type="application/json">' is a STRING inside a real, executable <script>; the browser
    // runs the fetch. A naive strip-regex would delete through the trailing </script> and miss it.
    const html = `<script>
      const s = '<script type="application/json">x</' + 'script>';
      fetch("http://evil.com");
    </script>`;
    const r = staticGate(html);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("network"))).toBe(true);
  });

  it("allows data: URIs (they are self-contained)", () => {
    expect(staticGate(`<img src="data:image/png;base64,AAAA">${sealed}`).ok).toBe(true);
  });

  it("fails when the bundle exceeds the size budget", () => {
    const big = sealed + "<!--" + "x".repeat(2_000_000) + "-->";
    const r = staticGate(big, { maxBytes: 1_000_000 });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("size"))).toBe(true);
  });

  // allowNetwork is HOST POLICY, not a weakening of the gate. AgentGem seals its bundles and leaves it
  // off; a host that confines the bundle at runtime with a CSP connect-src allowlist turns it on, because there the browser enforces the single permitted origin and scanning
  // source text for `fetch` would forbid the mechanism that host is built on.
  describe("allowNetwork (host policy)", () => {
    const netCall = `<script>fetch("https://host.example.com/mcp")</script>`;

    it("rejects a network call by default — the sealed-host contract is unchanged", () => {
      const r = staticGate(netCall);
      expect(r.ok).toBe(false);
      expect(r.failures.some((f) => f.includes("network"))).toBe(true);
    });

    it("admits the same bundle when the host opts in", () => {
      expect(staticGate(netCall, { allowNetwork: true })).toEqual({ ok: true, failures: [] });
    });

    it("keeps the other three checks on — allowNetwork is not a bypass", () => {
      // The distinction that matters: CSP would block these at runtime too, but only after the miniapp
      // has already rendered silently broken. Failing at admission with a named reason is the point.
      const external = staticGate(`<script src="https://cdn.example/x.js"></script>`, { allowNetwork: true });
      expect(external.ok).toBe(false);
      expect(external.failures.some((f) => f.includes("external"))).toBe(true);

      const bare = staticGate(`<script type="module">import x from "lodash";</script>`, { allowNetwork: true });
      expect(bare.ok).toBe(false);
      expect(bare.failures.some((f) => f.includes("module import"))).toBe(true);

      const big = staticGate(sealed + "<!--" + "x".repeat(2_000_000) + "-->", { allowNetwork: true, maxBytes: 1_000_000 });
      expect(big.ok).toBe(false);
      expect(big.failures.some((f) => f.includes("size"))).toBe(true);
    });
  });
});
