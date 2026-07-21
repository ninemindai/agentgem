// packages/console/src/panels/Play/__tests__/Studio.builtin.test.tsx
// Built-ins ("__" namespace) are served constants: Studio renders them read-only — no composer,
// no agent selector, no Share/Request review — so nothing can hit the server's 400 guard
// (the "__repo-pulse" chat ENOENT 500, 2026-07-21).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { Studio } from "../Studio.js";
import { playMiniappRoute } from "../../../api/routes.js";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const codex = [{ id: "codex", name: "Codex", available: true }];
const stub = () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch);
};

describe("Studio built-in read-only mode", () => {
  it("renders __repo-pulse without composer, agent selector, Share, or Request review", async () => {
    stub();
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "__repo-pulse", html: "<!doctype html><body>REPO PULSE</body>",
      meta: { title: "Repo Pulse", genre: "project-fun", createdFrom: { kind: "blank", title: "Repo Pulse" }, engineVersion: "1",
        mcpNeeds: [{ server: "github", tools: ["list_commits"] }] },
    } as never);
    render(<IdentityProvider apiBase=""><Studio apiBase="" name="__repo-pulse" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);
    await waitFor(() => expect(screen.getByText(/read-only/)).toBeTruthy());   // the built-in note
    expect(screen.queryByPlaceholderText(/build\/edit/i)).toBeNull();          // no composer
    expect(screen.queryByText("Send")).toBeNull();
    expect(screen.queryByText("Share")).toBeNull();
    expect(screen.queryByText("Request review")).toBeNull();
    expect(screen.queryByText(/This agent will build\/edit/)).toBeNull();      // no agent selector
  });

  it("a regular miniapp keeps the full editing chrome", async () => {
    stub();
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "mine", html: "<!doctype html><body>x</body>",
      meta: { title: "Mine", genre: "project-fun", createdFrom: { kind: "blank", title: "Mine" }, engineVersion: "1" },
    } as never);
    render(<IdentityProvider apiBase=""><Studio apiBase="" name="mine" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);
    await waitFor(() => expect(screen.getByPlaceholderText(/build\/edit/i)).toBeTruthy());
    expect(screen.getByText("Share")).toBeTruthy();
    expect(screen.getByText("Request review")).toBeTruthy();
  });
});
