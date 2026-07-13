import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Contribute } from "./Contribute.js";

afterEach(cleanup);

const res = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("Contribute", () => {
  it("reflects the contribute-setting toggle, round-trips a change, and disables Contribute now when off", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/benchmark/contribute-setting") && init?.method !== "POST") {
        return res({ enabled: false });
      }
      if (u.includes("/api/benchmark/contribute-setting") && init?.method === "POST") {
        return res({ enabled: true });
      }
      throw new Error(`unexpected ${u}`);
    }));
    render(<Contribute apiBase="" />);

    const toggle = await screen.findByRole("checkbox", { name: /contribute to the network benchmark/i });
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
    expect((screen.getByRole("button", { name: "Contribute now" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(toggle);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
    await waitFor(() => expect((screen.getByRole("button", { name: "Contribute now" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("posts /contribute when on and renders per-gem result rows with a reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/benchmark/contribute-setting")) return res({ enabled: true });
      if (u.includes("/api/benchmark/contribute") && init?.method === "POST") {
        return res({
          results: [
            { gem: "pdf-skill", status: "ingested" },
            { gem: "no-workspace", status: "skipped", reason: "no local workspace" },
          ],
        });
      }
      throw new Error(`unexpected ${u}`);
    }));
    render(<Contribute apiBase="" />);

    const button = await screen.findByRole("button", { name: "Contribute now" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    expect(await screen.findByText("pdf-skill")).toBeTruthy();
    expect(screen.getByText("ingested")).toBeTruthy();
    expect(screen.getByText("no-workspace")).toBeTruthy();
    expect(screen.getByText("skipped")).toBeTruthy();
    expect(screen.getByText("no local workspace")).toBeTruthy();
  });

  it("shows an error, not a silent failure, when the setting fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: { message: "boom" } }, 500)));
    render(<Contribute apiBase="" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
