# Composer Searchable UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Composer's stacked flat lists (8 capability checkboxes, N-row connector list, unbounded project/session/skill lists) with a searchable-inline source picker, a chips+combobox connector picker, and a collapsed capabilities disclosure.

**Architecture:** Extract two focused components — `SourceList` (search + keyboarded list) and `ConnectorPicker` (chips + searchable combobox + chip tool-expand) — out of `Composer.tsx`. Composer keeps orchestration, the capabilities disclosure, and the seed/blank preamble composition. No server routes change.

**Tech Stack:** React, TypeScript, existing `@agentback/client` route clients, console `theme.css` tokens.

## Global Constraints

- **Intent, not authority:** capabilities + connectors only steer the build prompt (`capPreamble` + `connectorPreamble`); they never write `meta.json`. Unchanged by this refactor.
- **Options band stays ABOVE the source tabs:** clicking a Project/Session/Skill row fires `seed()` immediately, reading current `caps`/`connectors` — so intent must be settable first.
- **Console test style:** assert with `.toBeTruthy()` on `getByText` + DOM `getAttribute`; mock routes with `vi.spyOn(route, "call").mockResolvedValue(...)`. No jest-dom matchers.
- **Every className is CSS-enforced:** each new `play-*` class ships a rule in `packages/console/src/shell/theme.css`, reusing `--accent`/`--muted`/`--line`/`--line-soft`/`--font-mono`.
- Console tests: `pnpm -C packages/console test <file>`; typecheck: `pnpm -C packages/console typecheck`. Fresh worktree needs `pnpm install` first.

---

### Task 0: Worktree deps

- [ ] **Step 1: Install so tsc/vitest resolve**

Run: `pnpm install`
Expected: completes; `node_modules/@testing-library` present. (Phantom LSP "cannot find module" is expected until the TS server reindexes — trust `pnpm -C packages/console typecheck`.)

---

### Task 1: `SourceList` — searchable, keyboarded source picker

**Files:**
- Create: `packages/console/src/panels/Play/SourceList.tsx`
- Test: `packages/console/src/panels/Play/__tests__/SourceList.test.tsx`

**Interfaces:**
- Produces: `SourceList<T>({ items, filter, onPick, renderRow, placeholder, loadingLabel })`. `filter(item, q)` receives `q` already lowercased+trimmed. `renderRow(item) → { key?, main, meta? }`.

- [ ] **Step 1: Write the failing test**

`packages/console/src/panels/Play/__tests__/SourceList.test.tsx`:
```tsx
// packages/console/src/panels/Play/__tests__/SourceList.test.tsx
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { SourceList } from "../SourceList.js";

afterEach(cleanup);

type Row = { id: string; name: string };
const rows: Row[] = [{ id: "a", name: "alpha" }, { id: "b", name: "beta" }, { id: "c", name: "gamma" }];
const renderList = (onPick = vi.fn()) => {
  render(<SourceList<Row> items={rows} filter={(r, q) => r.name.includes(q)} onPick={onPick}
    renderRow={(r) => ({ key: r.id, main: r.name })} placeholder="search…" loadingLabel="Loading…" />);
  return onPick;
};

describe("SourceList", () => {
  it("shows the loading label while items is null", () => {
    render(<SourceList<Row> items={null} filter={() => true} onPick={vi.fn()}
      renderRow={(r) => ({ main: r.name })} placeholder="search…" loadingLabel="Loading rows…" />);
    expect(screen.getByText("Loading rows…")).toBeTruthy();
  });

  it("filters rows case-insensitively and shows No matches", () => {
    renderList();
    fireEvent.change(screen.getByPlaceholderText("search…"), { target: { value: "BET" } });
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.queryByText("alpha")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("search…"), { target: { value: "zzz" } });
    expect(screen.getByText(/no matches/i)).toBeTruthy();
  });

  it("picks the highlighted row on ArrowDown+Enter", () => {
    const onPick = renderList();
    const input = screen.getByPlaceholderText("search…");
    fireEvent.keyDown(input, { key: "ArrowDown" });   // highlight -> beta (index 1)
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(rows[1]);
  });

  it("picks a row on click", () => {
    const onPick = renderList();
    fireEvent.click(screen.getByText("gamma"));
    expect(onPick).toHaveBeenCalledWith(rows[2]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm -C packages/console test SourceList`
Expected: FAIL — `SourceList` module does not exist.

- [ ] **Step 3: Implement `SourceList.tsx`**

```tsx
// packages/console/src/panels/Play/SourceList.tsx
// Searchable, keyboard-navigable source list. The list is ALWAYS shown beneath the search box
// (never a closed dropdown) so the Composer's primary action — pick a source — stays discoverable.
import { useState } from "react";

interface Row { key?: string; main: string; meta?: string }

export function SourceList<T>({ items, filter, onPick, renderRow, placeholder, loadingLabel }: {
  items: T[] | null;                          // null = still loading
  filter: (item: T, q: string) => boolean;    // q is pre-lowercased + trimmed
  onPick: (item: T) => void;
  renderRow: (item: T) => Row;
  placeholder: string;
  loadingLabel: string;
}) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);            // highlighted index
  if (items == null) return <p className="play-intro">{loadingLabel}</p>;
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((it) => filter(it, needle)) : items;
  const hiIdx = Math.min(hi, Math.max(0, shown.length - 1));
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, shown.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const it = shown[hiIdx]; if (it) onPick(it); }
    else if (e.key === "Escape") { setQ(""); setHi(0); }
  }
  return (
    <div className="play-srclist">
      <input className="play-input play-srclist__search" placeholder={placeholder} value={q}
        onChange={(e) => { setQ(e.target.value); setHi(0); }} onKeyDown={onKeyDown} aria-label={placeholder} />
      {shown.length === 0 ? <p className="play-srclist__empty">No matches</p> : (
        <ul className="play-src" role="listbox">
          {shown.map((it, i) => {
            const row = renderRow(it);
            return (
              <li key={row.key ?? row.main} role="option" aria-selected={i === hiIdx}
                className={`play-src-row${i === hiIdx ? " is-hi" : ""}`} onClick={() => onPick(it)}>
                <span className="play-src-row__main">{row.main}</span>
                {row.meta && <span className="play-src-row__meta">{row.meta}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm -C packages/console test SourceList`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/SourceList.tsx packages/console/src/panels/Play/__tests__/SourceList.test.tsx
git commit -m "feat(console): SourceList — searchable keyboarded source picker"
```

---

### Task 2: `ConnectorPicker` — chips + searchable combobox

**Files:**
- Create: `packages/console/src/panels/Play/ConnectorPicker.tsx`
- Test: `packages/console/src/panels/Play/__tests__/ConnectorPicker.test.tsx`

**Interfaces:**
- Consumes: `playMcpCandidatesRoute`, `playMcpCandidateToolsRoute`, `makeClient`.
- Produces: `ConnectorPicker({ apiBase, selected, onChange })`; `connectorPreamble(servers: string[]): string` (moved here, re-exported for Composer).

- [ ] **Step 1: Write the failing test**

`packages/console/src/panels/Play/__tests__/ConnectorPicker.test.tsx`:
```tsx
// packages/console/src/panels/Play/__tests__/ConnectorPicker.test.tsx
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ConnectorPicker, connectorPreamble } from "../ConnectorPicker.js";
import { playMcpCandidatesRoute, playMcpCandidateToolsRoute } from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ConnectorPicker", () => {
  it("connectorPreamble lists checked servers", () => {
    expect(connectorPreamble([])).toBe("");
    expect(connectorPreamble(["github"])).toMatch(/mcpNeeds[\s\S]*- github/);
  });

  it("opens the menu and picks a server (onChange gets the new selection)", async () => {
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [
      { server: "github", transport: "http", needsSecret: false },
    ] } as never);
    const onChange = vi.fn();
    render(<ConnectorPicker apiBase="" selected={[]} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /add connector/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }));
    await waitFor(() => expect(screen.getByText("github")).toBeTruthy());
    fireEvent.click(screen.getByText("github"));
    expect(onChange).toHaveBeenCalledWith(["github"]);
  });

  it("lazily loads a picked server's tools when its chip is expanded", async () => {
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [
      { server: "github", transport: "http", needsSecret: false },
    ] } as never);
    const tools = vi.spyOn(playMcpCandidateToolsRoute, "call").mockResolvedValue({ tools: [{ name: "list_prs" }] } as never);
    render(<ConnectorPicker apiBase="" selected={["github"]} onChange={vi.fn()} />);
    const chip = await screen.findByRole("button", { name: /github tools/i });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(tools).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(screen.getByText(/list_prs/)).toBeTruthy());
    expect(tools).toHaveBeenCalledTimes(1);
  });

  it("does not auto-connect a needs-secret chip on expand", async () => {
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [
      { server: "pg", transport: "http", needsSecret: true },
    ] } as never);
    const tools = vi.spyOn(playMcpCandidateToolsRoute, "call").mockResolvedValue({ tools: [] } as never);
    render(<ConnectorPicker apiBase="" selected={["pg"]} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /pg tools/i }));
    await waitFor(() => expect(screen.getByText(/set it in your env/i)).toBeTruthy());
    expect(tools).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm -C packages/console test ConnectorPicker`
Expected: FAIL — `ConnectorPicker` module does not exist.

- [ ] **Step 3: Implement `ConnectorPicker.tsx`**

```tsx
// packages/console/src/panels/Play/ConnectorPicker.tsx
// Intent-only MCP connector picker: selected servers are chips (click to expand the server's tools);
// a "+ add connector" combobox opens a searchable menu of the remaining candidates. Never writes
// meta.json — the save-time scan is the authority over mcpNeeds; this only steers the build prompt.
import { useEffect, useRef, useState } from "react";
import { makeClient, playMcpCandidatesRoute, playMcpCandidateToolsRoute } from "../../api/routes.js";

type Candidate = { server: string; transport: string; needsSecret: boolean };
type ToolState = { name: string }[] | "loading" | "error";

export function connectorPreamble(servers: string[]): string {
  if (!servers.length) return "";
  return [
    "This miniapp should use these MCP connectors — for each, call its tools via",
    '`window.agentgemApp.mcp.callTool(server, tool)` and add the server to `"mcpNeeds"` in meta.json:',
    ...servers.map((s) => `- ${s}`),
  ].join("\n");
}

export function ConnectorPicker({ apiBase, selected, onChange }: { apiBase: string; selected: string[]; onChange: (servers: string[]) => void }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [toolsByServer, setToolsByServer] = useState<Record<string, ToolState>>({});
  const [expanded, setExpanded] = useState<string | null>(null);   // which chip's tools are open
  const [menuOpen, setMenuOpen] = useState(false);
  const [q, setQ] = useState("");
  const comboRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    playMcpCandidatesRoute.call(makeClient(apiBase)).then((r) => setCandidates(r.servers)).catch(() => setCandidates([]));
  }, [apiBase]);

  // Close the menu on an outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (comboRef.current && !comboRef.current.contains(e.target as Node)) setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const byName = (s: string) => candidates?.find((c) => c.server === s);
  function loadTools(c: Candidate, force = false) {
    if ((c.needsSecret && !force) || toolsByServer[c.server]) return;
    setToolsByServer((m) => ({ ...m, [c.server]: "loading" }));
    playMcpCandidateToolsRoute.call(makeClient(apiBase), { query: { server: c.server } })
      .then((r) => setToolsByServer((m) => ({ ...m, [c.server]: r.tools })))
      .catch(() => setToolsByServer((m) => ({ ...m, [c.server]: "error" })));
  }
  function toggleChip(server: string) {
    const c = byName(server);
    const open = expanded === server;
    setExpanded(open ? null : server);
    if (!open && c) loadTools(c);
  }
  function add(server: string) { onChange([...selected, server]); setMenuOpen(false); setQ(""); }
  function remove(server: string) { onChange(selected.filter((s) => s !== server)); }

  const unpicked = (candidates ?? []).filter((c) => !selected.includes(c.server));
  const needle = q.trim().toLowerCase();
  const shown = needle ? unpicked.filter((c) => c.server.toLowerCase().includes(needle)) : unpicked;

  return (
    <div className="play-connectors">
      <span className="play-connectors__label">Connectors</span>
      <div className="play-connectors__chips">
        {selected.map((server) => {
          const c = byName(server);
          const open = expanded === server;
          const tools = toolsByServer[server];
          return (
            <div key={server} className="play-chip-wrap">
              <span className="play-chip">
                <button type="button" className="play-chip__body" aria-label={`${server} tools`}
                  aria-expanded={open} aria-controls={`mcp-tools-${server}`} onClick={() => toggleChip(server)}>
                  {server}{c?.needsSecret ? " ⚠" : ""}
                </button>
                <button type="button" className="play-chip__x" aria-label={`remove ${server}`} onClick={() => remove(server)}>×</button>
              </span>
              {open && (
                <div id={`mcp-tools-${server}`} className="play-chip__tools">
                  {c?.needsSecret && !tools ? (
                    <span>Needs secret — set it in your env, then reload. <button type="button" className="play-linkbtn" onClick={() => c && loadTools(c, true)}>Try anyway</button></span>
                  ) : tools === "loading" ? <span>Connecting…</span>
                    : tools === "error" ? <span>Couldn’t connect to {server}.</span>
                    : tools == null ? null
                    : tools.length === 0 ? <span>This server exposes no tools.</span>
                    : <span>{tools.map((t) => t.name).join(", ")}</span>}
                </div>
              )}
            </div>
          );
        })}
        <div className="play-combo" ref={comboRef}>
          <button type="button" className="play-combo__btn" aria-haspopup="listbox" aria-expanded={menuOpen}
            aria-label="add connector" onClick={() => setMenuOpen((o) => !o)}>+ ▾</button>
          {menuOpen && (
            <div className="play-combo__menu">
              <input className="play-input play-combo__search" autoFocus placeholder="search connectors…" value={q}
                aria-label="search connectors" onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setMenuOpen(false); }} />
              {candidates == null ? <p className="play-combo__empty">Loading…</p>
                : candidates.length === 0 ? <p className="play-combo__empty">No MCP servers found in your agent setup. Add one to <code>~/.claude/.mcp.json</code>.</p>
                : shown.length === 0 ? <p className="play-combo__empty">{unpicked.length === 0 ? "all connectors added" : "No matches"}</p>
                : (
                  <ul className="play-combo__list" role="listbox">
                    {shown.map((c) => (
                      <li key={c.server} role="option" aria-selected={false} className="play-combo__opt" onClick={() => add(c.server)}>
                        <span>{c.server}</span>
                        <span className="play-connectors__meta">{c.transport}{c.needsSecret ? " · needs secret" : ""}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `pnpm -C packages/console test ConnectorPicker`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/panels/Play/ConnectorPicker.tsx packages/console/src/panels/Play/__tests__/ConnectorPicker.test.tsx
git commit -m "feat(console): ConnectorPicker — chips + searchable combobox (extracted)"
```

---

### Task 3: Wire Composer — Options band + SourceList tabs + caps disclosure

**Files:**
- Modify: `packages/console/src/panels/Play/Composer.tsx`
- Modify: `packages/console/src/panels/Play/__tests__/Composer.connectors.test.tsx` (update for the new combobox UI)

**Interfaces:**
- Consumes: `SourceList` (Task 1), `ConnectorPicker` + `connectorPreamble` (Task 2).

- [ ] **Step 1: Rewrite the connector portion of the existing test**

Replace `packages/console/src/panels/Play/__tests__/Composer.connectors.test.tsx` with a Composer-level check that a picked connector reaches the seed preamble through the new combobox:
```tsx
// packages/console/src/panels/Play/__tests__/Composer.connectors.test.tsx
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Composer } from "../Composer.js";
import { testbedProjectsRoute, playBlankRoute, playMcpCandidatesRoute } from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Composer + connector combobox", () => {
  it("carries a connector preamble to onCreated when a server is picked and Blank is created", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [{ server: "github", transport: "http", needsSecret: false }] } as never);
    vi.spyOn(playBlankRoute, "call").mockResolvedValue({ name: "g1" } as never);
    const onCreated = vi.fn();
    render(<Composer apiBase="" agents={[{ id: "codex", name: "Codex", available: true }]} agentId="codex" onAgentIdChange={() => {}} onCreated={onCreated} />);

    fireEvent.click(await screen.findByRole("button", { name: /add connector/i }));
    fireEvent.click(await screen.findByText("github"));           // pick into a chip
    fireEvent.click(screen.getByText("Blank"));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Create miniapp"));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(String(onCreated.mock.calls[0][1])).toMatch(/mcpNeeds[\s\S]*- github/);
  });

  it("expands the Permissions disclosure to reveal capability checkboxes", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [] } as never);
    render(<Composer apiBase="" agents={[]} agentId="" onAgentIdChange={() => {}} onCreated={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /permissions/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/run a local AI agent/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm -C packages/console test Composer.connectors`
Expected: FAIL — no "add connector" button / no "Permissions" toggle yet.

- [ ] **Step 3: Edit `Composer.tsx` — imports**

Replace the top imports block. Change line 2-6 to add the new components + `useState` (already imported) and drop `playMcpCandidatesRoute`/`playMcpCandidateToolsRoute` (now inside ConnectorPicker):
```tsx
import { useEffect, useState } from "react";
import { makeClient, playStudioRoute, playImportRoute, playBlankRoute, testbedProjectsRoute, inventoryRoute } from "../../api/routes.js";
import { fetchSessions, type WatchSession } from "../Watch/watchStream.js";
import { AgentSelector, type PlayAgent } from "./AgentSelector.js";
import { CAP_LABEL, CONSENT_CAPS } from "./consent.js";
import { SourceList } from "./SourceList.js";
import { ConnectorPicker, connectorPreamble } from "./ConnectorPicker.js";
import { useUploads } from "./uploads.js";
import { UploadsField } from "./UploadsField.js";
```
(Note: `CAP_TOOL` is still used by `capPreamble`; keep it — the import becomes `CAP_TOOL, CAP_LABEL, CONSENT_CAPS`. Only remove it if `capPreamble` is unchanged, which it is, so KEEP `CAP_TOOL`.)

Corrected consent import line:
```tsx
import { CAP_TOOL, CAP_LABEL, CONSENT_CAPS } from "./consent.js";
```

- [ ] **Step 4: Edit `Composer.tsx` — delete moved code**

Delete the `Candidate`/`ToolState` type aliases (lines 44-47), the `connectorPreamble` function (lines 49-58), and inside the component delete the connector state + helpers: `candidates`, `expanded`, `toolsByServer`, `loadTools`, `toggleExpand` (lines 101-121) and the connectors-fetch `useEffect` (lines 134-137). KEEP `const [connectors, setConnectors] = useState<string[]>([]);` (seed/doBlank still read it) but delete the old `toggleConnector` (line 107). Add a `permsOpen` state next to `caps`:
```tsx
  const [caps, setCaps] = useState<Cap[]>([]);
  const toggleCap = (c: Cap) => setCaps((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  const [permsOpen, setPermsOpen] = useState(false);
  const [connectors, setConnectors] = useState<string[]>([]);
```

- [ ] **Step 5: Edit `Composer.tsx` — replace the caps + connectors fieldsets (lines 197-242) with the Options band**

```tsx
      <div className="play-options">
        <div className="play-perms">
          <button type="button" className="play-perms__toggle" aria-expanded={permsOpen} onClick={() => setPermsOpen((o) => !o)}>
            Permissions{caps.length ? ` · ${caps.length} enabled` : ""} <span aria-hidden="true">{permsOpen ? "▾" : "▸"}</span>
          </button>
          {permsOpen && (
            <fieldset className="play-caps-pick">
              <legend>This miniapp may:</legend>
              {CONSENT_CAPS.map((c) => (
                <label key={c} className="play-caps-pick__row">
                  <input type="checkbox" checked={caps.includes(c)} onChange={() => toggleCap(c)} />
                  <span>{CAP_LABEL[c]}</span>
                </label>
              ))}
            </fieldset>
          )}
        </div>
        <ConnectorPicker apiBase={apiBase} selected={connectors} onChange={setConnectors} />
      </div>
```

- [ ] **Step 6: Edit `Composer.tsx` — replace the three source `<ul>`s with `<SourceList>`**

Project block (lines 258-265):
```tsx
      {kind === "project" && (
        <SourceList<Proj> items={projects}
          filter={(p, q) => p.path.toLowerCase().includes(q) || p.flavor.toLowerCase().includes(q)}
          onPick={(p) => seed({ kind: "project", path: p.path, flavor: p.flavor })}
          renderRow={(p) => ({ key: p.path, main: p.path, meta: p.flavor })}
          placeholder="search projects…" loadingLabel="Loading projects…" />
      )}
```

Session block (lines 267-284) — keep the genre toggle, swap the `<ul>` for `SourceList`:
```tsx
      {kind === "session" && (
        <>
          <div className="play-tabs" style={{ marginBottom: 10, alignItems: "center" }}>
            <span className="play-intro" style={{ margin: 0 }}>Genre:</span>
            <button type="button" className={`play-tab${sessionGenre === "replay" ? " is-active" : ""}`} onClick={() => setSessionGenre("replay")}>Replay</button>
            <button type="button" className={`play-tab${sessionGenre === "session-heatmap" ? " is-active" : ""}`} onClick={() => setSessionGenre("session-heatmap")}>Heatmap</button>
          </div>
          <SourceList<WatchSession> items={sessions}
            filter={(s, q) => sessionSummary(s).toLowerCase().includes(q)}
            onPick={(s) => seed({ kind: "session", agent: s.agent, ...(s.project ? { project: s.project } : {}), sessionId: s.id, summary: sessionSummary(s) })}
            renderRow={(s) => ({ key: s.id, main: s.project ?? "session", meta: `${s.agent} · ${s.msgs} msgs` })}
            placeholder="search sessions…" loadingLabel="Loading sessions…" />
        </>
      )}
```

Skill block (lines 286-293):
```tsx
      {kind === "skill" && (
        <SourceList<Skill> items={skills}
          filter={(k, q) => k.name.toLowerCase().includes(q) || (k.description ?? "").toLowerCase().includes(q)}
          onPick={(k) => seed({ kind: "skill", skillName: k.name })}
          renderRow={(k) => ({ key: k.name, main: k.name, meta: k.description })}
          placeholder="search skills…" loadingLabel="Loading skills…" />
      )}
```

- [ ] **Step 7: Run tests + typecheck, verify pass**

Run: `pnpm -C packages/console test Composer && pnpm -C packages/console typecheck`
Expected: PASS; typecheck exit 0. (If `CAP_TOOL`/`WatchSession` unused-import errors appear, reconcile per Step 3's note.)

- [ ] **Step 8: Commit**

```bash
git add packages/console/src/panels/Play/Composer.tsx packages/console/src/panels/Play/__tests__/Composer.connectors.test.tsx
git commit -m "feat(console): Composer options band + SourceList tabs + Permissions disclosure"
```

---

### Task 4: CSS

**Files:**
- Modify: `packages/console/src/shell/theme.css`

- [ ] **Step 1: Add rules (after the existing `.play-connectors-pick__tools` block, ~L2498)**

```css
/* Options band */
.play-options { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }
.play-perms__toggle { background: none; border: 0; padding: 0; cursor: pointer; font: inherit; color: var(--ink); font-size: 13px; }
/* SourceList */
.play-srclist { display: flex; flex-direction: column; gap: 8px; }
.play-srclist__search { margin: 0; }
.play-srclist .play-src { max-height: 320px; overflow-y: auto; }
.play-srclist__empty { font-size: 12px; opacity: 0.7; margin: 4px 0; }
.play-src-row.is-hi { background: var(--line-soft); }
/* Connector chips + combobox */
.play-connectors { display: flex; align-items: baseline; gap: 8px; }
.play-connectors__label { font-size: 12px; opacity: 0.7; }
.play-connectors__chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; }
.play-connectors__meta { font-size: 12px; opacity: 0.7; margin-left: 8px; }
.play-chip-wrap { display: flex; flex-direction: column; }
.play-chip { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--line); border-radius: 12px; padding: 2px 4px 2px 8px; font-size: 12px; }
.play-chip__body { background: none; border: 0; padding: 0; cursor: pointer; font: inherit; color: var(--ink); }
.play-chip__x { background: none; border: 0; padding: 0 2px; cursor: pointer; font: inherit; color: var(--muted); }
.play-chip__tools { font-size: 12px; color: var(--muted); font-family: var(--font-mono); padding: 4px 0 0 8px; max-width: 320px; }
.play-combo { position: relative; }
.play-combo__btn { border: 1px dashed var(--line); border-radius: 12px; background: none; cursor: pointer; font: inherit; font-size: 12px; padding: 2px 8px; color: var(--muted); }
.play-combo__menu { position: absolute; z-index: 5; margin-top: 4px; min-width: 220px; background: var(--raised); border: 1px solid var(--line); border-radius: 8px; padding: 6px; box-shadow: 0 6px 20px rgba(0,0,0,0.12); }
.play-combo__search { margin: 0 0 6px; width: 100%; }
.play-combo__empty { font-size: 12px; opacity: 0.7; margin: 4px; }
.play-combo__list { list-style: none; margin: 0; padding: 0; max-height: 240px; overflow-y: auto; }
.play-combo__opt { display: flex; justify-content: space-between; align-items: baseline; padding: 5px 6px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.play-combo__opt:hover { background: var(--line-soft); }
```

- [ ] **Step 2: Verify every new class resolves**

Run:
```bash
for c in play-options play-perms__toggle play-srclist play-srclist__search play-srclist__empty play-src-row.is-hi play-connectors play-connectors__label play-connectors__chips play-connectors__meta play-chip-wrap play-chip play-chip__body play-chip__x play-chip__tools play-combo play-combo__btn play-combo__menu play-combo__search play-combo__empty play-combo__list play-combo__opt; do
  printf '%-28s ' "$c"; grep -c "\.$c" packages/console/src/shell/theme.css
done
```
Expected: each ≥ 1. Also confirm `--ink`,`--raised`,`--line`,`--line-soft`,`--muted`,`--font-mono` are defined (grep `--<name>:`).

- [ ] **Step 3: Delete now-orphaned CSS**

The old `.play-connectors-pick*` rules (fieldset picker) are dead once Task 3 removes their markup. Grep for remaining usages; if none in `.tsx`, delete the `.play-connectors-pick`, `.play-connectors-pick__empty/__item/__row/__pick/__toggle/__meta/__tools` rules. Keep `.play-caps-pick*` (still used by the disclosure) and `.play-linkbtn` (reused by chip tools) and `.play-caps__mcp*` (strip, untouched).

- [ ] **Step 4: Commit**

```bash
git add packages/console/src/shell/theme.css
git commit -m "style(console): searchable source list + connector chips/combobox styles"
```

---

## Final verification

- [ ] Full console suite: `pnpm -C packages/console test` (green; pre-existing `Chat.launcher` EventSource unhandled-rejection is unrelated)
- [ ] Typecheck: `pnpm -C packages/console typecheck` (exit 0)
- [ ] Manual (verify skill, corrected entry): `pnpm build` then `AGENTGEM_HOME=$(mktemp -d) PORT=<free> node dist/client.js` → `/#/play` → New miniapp: Permissions collapses, connectors are chips + `+ ▾` searchable menu, chip-click shows tools, project/session/skill lists filter as you type.
- [ ] Open a PR off `origin/main`; let `test (24)` gate it.
