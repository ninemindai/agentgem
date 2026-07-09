import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider } from "../IdentityProvider.js";
import { useGitHubBind, rejectionMessage } from "../useGitHubBind.js";
import * as routes from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Probe({ onBound }: { onBound?: (l: string) => void }) {
  const b = useGitHubBind("", { onBound });
  return (
    <div>
      <button onClick={() => void b.connect()}>connect</button>
      <button onClick={() => void b.copyOpenAndWait()}>copyopen</button>
      <button onClick={b.reset}>reset</button>
      <span data-testid="code">{b.flow?.userCode ?? ""}</span>
      <span data-testid="error">{b.error ?? ""}</span>
      <span data-testid="unconfigured">{String(b.unconfigured)}</span>
    </div>
  );
}
const mount = (onBound?: (l: string) => void) =>
  render(<IdentityProvider apiBase=""><Probe onBound={onBound} /></IdentityProvider>);

describe("useGitHubBind", () => {
  it("connect() shows the code without polling or opening a browser", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc", interval: 5 } as never);
    const complete = vi.spyOn(routes.bindCompleteRoute, "call");
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(screen.getByText("connect"));
    expect((await screen.findByTestId("code")).textContent).toBe("AB-12");
    expect(complete).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("prefers verificationUriComplete when the server supplies it", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", verificationUriComplete: "https://gh/device?user_code=AB-12", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("copyopen"));
    expect(openSpy).toHaveBeenCalledWith("https://gh/device?user_code=AB-12", "_blank", "noopener");
  });

  it("falls back to the bare verificationUri when no complete URL is supplied", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    const openSpy = vi.fn(); vi.stubGlobal("open", openSpy);
    mount();
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("copyopen"));
    expect(openSpy).toHaveBeenCalledWith("https://gh/device", "_blank", "noopener");
  });

  it("on success refreshes identity status and calls onBound with the login from the response, not the refreshed context", async () => {
    // The two sources deliberately disagree: bindCompleteRoute -> "bob",
    // the refreshed bindStatusRoute -> "someone-else". An implementation that
    // (wrongly) read login off the refreshed context instead of the response
    // would report "someone-else" and this assertion would catch it.
    const status = vi.spyOn(routes.bindStatusRoute, "call")
      .mockResolvedValueOnce({ bound: false } as never)
      .mockResolvedValueOnce({ bound: true, login: "someone-else" } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    vi.stubGlobal("open", vi.fn());
    const onBound = vi.fn();
    mount(onBound);
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("copyopen"));
    await waitFor(() => expect(onBound).toHaveBeenCalledWith("bob"));
    expect(onBound).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(2); // mount + refresh
    expect(screen.getByTestId("code").textContent).toBe("");
  });

  it("calls the latest onBound closure, not one captured when copyOpenAndWait was memoized", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    vi.stubGlobal("open", vi.fn());
    const oldOnBound = vi.fn();
    const newOnBound = vi.fn();
    const { rerender } = render(
      <IdentityProvider apiBase=""><Probe onBound={oldOnBound} /></IdentityProvider>,
    );
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    // Re-render with a NEW inline onBound closure before the bind resolves — this is
    // the exact scenario the stale-closure bug would break: a host re-render between
    // connect() and the copy-&-open click swaps in a fresh consumer closure.
    rerender(<IdentityProvider apiBase=""><Probe onBound={newOnBound} /></IdentityProvider>);
    fireEvent.click(screen.getByText("copyopen"));
    await waitFor(() => expect(newOnBound).toHaveBeenCalledWith("bob"));
    expect(oldOnBound).not.toHaveBeenCalled();
  });

  it("maps a rejection slug to guidance copy and keeps the flow up for retry", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: false, rejected: "unknown-producer" } as never);
    vi.stubGlobal("open", vi.fn());
    const onBound = vi.fn();
    mount(onBound);
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("copyopen"));
    await waitFor(() => expect(screen.getByTestId("error").textContent).toMatch(/Publish or share a Gem first/));
    expect(onBound).not.toHaveBeenCalled();
    expect(screen.getByTestId("code").textContent).toBe("AB-12"); // retryable
  });

  it("surfaces a thrown network error instead of swallowing it", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockRejectedValue(new Error("expired_token"));
    vi.stubGlobal("open", vi.fn());
    mount();
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("copyopen"));
    await waitFor(() => expect(screen.getByTestId("error").textContent).toBe("expired_token"));
  });

  it("sets unconfigured when the server has no GitHub app", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: false } as never);
    mount();
    fireEvent.click(screen.getByText("connect"));
    await waitFor(() => expect(screen.getByTestId("unconfigured").textContent).toBe("true"));
    expect(screen.getByTestId("code").textContent).toBe("");
  });

  it("reset() clears flow, error and unconfigured", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/device", deviceCode: "dc" } as never);
    mount();
    fireEvent.click(screen.getByText("connect"));
    await screen.findByText("AB-12");
    fireEvent.click(screen.getByText("reset"));
    expect(screen.getByTestId("code").textContent).toBe("");
    expect(screen.getByTestId("unconfigured").textContent).toBe("false");
  });

  it("rejectionMessage maps known slugs and passes unknown ones through", () => {
    expect(rejectionMessage("unknown-producer")).toMatch(/Publish or share a Gem first/);
    expect(rejectionMessage("bad-signature")).toMatch(/signature check/);
    expect(rejectionMessage("weird")).toBe("Verification failed: weird");
  });
});
