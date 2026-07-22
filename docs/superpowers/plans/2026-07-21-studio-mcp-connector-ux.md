# Studio MCP Connector UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface installed MCP servers as a candidate picker in the Composer (intent-only) and disclose declared `mcpNeeds` with install-state in the Studio CapabilityStrip.

**Architecture:** Two decoupled paths. Disclosure reuses the existing `/api/play/mcp/servers` route; the strip renders declared connectors with three install states. Authoring adds two cheap/lazy routes (`/candidates`, `/candidate-tools`); the Composer picker is intent (steers the build prompt via a `connectorPreamble`, never writes `meta.json`).

**Tech Stack:** TypeScript, React, Zod, `@agentback/openapi` (server routes) + `@agentback/client` (console route clients), `@agentgem/play` connector layer, `@agentgem/capture` `introspectConfig`.

## Global Constraints

- **Intent, not authority:** the picker only appends to the build prompt (mirrors `capPreamble`); it never writes `meta.json`. The strip has no toggle. (Single-authority invariant.)
- **Secrets never reach the browser:** `/candidates` returns `introspectConfig({redact:true})` output only (name + transport + `needsSecret` boolean).
- **Every className is CSS-enforced:** each new `play-*` class ships its rule in `packages/console/src/shell/theme.css` in the same change.
- **`connectorPreamble` applies exactly where `capPreamble` applies** — `seed()` and `doBlank()` in `Composer.tsx`, NOT `doImport()`.
- App/play tests run compiled: `npx tsc -b && npx vitest run <name>` from repo root. Console tests: `pnpm -C packages/console test`.

---

### Task 1: Server routes — candidate list + lazy tools

**Files:**
- Modify: `packages/play/src/mcpConnectors.ts` (add `listConnectorCandidates`)
- Modify: `packages/play/src/index.ts` (export it)
- Modify: `packages/app/src/schemas.ts` (add `McpToolSchema` + 3 new schemas)
- Modify: `packages/app/src/play.controller.ts` (2 new `@get` routes)
- Test: `packages/app/src/__tests__/playMcpCandidates.test.ts`

**Interfaces:**
- Produces: `listConnectorCandidates(): { server: string; transport: "stdio"|"http"|"sse"; needsSecret: boolean }[]`
- Produces routes: `GET /api/play/mcp/candidates` → `{ servers }`; `GET /api/play/mcp/candidate-tools?server` → `{ tools: {name, description?}[] }`

- [ ] **Step 1: Write the failing test**

`packages/app/src/__tests__/playMcpCandidates.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@agentgem/play", async (orig) => {
  const actual = await orig<typeof import("@agentgem/play")>();
  return { ...actual, listConnectorCandidates: () => [
    { server: "github", transport: "stdio", needsSecret: false },
    { server: "pg", transport: "http", needsSecret: true },
  ], resolveConnectorGem: (s: string) => (s === "github" ? { name: "github" } : undefined),
    listConnectorTools: async () => { throw new Error("connect refused"); } };
});

import { PlayController } from "../play.controller.js";

afterEach(() => vi.restoreAllMocks());

describe("mcp candidate routes", () => {
  it("lists redacted candidates", async () => {
    const c = new PlayController();
    const r = await c.mcpCandidates();
    expect(r.servers.map((s) => s.server)).toEqual(["github", "pg"]);
    expect(r.servers[1]).toEqual({ server: "pg", transport: "http", needsSecret: true });
  });

  it("degrades candidate-tools to empty on connect failure", async () => {
    const c = new PlayController();
    const r = await c.mcpCandidateTools({ query: { server: "github" } });
    expect(r).toEqual({ tools: [] });
  });

  it("returns empty tools for an unknown server without connecting", async () => {
    const c = new PlayController();
    const r = await c.mcpCandidateTools({ query: { server: "nope" } });
    expect(r).toEqual({ tools: [] });
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx tsc -b 2>&1 | head; npx vitest run playMcpCandidates`
Expected: FAIL — `mcpCandidates`/`mcpCandidateTools` do not exist on `PlayController`.

- [ ] **Step 3: Add the candidate helper**

`packages/play/src/mcpConnectors.ts`, after `resolveConnectorGem` (≈ line 38):
```ts
// Cheap, redacted candidate list for the Composer picker — name + transport + whether the gem
// declares any secret. NO connect, NO tool listing; redacted so config/secret VALUES never leave
// the server. `introspectConfig` already dedups by name.
export function listConnectorCandidates(): { server: string; transport: "stdio" | "http" | "sse"; needsSecret: boolean }[] {
  return introspectConfig({ redact: true }).mcpServers.map((g) => ({
    server: g.name,
    transport: g.transport,
    needsSecret: (g.secretRefs?.length ?? 0) > 0,
  }));
}
```

`packages/play/src/index.ts`, add to the `./mcpConnectors.js` export block (beside `listConnectorTools`):
```ts
  listConnectorCandidates,
```

- [ ] **Step 4: Add schemas**

`packages/app/src/schemas.ts`, replace the inline tool object inside `PlayMcpServersResponseSchema` (≈ 1060-1072) so it reuses a factored `McpToolSchema`, and add the three new schemas directly after it:
```ts
export const McpToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  annotations: z.object({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() }).optional(),
});
export const PlayMcpServersQuerySchema = z.object({ name: z.string() });
export const PlayMcpServersResponseSchema = z.object({
  servers: z.array(z.object({
    server: z.string(),
    tools: z.array(McpToolSchema),
    configDigest: z.string().optional(),
  })),
});
export const PlayMcpCandidatesResponseSchema = z.object({
  servers: z.array(z.object({
    server: z.string(),
    transport: z.enum(["stdio", "http", "sse"]),
    needsSecret: z.boolean(),
  })),
});
export const PlayMcpCandidateToolsQuerySchema = z.object({ server: z.string() });
export const PlayMcpCandidateToolsResponseSchema = z.object({ tools: z.array(McpToolSchema) });
```

- [ ] **Step 5: Add controller routes**

`packages/app/src/play.controller.ts` — extend the `@agentgem/play` import (add `listConnectorCandidates`) and the schemas import (add the 3 new names), then add after the `mcpServers` route (≈ line 268):
```ts
  @get("/play/mcp/candidates", { response: PlayMcpCandidatesResponseSchema })
  async mcpCandidates(): Promise<z.infer<typeof PlayMcpCandidatesResponseSchema>> {
    return { servers: listConnectorCandidates() };
  }

  @get("/play/mcp/candidate-tools", { query: PlayMcpCandidateToolsQuerySchema, response: PlayMcpCandidateToolsResponseSchema })
  async mcpCandidateTools(input: { query: z.infer<typeof PlayMcpCandidateToolsQuerySchema> }): Promise<z.infer<typeof PlayMcpCandidateToolsResponseSchema>> {
    // No installed gem → empty, without attempting a (doomed) connect. A connect failure on an
    // installed gem also degrades to empty rather than failing the route (one connector down must
    // not blind the picker).
    if (!resolveConnectorGem(input.query.server)) return { tools: [] };
    try { return { tools: await listConnectorTools(input.query.server) }; }
    catch { return { tools: [] }; }
  }
```

- [ ] **Step 6: Run tests, verify pass**

Run: `npx tsc -b && npx vitest run playMcpCandidates`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/play/src/mcpConnectors.ts packages/play/src/index.ts packages/app/src/schemas.ts packages/app/src/play.controller.ts packages/app/src/__tests__/playMcpCandidates.test.ts
git commit -m "feat(play): mcp candidate + candidate-tools routes for the Studio picker"
```

---

### Task 2: Strip disclosure — render `mcpNeeds` with install state

**Files:**
- Modify: `packages/console/src/panels/Play/CapabilityStrip.tsx` (add `connectors` prop + rows + `ConnectorRow` type)
- Modify: `packages/console/src/panels/Play/Studio.tsx` (fetch `/servers`, derive rows, pass prop)
- Test: `packages/console/src/panels/Play/__tests__/CapabilityStrip.test.tsx`

**Interfaces:**
- Consumes: `playMcpServersRoute` (existing, `routes.ts:1151`) → `{ servers: {server, tools:{name}[], configDigest?}[] }`
- Produces: `export type ConnectorRow = { server: string; tools: string[]; state: "ready" | "unreachable" | "missing" }`

- [ ] **Step 1: Write the failing test**

`packages/console/src/panels/Play/__tests__/CapabilityStrip.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CapabilityStrip } from "../CapabilityStrip.js";

describe("CapabilityStrip connectors", () => {
  it("renders ready / unreachable / missing connector states", () => {
    render(<CapabilityStrip needs={[]} pruned={[]} connectors={[
      { server: "github", tools: ["list_prs", "list_commits"], state: "ready" },
      { server: "linear", tools: [], state: "unreachable" },
      { server: "jira", tools: [], state: "missing" },
    ]} />);
    expect(screen.getByText(/list_prs, list_commits/)).toBeInTheDocument();
    expect(screen.getByText(/couldn.t connect/i)).toBeInTheDocument();
    expect(screen.getByText(/not installed here/i)).toBeInTheDocument();
  });

  it("renders nothing when empty", () => {
    const { container } = render(<CapabilityStrip pruned={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm -C packages/console test -- CapabilityStrip`
Expected: FAIL — `connectors` prop not supported; state text absent.

- [ ] **Step 3: Extend CapabilityStrip**

Replace `packages/console/src/panels/Play/CapabilityStrip.tsx` body:
```tsx
// packages/console/src/panels/Play/CapabilityStrip.tsx
// Disclosure, not control. Renders the RECONCILED built-in `needs` and the declared MCP connectors,
// each labelled with its cost / install state. No toggle on purpose — the code is the single authority.
import { CAP_LABEL } from "./consent.js";

const AUTO_LABEL = "read this miniapp's own source session";

export type ConnectorRow = { server: string; tools: string[]; state: "ready" | "unreachable" | "missing" };

export function CapabilityStrip({ needs, pruned, connectors }: { needs?: string[]; pruned: string[]; connectors?: ConnectorRow[] }) {
  if (!needs?.length && !pruned.length && !connectors?.length) return null;
  return (
    <div className="play-caps">
      {needs?.map((cap) => (
        <div key={cap} className="play-caps__row">
          <code className="play-caps__cap">{cap}</code>
          <span className="play-caps__cost">{CAP_LABEL[cap] ?? AUTO_LABEL}</span>
        </div>
      ))}
      {connectors?.map((c) => (
        <div key={`mcp-${c.server}`} className={`play-caps__row play-caps__mcp${c.state === "missing" ? " play-caps__mcp--missing" : ""}`}>
          <code className="play-caps__cap">{c.server}</code>
          <span className="play-caps__cost">
            {c.state === "missing" ? "⚠ connector not installed here"
              : c.state === "unreachable" ? "couldn’t connect"
              : c.tools.join(", ")}
          </span>
        </div>
      ))}
      {pruned.map((cap) => (
        <div key={`pruned-${cap}`} className="play-caps__row play-caps__row--pruned">
          removed {cap} — nothing in the miniapp uses it
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm -C packages/console test -- CapabilityStrip`
Expected: PASS.

- [ ] **Step 5: Wire Studio to fetch + pass connectors**

`packages/console/src/panels/Play/Studio.tsx`:
1. Import: change the CapabilityStrip import to `import { CapabilityStrip, type ConnectorRow } from "./CapabilityStrip.js";` and ensure `playMcpServersRoute` and `makeClient` are imported from `../../api/routes.js` (add `playMcpServersRoute` if absent).
2. Add state near `pruned` (≈ line 89): `const [connectorRows, setConnectorRows] = useState<ConnectorRow[]>([]);`
3. Add a helper (place above the render, after the save handler):
```tsx
  const refreshConnectors = (mcpNeeds: McpNeed[] | undefined, gameName: string) => {
    if (!mcpNeeds?.length) { setConnectorRows([]); return; }
    playMcpServersRoute.call(makeClient(apiBase), { query: { name: gameName } })
      .then((r) => setConnectorRows(r.servers.map((s): ConnectorRow => ({
        server: s.server,
        tools: s.tools.map((t) => t.name),
        state: s.configDigest ? (s.tools.length ? "ready" : "unreachable") : "missing",
      }))))
      .catch(() => setConnectorRows([]));
  };
```
4. Call it after load — in the `.then((r) => { setHtml(r.html); setMeta(r.meta); setLoadErr(null); })` (line 141), append `refreshConnectors(r.meta.mcpNeeds, name);`.
5. Call it after save — after `setMeta({...})` (line 435), append `refreshConnectors(cur.meta.mcpNeeds, name);`.
6. Update the render (line 657): `<CapabilityStrip needs={meta?.needs} pruned={pruned} connectors={connectorRows} />`

- [ ] **Step 6: Typecheck + full console suite**

Run: `pnpm -C packages/console test` and `npx tsc -b`
Expected: PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add packages/console/src/panels/Play/CapabilityStrip.tsx packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/__tests__/CapabilityStrip.test.tsx
git commit -m "feat(console): disclose mcpNeeds with install state in the CapabilityStrip"
```

---

### Task 3: Composer picker — candidates, lazy tools, intent preamble, a11y

**Files:**
- Modify: `packages/console/src/api/routes.ts` (2 route clients)
- Modify: `packages/console/src/panels/Play/Composer.tsx` (picker fieldset, state, lazy tools, preamble)
- Test: `packages/console/src/panels/Play/__tests__/Composer.connectors.test.tsx`

**Interfaces:**
- Consumes: `listConnectorCandidates` routes from Task 1.
- Produces: `connectorPreamble(servers: string[]): string`; a `play-connectors-pick` fieldset.

- [ ] **Step 1: Add route clients**

`packages/console/src/api/routes.ts`, after `playMcpServersRoute` (≈ line 1164):
```ts
export const playMcpCandidatesRoute = defineRoute("GET", "/api/play/mcp/candidates", {
  response: z.object({
    servers: z.array(z.object({
      server: z.string(),
      transport: z.enum(["stdio", "http", "sse"]),
      needsSecret: z.boolean(),
    })),
  }),
});
export const playMcpCandidateToolsRoute = defineRoute("GET", "/api/play/mcp/candidate-tools", {
  query: z.object({ server: z.string() }),
  response: z.object({ tools: z.array(z.object({ name: z.string(), description: z.string().optional() })) }),
});
```

- [ ] **Step 2: Write the failing test**

`packages/console/src/panels/Play/__tests__/Composer.connectors.test.tsx`:
```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: { candidates: () => Promise<unknown>; tools: (q: unknown) => Promise<unknown> } = {
  candidates: async () => ({ servers: [{ server: "github", transport: "stdio", needsSecret: false }] }),
  tools: async () => ({ tools: [{ name: "list_prs" }] }),
};
vi.mock("../../../api/routes.js", () => ({
  makeClient: () => ({}),
  playMcpCandidatesRoute: { call: () => calls.candidates() },
  playMcpCandidateToolsRoute: { call: (_c: unknown, a: unknown) => calls.tools(a) },
  playStudioRoute: { call: async () => ({ name: "g1" }) },
  playImportRoute: { call: async () => ({ name: "g1" }) },
  playBlankRoute: { call: async () => ({ name: "g1" }) },
  testbedProjectsRoute: { call: async () => ({ projects: [] }) },
  inventoryRoute: { call: async () => ({ skills: [] }) },
}));
vi.mock("../AgentSelector.js", () => ({ AgentSelector: () => null }));
vi.mock("../Watch/watchStream.js", () => ({ fetchSessions: async () => [] }));

import { Composer } from "../Composer.js";

const onCreated = vi.fn();
beforeEach(() => onCreated.mockReset());
const renderComposer = () =>
  render(<Composer apiBase="" agents={[]} agentId="" onAgentIdChange={() => {}} onCreated={onCreated} />);

describe("Composer connector picker", () => {
  it("lists candidates and lazily loads tools on expand with aria-expanded", async () => {
    renderComposer();
    await screen.findByText("github");
    const toggle = screen.getByRole("button", { name: /github/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.getByText(/list_prs/)).toBeInTheDocument());
  });

  it("passes a connector preamble to onCreated when a server is checked and a source seeded", async () => {
    renderComposer();
    await screen.findByText("github");
    fireEvent.click(screen.getByLabelText("github"));            // checkbox label = server name
    // Blank tab is the simplest seed path
    fireEvent.click(screen.getByRole("button", { name: "Blank" }));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /Create miniapp/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(String(onCreated.mock.calls[0][1])).toMatch(/mcpNeeds[\s\S]*- github/);
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `pnpm -C packages/console test -- Composer.connectors`
Expected: FAIL — no picker, `connectorPreamble` absent.

- [ ] **Step 4: Implement the picker**

`packages/console/src/panels/Play/Composer.tsx`:
1. Extend the routes import (line 3) to add `playMcpCandidatesRoute, playMcpCandidateToolsRoute`.
2. Add `connectorPreamble` beside `capPreamble` (after line 42):
```tsx
type Candidate = { server: string; transport: string; needsSecret: boolean };
type ToolState = { name: string }[] | "loading" | "error";

function connectorPreamble(servers: string[]): string {
  if (!servers.length) return "";
  return [
    "This miniapp should use these MCP connectors — for each, call its tools via",
    '`window.agentgemApp.mcp.callTool(server, tool)` and add the server to `"mcpNeeds"` in meta.json:',
    ...servers.map((s) => `- ${s}`),
  ].join("\n");
}
```
3. Add state after `caps`/`toggleCap` (line 84):
```tsx
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [connectors, setConnectors] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toolsByServer, setToolsByServer] = useState<Record<string, ToolState>>({});
  const toggleConnector = (s: string) => setConnectors((cs) => (cs.includes(s) ? cs.filter((x) => x !== s) : [...cs, s]));
  function toggleExpand(c: Candidate, force = false) {
    const open = expanded === c.server;
    setExpanded(open ? null : c.server);
    if (open || (c.needsSecret && !force) || toolsByServer[c.server]) return;   // closing / secret-gated / cached
    setToolsByServer((m) => ({ ...m, [c.server]: "loading" }));
    playMcpCandidateToolsRoute.call(makeClient(apiBase), { query: { server: c.server } })
      .then((r) => setToolsByServer((m) => ({ ...m, [c.server]: r.tools })))
      .catch(() => setToolsByServer((m) => ({ ...m, [c.server]: "error" })));
  }
```
4. Fetch candidates on mount — add a second `useEffect` after the existing one (line 95):
```tsx
  useEffect(() => {
    playMcpCandidatesRoute.call(makeClient(apiBase)).then((r) => setCandidates(r.servers)).catch(() => setCandidates([]));
  }, [apiBase]);
```
5. Fold `connectorPreamble` into `seed()` (line 105) and `doBlank()` (line 142):
   - `seed`: replace `const preamble = capPreamble(caps);` with
     `const preamble = [capPreamble(caps), connectorPreamble(connectors)].filter(Boolean).join("\n\n");`
   - `doBlank`: change the array to `[capPreamble(caps), connectorPreamble(connectors), up.preamble(), blankPrompt.trim()]`.
6. Add the fieldset right after the caps fieldset (after line 163):
```tsx
      <fieldset className="play-connectors-pick">
        <legend>MCP connectors (from your agent setup):</legend>
        {candidates == null ? null : candidates.length === 0 ? (
          <div className="play-connectors-pick__empty">
            No MCP servers found in your agent setup. Add one to <code>~/.claude/.mcp.json</code> and it’ll appear here.
          </div>
        ) : candidates.map((c) => {
          const open = expanded === c.server;
          const tools = toolsByServer[c.server];
          return (
            <div key={c.server} className="play-connectors-pick__item">
              <div className="play-connectors-pick__row">
                <label className="play-connectors-pick__pick">
                  <input type="checkbox" checked={connectors.includes(c.server)} onChange={() => toggleConnector(c.server)} />
                  <span>{c.server}</span>
                </label>
                <button type="button" className="play-connectors-pick__toggle" aria-expanded={open}
                  aria-controls={`mcp-tools-${c.server}`} onClick={() => toggleExpand(c)}>
                  <span className="play-connectors-pick__meta">{c.transport}{c.needsSecret ? " · needs secret" : ""}</span>
                  <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                </button>
              </div>
              {open && (
                <div id={`mcp-tools-${c.server}`} className="play-connectors-pick__tools">
                  {c.needsSecret && !toolsByServer[c.server] ? (
                    <span>Needs secret — set it in your env, then reload. <button type="button" className="play-linkbtn" onClick={() => toggleExpand(c, true)}>Try anyway</button></span>
                  ) : tools === "loading" ? <span>Connecting…</span>
                    : tools === "error" ? <span>Couldn’t connect to {c.server}.</span>
                    : tools == null ? null
                    : tools.length === 0 ? <span>This server exposes no tools.</span>
                    : <span>{tools.map((t) => t.name).join(", ")}</span>}
                </div>
              )}
            </div>
          );
        })}
      </fieldset>
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm -C packages/console test -- Composer.connectors`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Play/Composer.tsx packages/console/src/panels/Play/__tests__/Composer.connectors.test.tsx
git commit -m "feat(console): MCP connector candidate picker in the Composer (intent-only)"
```

---

### Task 4: CSS — style the picker + strip connector rows

**Files:**
- Modify: `packages/console/src/shell/theme.css`

**Interfaces:** consumes the classNames emitted in Tasks 2-3.

- [ ] **Step 1: Add rules next to their siblings**

`packages/console/src/shell/theme.css`, after the `.play-caps__row--pruned` rule (≈ line 626):
```css
.play-caps__mcp .play-caps__cap { color: var(--brand); }
.play-caps__mcp--missing .play-caps__cost { color: var(--warn, #b8860b); opacity: 0.9; }
```
After the `.play-caps-pick__row` rule (≈ line 2488):
```css
.play-connectors-pick { border: 0; padding: 0; margin: 10px 0; }
.play-connectors-pick legend { font-size: 12px; opacity: 0.7; padding: 0; }
.play-connectors-pick__empty { font-size: 12px; opacity: 0.7; margin-top: 4px; }
.play-connectors-pick__item { border-top: 1px solid var(--hairline, rgba(0,0,0,0.08)); }
.play-connectors-pick__row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; padding: 4px 0; }
.play-connectors-pick__pick { display: flex; align-items: center; gap: 8px; }
.play-connectors-pick__toggle { display: flex; align-items: center; gap: 6px; background: none; border: 0; cursor: pointer; font: inherit; color: inherit; opacity: 0.7; }
.play-connectors-pick__meta { font-size: 12px; opacity: 0.75; }
.play-connectors-pick__tools { font-size: 12px; opacity: 0.8; padding: 0 0 6px 24px; font-family: var(--font-mono); }
```

- [ ] **Step 2: Verify every new class has a rule**

Run:
```bash
for c in play-caps__mcp play-caps__mcp--missing play-connectors-pick play-connectors-pick__empty play-connectors-pick__item play-connectors-pick__row play-connectors-pick__pick play-connectors-pick__toggle play-connectors-pick__meta play-connectors-pick__tools; do
  printf '%s: ' "$c"; grep -c "\.$c" packages/console/src/shell/theme.css
done
```
Expected: each count ≥ 1.

- [ ] **Step 3: Commit**

```bash
git add packages/console/src/shell/theme.css
git commit -m "style(console): connector picker + strip connector-row styles"
```

---

## Final verification

- [ ] Root build + full app/play suite: `npx tsc -b && npx vitest run` (green)
- [ ] Console suite: `pnpm -C packages/console test` (green)
- [ ] Manual: launch console, open Play → Composer shows installed connectors; expand loads tools; check one → build prompt carries the connector; after a connector-using miniapp saves, the strip shows the connector + tools (or the not-installed warning).
- [ ] Open a PR per CLAUDE.md (branch already off `origin/main`); let `test (24)` gate it.
