import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Received } from "./index.js";

afterEach(cleanup);
const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("Received", () => {
  it("redeem calls /api/transfer/receive, downloads the gem, and shows result", async () => {
    const origCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:fake");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/api/transfer/receive"))
          return res({
            gem: { name: "my-gem" },
            meta: { name: "my-gem", version: "1.2.3" },
            bytesBase64: btoa(""),
          });
        throw new Error("unexpected " + url);
      }),
    );
    render(<Received apiBase="" />);
    const input = screen.getByPlaceholderText(/agentgem:\/\/gem/i);
    fireEvent.change(input, { target: { value: "agentgem://gem/b/o#KEY" } });
    fireEvent.click(screen.getByRole("button", { name: /server-side/i }));
    await waitFor(() =>
      expect(screen.getByText(/my-gem@1\.2\.3/i)).toBeTruthy(),
    );
    expect(screen.getByText(/downloaded my-gem\.gem/i)).toBeTruthy();
    URL.createObjectURL = origCreateObjectURL;
  });

  it("apply redeems then POSTs the bytes + chosen dir to /api/gem/apply", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        requests.push({ url: String(url), body: typeof init?.body === "string" ? init.body : "" });
        if (String(url).includes("/api/transfer/receive"))
          return res({ gem: { name: "my-gem" }, meta: { name: "my-gem", version: "1.0.0" }, bytesBase64: btoa("GEMBYTES") });
        if (String(url).includes("/api/gem/apply"))
          return res({ dir: "/tmp/from-alice", name: "my-gem", written: [{ type: "skill", name: "qa", overwritten: false }], skipped: [] });
        throw new Error("unexpected " + url);
      }),
    );
    render(<Received apiBase="" />);
    fireEvent.change(screen.getByPlaceholderText(/agentgem:\/\/gem/i), { target: { value: "agentgem://gem/b/o#KEY" } });
    fireEvent.change(screen.getByPlaceholderText(/target directory/i), { target: { value: "/tmp/from-alice" } });
    fireEvent.click(screen.getByRole("button", { name: /apply to machine/i }));
    await waitFor(() => expect(screen.getByText(/Applied my-gem → \/tmp\/from-alice — 1 written/i)).toBeTruthy());
    const applyReq = requests.find((r) => r.url.includes("/api/gem/apply"));
    expect(applyReq).toBeTruthy();
    if (applyReq) {
      expect(JSON.parse(applyReq.body)).toEqual({ bytesBase64: btoa("GEMBYTES"), dir: "/tmp/from-alice" });
    }
  });

  it("apply requires a target directory before redeeming", async () => {
    const fetchMock = vi.fn(async () => res({}));
    vi.stubGlobal("fetch", fetchMock);
    render(<Received apiBase="" />);
    fireEvent.change(screen.getByPlaceholderText(/agentgem:\/\/gem/i), { target: { value: "agentgem://gem/b/o#KEY" } });
    fireEvent.click(screen.getByRole("button", { name: /apply to machine/i }));
    await waitFor(() => expect(screen.getByText(/Choose a target directory/i)).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled(); // must not burn the ticket without a destination
  });

  it("redeem privately parses the ticket and never sends the key to the server", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: typeof init?.body === "string" ? init.body : "",
        });
        if (String(url).includes("/api/transfer/ciphertext"))
          return res({ ciphertextBase64: "" });
        throw new Error("unexpected " + url);
      }),
    );
    render(<Received apiBase="" />);
    const input = screen.getByPlaceholderText(/agentgem:\/\/gem/i);
    fireEvent.change(input, {
      target: { value: "agentgem://gem/mybucket/myobject#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    fireEvent.click(screen.getByRole("button", { name: /privately/i }));
    await waitFor(() => expect(requests.some((r) => r.url.includes("/api/transfer/ciphertext"))).toBe(true));
    // the key must never appear in any request body
    for (const { body } of requests) {
      expect(body).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    }
    // the ciphertext request body must be exactly {object} — no bucket, no key (zero-knowledge)
    const ctReq = requests.find((r) => r.url.includes("/api/transfer/ciphertext"));
    expect(ctReq).toBeTruthy();
    if (ctReq) {
      expect(JSON.parse(ctReq.body)).toEqual({ object: "myobject" });
    }
  });
});
