import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Materialize } from "./index.js";
import { setKeys, resetGem } from "../../activeGem.js";

afterEach(() => { cleanup(); resetGem(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("Materialize", () => {
  it("nudges to Curate when nothing is selected", () => {
    render(<Materialize apiBase="" />);
    expect(screen.getByText(/curate some artifacts first/i)).toBeTruthy();
  });

  it("builds the gem from the active selection and shows the preview", async () => {
    setKeys(new Set(["skills::pdf"]));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/gem"))
        return res({ name: "gem", createdFrom: "/x", artifacts: [{ type: "skill", name: "pdf" }], checks: [], requiredSecrets: [] });
      throw new Error("unexpected " + u);
    }));
    render(<Materialize apiBase="" />);
    fireEvent.click(screen.getByText("Build Gem"));
    expect(await screen.findByText("1 artifacts")).toBeTruthy();
  });
});
