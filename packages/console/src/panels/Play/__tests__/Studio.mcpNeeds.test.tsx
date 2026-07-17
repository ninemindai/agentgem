// packages/console/src/panels/Play/__tests__/Studio.mcpNeeds.test.tsx
// Regression for the Task 6 end-to-end wiring gap: Studio's internal `<Runner mcpNeeds>` plumbing
// was correct, but nothing threaded the loaded miniapp's meta.mcpNeeds into it — so a connector-only
// miniapp never got a host attached and every agentgemApp.mcp.callTool timed out. These tests mock
// Runner (like StudioShare.test.tsx) to observe the props it actually receives, and assert save()
// never drops the declared connector manifest.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { Studio } from "../Studio.js";
import * as routes from "../../../api/routes.js";

type RunnerProps = { needs?: string[]; mcpNeeds?: { server: string; tools: string[] }[] };
const { propsLog, mockRequestCapture } = vi.hoisted(() => ({
  propsLog: [] as RunnerProps[],
  mockRequestCapture: vi.fn(async () => ({ ok: false, reason: "stub" }) as { ok: boolean; dataUrl?: string; reason?: string }),
}));
vi.mock("../Runner.js", () => ({
  Runner: forwardRef((props: RunnerProps, ref: unknown) => {
    propsLog.push({ needs: props.needs, mcpNeeds: props.mcpNeeds });
    useImperativeHandle(ref as never, () => ({ requestCapture: mockRequestCapture }));
    return null;
  }),
}));

afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  propsLog.length = 0;
  mockRequestCapture.mockReset();
  mockRequestCapture.mockImplementation(async () => ({ ok: false, reason: "stub" }));
});

const mcpNeeds = [{ server: "github", tools: ["list_pull_requests"] }];
const miniapp = {
  name: "g1", html: "<html></html>",
  meta: { title: "G1", genre: "project-fun", createdFrom: { kind: "blank", title: "G1" }, engineVersion: "1", mcpNeeds },
};

function mount() {
  return render(
    <IdentityProvider apiBase="">
      <Studio apiBase="" name="g1" agents={[{ id: "claude", name: "Claude Code", available: true }]} agentId="claude"
              onAgentIdChange={() => {}} onBack={() => {}} />
    </IdentityProvider>
  );
}

describe("Studio → mcpNeeds threading (Task 6 wiring gap)", () => {
  it("passes the loaded miniapp's mcpNeeds into <Runner>", async () => {
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    mount();

    await waitFor(() => expect(propsLog.length).toBeGreaterThan(0));
    expect(propsLog[propsLog.length - 1].mcpNeeds).toEqual(mcpNeeds);
  });

  it("includes the declared mcpNeeds manifest in the save() body — save must not drop it (D10)", async () => {
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    const save = vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc", prunedNeeds: [], mcpWarnings: [] } as never);
    mount();
    await waitFor(() => expect(propsLog.length).toBeGreaterThan(0));

    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const body = save.mock.calls[0][1] as { body: { meta: { mcpNeeds?: unknown } } };
    expect(body.body.meta.mcpNeeds).toEqual(mcpNeeds);
  });

  it("carries mcpNeeds forward through the post-save reconciliation, so <Runner> stays correct", async () => {
    vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue(miniapp as never);
    vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ name: "g1", commit: "abc", prunedNeeds: [], mcpWarnings: [] } as never);
    mount();
    await waitFor(() => expect(propsLog.length).toBeGreaterThan(0));

    fireEvent.click(await screen.findByRole("button", { name: /^share$/i }));

    await waitFor(() => expect(propsLog[propsLog.length - 1].mcpNeeds).toEqual(mcpNeeds));
  });
});
