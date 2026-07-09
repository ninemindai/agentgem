import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { Studio } from "../Studio.js";
import * as routes from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const miniapp = { html: "<html></html>", meta: { title: "Snake", genre: "project-fun", createdFrom: "blank", engineVersion: "1" } };

function mount() {
  return render(
    <IdentityProvider apiBase="">
      <Studio apiBase="" name="snake" agents={[{ id: "claude", label: "Claude" }] as never} agentId="claude"
              onAgentIdChange={() => {}} onBack={() => {}} />
    </IdentityProvider>
  );
}

describe("Studio → Share to app.agentgem.ai", () => {
  it("bound: saves then publishes with the verified login as scope", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob", workspace: "snake" }) });
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();
  });

  it("unbound: shows the inline connect instead of publishing, and does not dead-end", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    expect(await screen.findByText(/Connect GitHub to publish/i)).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();
    expect(screen.queryByText(/Connect your GitHub in Curate/)).toBeNull();
  });

  it("unbound: authorizing resumes the publish automatically, without re-saving", async () => {
    vi.spyOn(routes.bindStatusRoute, "call")
      .mockResolvedValueOnce({ bound: false } as never)
      .mockResolvedValueOnce({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    const save = vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    vi.stubGlobal("open", vi.fn());

    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /connect github/i }));
    fireEvent.click(await screen.findByRole("button", { name: /copy code & open github/i }));

    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob" }) });
    expect(save).toHaveBeenCalledTimes(1); // NOT re-saved on resume
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();
  });

  it("a failed save never reaches the bind gate", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockRejectedValue(new Error("gate: needs a seal"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    await waitFor(() => expect(screen.getByText(/save failed|Not sealed yet/i)).toBeTruthy());
    expect(screen.queryByText(/Connect GitHub to publish/i)).toBeNull();
  });

  it("dismissing the connect banner clears the pending publish", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    fireEvent.click(await screen.findByRole("button", { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByText(/Connect GitHub to publish/i)).toBeNull());
    expect(publish).not.toHaveBeenCalled();
  });
});
