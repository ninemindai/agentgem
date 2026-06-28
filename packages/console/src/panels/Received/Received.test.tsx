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
