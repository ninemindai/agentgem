// packages/console/src/panels/Play/__tests__/Runner.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { Runner } from "../Runner.js";
import { playSessionDataRoute } from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

  // jsdom's MessageEvent constructor drops `source`, so set it explicitly to emulate a message from the iframe.
  const fromIframe = (win: Window, data: unknown) => {
    const ev = new MessageEvent("message", { data });
    Object.defineProperty(ev, "source", { value: win });
    window.dispatchEvent(ev);
  };

  it("brokers session-data: on the iframe's request it fetches host data and feeds it back", async () => {
    const spy = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: { project: "p" }, timeline: [{ role: "user", tsMs: 1, text: "hi" }] });
    const { container } = render(<Runner html="<p>x</p>" name="g1" apiBase="" needs={["session-data"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    fromIframe(win, { type: "agentgem:request", want: "session-data" });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.anything(), { query: { name: "g1" } }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "agentgem:feed", channel: "session-data" }), "*"));
  });

  it("ignores a request for a capability the gem did NOT declare", async () => {
    const spy = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: {}, timeline: [] });
    const { container } = render(<Runner html="<p>x</p>" name="g1" apiBase="" needs={["session-data"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    fromIframe(win, { type: "agentgem:request", want: "invoke-agent" });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled(); // want ∉ needs
  });
});
