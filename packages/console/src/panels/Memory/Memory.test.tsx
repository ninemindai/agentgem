import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { Memory } from "./index.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PROVIDERS = [
  { id: "mem0", implemented: true, enabled: false, connected: false },
  { id: "zep", implemented: false, enabled: false, connected: false },
];

function stubFetch(candidates: unknown[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/api/memory/providers")) return new Response(JSON.stringify({ providers: PROVIDERS }));
    if (url.endsWith("/api/memory/outbox")) return new Response(JSON.stringify({ candidates }));
    return new Response(JSON.stringify({ ok: true }));
  }));
}

describe("Memory panel", () => {
  it("lists providers and marks unimplemented ones coming soon", async () => {
    stubFetch();
    render(<Memory apiBase="" />);
    await waitFor(() => screen.getByText(/mem0/i));
    expect(screen.getByText(/zep/i)).toBeTruthy();
    expect(screen.getByText(/coming soon/i)).toBeTruthy();
  });

  it("shows not connected for an implemented but unconfigured provider", async () => {
    stubFetch();
    render(<Memory apiBase="" />);
    await waitFor(() => screen.getByText(/mem0/i));
    expect(screen.getByText(/not connected/i)).toBeTruthy();
  });

  it("disables save and enable controls for unimplemented providers", async () => {
    stubFetch();
    render(<Memory apiBase="" />);
    await waitFor(() => screen.getByText(/zep/i));
    const zepRow = screen.getByText(/zep/i).closest("article")!;
    const saveBtn = within(zepRow).getByRole("button", { name: /save/i });
    const enableToggle = within(zepRow).getByRole("checkbox");
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
    expect((enableToggle as HTMLInputElement).disabled).toBe(true);
  });

  it("shows an empty state and refresh/push controls for the outbox", async () => {
    stubFetch([]);
    render(<Memory apiBase="" />);
    await waitFor(() => screen.getByText(/no candidates/i));
    expect(screen.getByRole("button", { name: /refresh candidates/i })).toBeTruthy();
  });

  it("renders outbox candidates with approve checkboxes and pushes selected keys", async () => {
    stubFetch([{ key: "k1", text: "remembered fact", kind: "fact", source: "session" }]);
    render(<Memory apiBase="" />);
    await waitFor(() => screen.getByText(/remembered fact/i));
    const checkbox = screen.getByRole("checkbox", { name: /remembered fact/i });
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: /push approved/i }));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).endsWith("/api/memory/push") && (c[1] as RequestInit | undefined)?.method === "POST",
    )).toBe(true));
  });

  it("persists the enable toggle by POSTing to /providers on change", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/memory/providers") && init?.method === "POST")
        return new Response(JSON.stringify({ ok: true }));
      if (String(url).endsWith("/api/memory/providers"))
        return new Response(JSON.stringify({ providers: [{ id: "mem0", implemented: true, enabled: false, connected: true }] }));
      if (String(url).endsWith("/api/memory/outbox")) return new Response(JSON.stringify({ candidates: [] }));
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Memory apiBase="" />);
    await waitFor(() => screen.getByText(/mem0/i));
    const checkbox = screen.getByRole("checkbox", { name: /enabled/i });
    fireEvent.click(checkbox);
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(([u, i]: any[]) => String(u).endsWith("/api/memory/providers") && i?.method === "POST");
      expect(posted).toBeTruthy();
      expect(String(posted![1].body)).toContain('"enabled":true');
    });
  });

  it("shows a pulling… state then the pulled count", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/memory/providers")) return new Response(JSON.stringify({ providers: [{ id: "mem0", implemented: true, enabled: true, connected: true }] }));
      if (String(url).endsWith("/api/memory/outbox")) return new Response(JSON.stringify({ candidates: [] }));
      if (String(url).endsWith("/api/memory/pull")) return new Response(JSON.stringify({ pulled: 3 }));
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Memory apiBase="" />);
    await waitFor(() => screen.getByText(/mem0/i));
    fireEvent.click(screen.getByRole("button", { name: /pull now/i }));
    await waitFor(() => screen.getByText(/pulled 3/i));
  });
});
