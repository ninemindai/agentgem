// packages/console/src/panels/Play/__tests__/Composer.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../Composer.js";
import { testbedProjectsRoute, playStudioRoute } from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Composer", () => {
  it("lists projects and creates a studio miniapp on pick", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [{ path: "/p/demo", flavor: "node", lastUsed: null, exists: true }] } as never);
    vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "demo" });
    const onCreated = vi.fn();
    render(<Composer apiBase="" onCreated={onCreated} />);
    await waitFor(() => expect(screen.getByText("/p/demo")).toBeTruthy());
    fireEvent.click(screen.getByText("/p/demo"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("demo"));
  });
});
