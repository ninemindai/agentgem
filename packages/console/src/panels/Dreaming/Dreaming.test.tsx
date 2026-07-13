import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { Dreaming } from "./index.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ""; });

const EVENTS = [
  { ts: 500, kind: "skill", title: "foo", detail: "does foo", status: "queued", phase: "LEARN", key: "k1", firstSeenMs: 500, root: "/p" },
  { ts: 400, kind: "verified", title: "qa-gem", detail: "all checks passed", agent: "claude", passed: true },
  { ts: 300, kind: "opportunity", title: "sess-1", detail: "ship it", status: "queued", key: "o1", firstSeenMs: 300, root: "/proj" },
  { ts: 200, kind: "pass", title: "dream pass #1", detail: "DEEP · +3 skills · +1 lessons · +0 opportunities" },
  { ts: 100, kind: "lesson", title: "use-pnpm", detail: "use pnpm", status: "dismissed", key: "k2", firstSeenMs: 50, root: "/p" },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 2, queued: 2, lastPassAtMs: 1 }));
    if (url.includes("/api/journey")) {
      const kind = new URL(url, "http://x").searchParams.get("kind");
      const events = kind ? EVENTS.filter((e) => e.kind === kind) : EVENTS;
      return new Response(JSON.stringify({ events, truncated: false }));
    }
    return new Response(JSON.stringify({ ok: true }));
  }));
});

describe("Journey panel", () => {
  it("renders all event kinds on one timeline with the status strip", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => expect(screen.getByText("foo")).toBeTruthy());
    expect(screen.getByText("qa-gem")).toBeTruthy();       // verified
    expect(screen.getByText("dream pass #1")).toBeTruthy(); // pass
    expect(screen.getByText("use-pnpm")).toBeTruthy();      // dismissed lesson (history visible)
    expect(screen.getByText(/2 promoted/i)).toBeTruthy();   // status strip intact
    expect(screen.getByText("LEARN")).toBeTruthy();          // phase badge
  });

  it("filter chips refetch with ?kind=", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByRole("button", { name: /^verified$/i }));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes("/api/journey?kind=verified"))).toBe(true));
  });

  it("accept posts to the accept endpoint for a queued skill", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getAllByRole("button", { name: /^accept$/i })[0]);
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).endsWith("/api/dream/queue/accept"))).toBe(true));
  });

  it("reviewed events show status and no action buttons", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("use-pnpm"));
    expect(screen.getByText("dismissed")).toBeTruthy();
    // one queued skill + one queued opportunity → exactly 1 Accept and 2 Dismiss buttons
    expect(screen.getAllByRole("button", { name: /^accept$/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^dismiss$/i })).toHaveLength(2);
  });

  it("opportunity 'Publish →' routes into Curate", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("ship it"));
    fireEvent.click(screen.getByRole("button", { name: /publish/i }));
    await waitFor(() => expect(window.location.hash).toBe("#/curate"));
  });

  it("gives immediate 'Dreaming…' feedback and hits the run endpoint on Dream now", async () => {
    render(<Dreaming apiBase="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dream now" }));
    // pending state is shown synchronously — the reported bug was zero feedback here
    const pending = await screen.findByRole("button", { name: /dreaming/i });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).endsWith("/api/dream/run") && (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true));
  });

  it("previews an editable directive and applies a guardrail with hash + directive + target", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 0, queued: 1, lastPassAtMs: 1 }));
      if (url.includes("/api/journey")) return new Response(JSON.stringify({ events: [
        { ts: 700, kind: "guardrail", title: "repeated-tool-error", detail: "Bash errored 2x", status: "queued", key: "g1", firstSeenMs: 700, root: "/p" },
      ], truncated: false }));
      if (url.includes("/api/dream/guardrail/preview")) return new Response(JSON.stringify({
        current: "base\n",
        next: "base\n\n<!-- agentgem:learnings -->\n- Bash errored 2x\n<!-- /agentgem:learnings -->\n",
        hash: "H1", file: "/p/CLAUDE.md", target: "claude", ambiguous: false, malformed: false, seed: "- Bash errored 2x",
      }));
      return new Response(JSON.stringify({ ok: true, path: "/p/CLAUDE.md" }));
    }));
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("repeated-tool-error"));

    // Open the preview → the seed prefills an EDITABLE directive box.
    fireEvent.click(screen.getByRole("button", { name: /apply to claude\.md/i }));
    const box = await screen.findByLabelText(/directive/i) as HTMLTextAreaElement;
    expect(box.value).toBe("- Bash errored 2x");

    // Human edits the directive, then applies.
    fireEvent.change(box, { target: { value: "- Always run the Bash prereq first." } });
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() => {
      const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find((c) => String(c[0]).endsWith("/api/dream/queue/accept"));
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({ key: "g1", expectHash: "H1", directive: "- Always run the Bash prereq first.", target: "claude" });
    });
  });

  it("ambiguous target: toggling to AGENTS.md re-previews with target:agents", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 0, queued: 1, lastPassAtMs: 1 }));
      if (url.includes("/api/journey")) return new Response(JSON.stringify({ events: [
        { ts: 700, kind: "guardrail", title: "repeated-tool-error", detail: "Bash errored 2x", status: "queued", key: "g1", firstSeenMs: 700, root: "/p" },
      ], truncated: false }));
      if (url.includes("/api/dream/guardrail/preview")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const target = body.target === "agents" ? "agents" : "claude";
        return new Response(JSON.stringify({
          current: "base\n",
          next: "base\n\n<!-- agentgem:learnings -->\n- Bash errored 2x\n<!-- /agentgem:learnings -->\n",
          hash: target === "agents" ? "H-AGENTS" : "H-CLAUDE",
          file: target === "agents" ? "/p/AGENTS.md" : "/p/CLAUDE.md",
          target, ambiguous: true, malformed: false, seed: "- Bash errored 2x",
        }));
      }
      return new Response(JSON.stringify({ ok: true, path: "/p/AGENTS.md" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("repeated-tool-error"));

    fireEvent.click(screen.getByRole("button", { name: /apply to claude\.md/i }));
    await screen.findByLabelText(/directive/i);

    // Both toggle buttons are present in the ambiguous case.
    const claudeBtn = screen.getByRole("button", { name: "CLAUDE.md" });
    const agentsBtn = screen.getByRole("button", { name: "AGENTS.md" });
    expect(claudeBtn).toBeTruthy();
    expect(agentsBtn.getAttribute("aria-pressed")).toBe("false");

    fetchMock.mockClear();
    fireEvent.click(agentsBtn);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/dream/guardrail/preview"));
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({ key: "g1", target: "agents" });
    });
    await waitFor(() => expect(agentsBtn.getAttribute("aria-pressed")).toBe("true"));

    // Applying now must carry the re-previewed AGENTS.md hash, not the stale CLAUDE.md one.
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/api/dream/queue/accept"));
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({ key: "g1", expectHash: "H-AGENTS", target: "agents" });
    });
  });

  it("apply-conflict retry preserves the selected target and the user's edited directive", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 0, queued: 1, lastPassAtMs: 1 }));
      if (url.includes("/api/journey")) return new Response(JSON.stringify({ events: [
        { ts: 700, kind: "guardrail", title: "repeated-tool-error", detail: "Bash errored 2x", status: "queued", key: "g1", firstSeenMs: 700, root: "/p" },
      ], truncated: false }));
      if (url.includes("/api/dream/guardrail/preview")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const target = body.target === "agents" ? "agents" : "claude";
        return new Response(JSON.stringify({
          current: "base\n",
          next: "base\n\n<!-- agentgem:learnings -->\n- Bash errored 2x\n<!-- /agentgem:learnings -->\n",
          hash: target === "agents" ? "H-AGENTS" : "H-CLAUDE",
          file: target === "agents" ? "/p/AGENTS.md" : "/p/CLAUDE.md",
          target, ambiguous: true, malformed: false, seed: "- Bash errored 2x",
        }));
      }
      if (url.includes("/api/dream/queue/accept")) return new Response(JSON.stringify({ error: "stale" }), { status: 409 });
      return new Response(JSON.stringify({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("repeated-tool-error"));

    fireEvent.click(screen.getByRole("button", { name: /apply to claude\.md/i }));
    const box = await screen.findByLabelText(/directive/i) as HTMLTextAreaElement;

    // User toggles to AGENTS.md, then hand-edits the directive.
    fireEvent.click(screen.getByRole("button", { name: "AGENTS.md" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "AGENTS.md" }).getAttribute("aria-pressed")).toBe("true"));
    fireEvent.change(box, { target: { value: "- My hand-edited directive." } });

    // Apply fails (stale/corrupt drift) → the catch path re-previews.
    fetchMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/dream/guardrail/preview"));
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({ key: "g1", target: "agents" });
    });

    // The re-preview must not have flipped the target back to CLAUDE.md...
    await waitFor(() => expect(screen.getByRole("button", { name: "AGENTS.md" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: "CLAUDE.md" }).getAttribute("aria-pressed")).toBe("false");
    // ...nor overwritten the user's edited directive with the seed.
    expect((screen.getByLabelText(/directive/i) as HTMLTextAreaElement).value).toBe("- My hand-edited directive.");
  });

  it("warns (no apply) when the managed block is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 0, queued: 1, lastPassAtMs: 1 }));
      if (url.includes("/api/journey")) return new Response(JSON.stringify({ events: [
        { ts: 700, kind: "guardrail", title: "repeated-tool-error", detail: "Bash errored 2x", status: "queued", key: "g1", firstSeenMs: 700, root: "/p" },
      ], truncated: false }));
      if (url.includes("/api/dream/guardrail/preview")) return new Response(JSON.stringify({
        current: "x", next: "x", hash: "H1", file: "/p/CLAUDE.md", target: "claude", ambiguous: false, malformed: true, seed: "- Bash errored 2x",
      }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("repeated-tool-error"));
    fireEvent.click(screen.getByRole("button", { name: /apply to claude\.md/i }));
    await waitFor(() => expect(screen.getByText(/malformed/i)).toBeTruthy());
    // No apply-able diff → no Apply button and no accept POST.
    expect(screen.queryByRole("button", { name: /^apply$/i })).toBeNull();
  });

  it("re-enables the button once a new pass lands (optimistic pending clears)", async () => {
    let ran = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 2, queued: 1, lastPassAtMs: ran ? 2 : 1, progress: null }));
      if (url.endsWith("/api/dream/run")) { ran = true; return new Response(JSON.stringify({ started: true })); }
      if (url.includes("/api/journey")) return new Response(JSON.stringify({ events: [], truncated: false }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    render(<Dreaming apiBase="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dream now" }));
    await screen.findByRole("button", { name: /dreaming/i });                 // instant optimistic feedback
    await waitFor(() => expect(screen.getByRole("button", { name: "Dream now" })).toBeTruthy(), { timeout: 4000 }); // pass landed → re-enabled
  });

  it("shows the live step tracker while a pass reports progress", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: [], promoted: 0, queued: 0, lastPassAtMs: null, progress: { phase: "DEEP", phasesLit: ["LIGHT"], currentRoot: "my-app", rootIndex: 2, rootCount: 5, done: 3, total: 8 } }));
      if (url.includes("/api/journey")) return new Response(JSON.stringify({ events: [], truncated: false }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    render(<Dreaming apiBase="" />);
    await waitFor(() => expect(screen.getByText("my-app")).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/2 of 5/)).toBeTruthy());
  });
});
