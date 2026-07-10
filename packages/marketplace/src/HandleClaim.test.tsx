import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { HandleClaim } from "./HandleClaim";

const res = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body } as unknown as Response);

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("HandleClaim", () => {
  it("posts the handle and calls onClaimed on 200", async () => {
    let body: string | undefined;
    const onClaimed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_u: string, o?: RequestInit) => { body = o?.body as string; return res({ handle: "ray" }); }));
    render(<HandleClaim base="https://api.x" onClaimed={onClaimed} />);
    fireEvent.change(screen.getByLabelText("handle"), { target: { value: "ray" } });
    fireEvent.click(screen.getByRole("button", { name: /claim/i }));
    await waitFor(() => expect(onClaimed).toHaveBeenCalled());
    expect(JSON.parse(body!)).toEqual({ handle: "ray" });
  });

  it("shows a charset message on 400 and does not call onClaimed", async () => {
    const onClaimed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "bad" }, false, 400)));
    render(<HandleClaim base="https://api.x" onClaimed={onClaimed} />);
    fireEvent.change(screen.getByLabelText("handle"), { target: { value: "bad name" } });
    fireEvent.click(screen.getByRole("button", { name: /claim/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/letters, numbers/i);
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it("shows a taken/reserved message on 409", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ error: "nope" }, false, 409)));
    render(<HandleClaim base="https://api.x" onClaimed={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("handle"), { target: { value: "ninemind" } });
    fireEvent.click(screen.getByRole("button", { name: /claim/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/taken or reserved/i);
  });
});
