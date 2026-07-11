import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { IdentityChip } from "../../../identity/IdentityChip.js";
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

// Mounts IdentityChip alongside Studio, sharing one IdentityProvider. The chip is the
// real consumer of the identity context, so it's what a "did onBound clobber the
// refreshed record" regression test needs to observe.
function mountWithChip() {
  return render(
    <IdentityProvider apiBase="">
      <IdentityChip apiBase="" />
      <Studio apiBase="" name="snake" agents={[{ id: "claude", label: "Claude" }] as never} agentId="claude"
              onAgentIdChange={() => {}} onBack={() => {}} />
    </IdentityProvider>
  );
}

describe("Studio → Share to app.agentgem.ai", () => {
  it("bound: saves then publishes with the verified login as scope", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob", workspace: "snake", version: "0.1.0", visibility: "public" }) });
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();
  });

  it("scope set to Unlisted: publishes with visibility: unlisted and surfaces the /games/ link", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /^unlisted$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob", workspace: "snake", version: "0.1.0", visibility: "unlisted" }) });
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();
    expect(await screen.findByText(/https:\/\/app\.agentgem\.ai\/games\/@bob\/snake/)).toBeTruthy();
  });

  it("bound + already published by me: shows the confirm banner, and each button publishes the right version", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: true, ownedByMe: true, latestVersion: "1.2.3" } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "1.2.4", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    expect(await screen.findByText(/already published \(v1\.2\.3\)/)).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: /publish v1\.2\.4/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ version: "1.2.4" }) });
  });

  it("bound + already published by me: Overwrite publishes the latest version, not the bumped one", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: true, ownedByMe: true, latestVersion: "1.2.3" } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "1.2.3", shareUrl: "https://agentgem.ai/share/s" } as never);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    fireEvent.click(await screen.findByRole("button", { name: /overwrite v1\.2\.3/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ version: "1.2.3" }) });
  });

  it("bound + name taken by someone else: surfaces a message and never publishes", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: true, ownedByMe: false, latestVersion: "1.0.0" } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    expect(await screen.findByText(/already published by another account/)).toBeTruthy();
    expect(publish).not.toHaveBeenCalled();
  });

  it("unbound: shows the inline connect instead of publishing, and does not dead-end", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
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
    const save = vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    const status = vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    vi.stubGlobal("open", vi.fn());

    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /connect github/i }));
    fireEvent.click(await screen.findByRole("button", { name: /copy code & open github/i }));

    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(status.mock.calls[0][1]).toMatchObject({ query: expect.objectContaining({ scope: "bob" }) });
    expect(publish.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob", version: "0.1.0" }) });
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
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    fireEvent.click(await screen.findByRole("button", { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByText(/Connect GitHub to publish/i)).toBeNull());
    expect(publish).not.toHaveBeenCalled();
  });

  it("resuming a publish does not clobber the freshly-refreshed identity record (avatarUrl/sessionActive survive Studio's onBound)", async () => {
    vi.spyOn(routes.bindStatusRoute, "call")
      .mockResolvedValueOnce({ bound: false } as never)
      .mockResolvedValueOnce({ bound: true, login: "bob", avatarUrl: "https://a/bob.png", sessionActive: true } as never);
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    const save = vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc1234", prunedNeeds: [] } as never);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://gh/d", deviceCode: "dc" } as never);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as never);
    vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
    const publish = vi.spyOn(routes.publishSetupRoute, "call").mockResolvedValue({ exploreRef: "@bob/snake", version: "0.1.0", shareUrl: "https://agentgem.ai/share/s" } as never);
    vi.stubGlobal("open", vi.fn());

    mountWithChip();
    fireEvent.click(await screen.findByRole("button", { name: /share to app\.agentgem\.ai/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /connect github/i }));
    fireEvent.click(await screen.findByRole("button", { name: /copy code & open github/i }));

    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledTimes(1); // NOT re-saved on resume
    expect(await screen.findByText(/Published to app\.agentgem\.ai/)).toBeTruthy();

    // The chip is the real consumer of identity context. If Studio's onBound wrote an
    // optimistic { bound: true, login } over the freshly-refreshed record, avatarUrl and
    // sessionActive would be gone and the chip's title would read "Session expired…".
    const chip = await screen.findByRole("button", { name: /@bob/ });
    const img = await screen.findByRole("img", { name: /bob/i });
    expect(img.getAttribute("src")).toBe("https://a/bob.png");
    expect(chip.getAttribute("title")).toBe("Open app.agentgem.ai signed in");
  });
});
