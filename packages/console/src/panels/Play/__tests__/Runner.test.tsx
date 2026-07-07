// packages/console/src/panels/Play/__tests__/Runner.test.tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Runner } from "../Runner.js";

afterEach(cleanup);

describe("Runner", () => {
  it("renders a sealed iframe (allow-scripts, no allow-same-origin) with the html in srcDoc", () => {
    const { container } = render(<Runner html="<h1>hi there</h1>" />);
    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts"); // sealed: scripts run, but null-origin
    expect(iframe.getAttribute("srcdoc")).toContain("<h1>hi there</h1>");
  });

  it("renders the game at a full-window virtual viewport (scaled to fit, not clipped)", () => {
    const { container } = render(<Runner html="<p>x</p>" vw={1200} vh={780} />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    // The iframe itself is sized to the virtual window; a CSS transform scales it down to the container.
    expect(iframe.style.width).toBe("1200px");
    expect(iframe.style.height).toBe("780px");
    expect(iframe.style.transform).toContain("scale(");
  });
});
