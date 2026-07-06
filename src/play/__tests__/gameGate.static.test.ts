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

  it("allows data: URIs (they are self-contained)", () => {
    expect(staticGate(`<img src="data:image/png;base64,AAAA">${sealed}`).ok).toBe(true);
  });

  it("fails when the bundle exceeds the size budget", () => {
    const big = sealed + "<!--" + "x".repeat(2_000_000) + "-->";
    const r = staticGate(big, { maxBytes: 1_000_000 });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("size"))).toBe(true);
  });
});
