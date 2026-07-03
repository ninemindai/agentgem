# Curated Browse Surface (Sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let visitors browse curated personas on `app.agentgem.ai`, read the full `SKILL.md`, and copy a command to install locally — plus the `agentgem sources install` CLI that command invokes.

**Architecture:** The marketplace (`packages/marketplace`, a Vite/React SPA) gains a read-only `/sources` page that calls the already-public `/api/sources/*` endpoints. Installing is a *local* action, so the page shows a copy-able `agentgem sources install <sourceId> <path>` command; a new CLI subcommand runs it by reusing the same install core as the server's `/api/sources/install`.

**Tech Stack:** TypeScript, React 18, Vite, Vitest + @testing-library/react (marketplace); Node ESM, Vitest (server/CLI). Adapter functions from `@agentgem/distribute`.

## Global Constraints

- Read-only on the web: the marketplace never writes to disk. The only state-changing path is the local CLI.
- Install command shape (verbatim, used by both web copy button and CLI): `agentgem sources install <sourceId> <path>` — two args, e.g. `agentgem sources install agency-agents engineering/ai-engineer.md`.
- Reuse `@agentgem/distribute` adapter functions (`curatedSourceById`, `cfgForCuratedSource`, `importAgencyAgentSkill`); do NOT reimplement persona fetching.
- Path safety: an agent path must match `^[a-z0-9-]+\/[A-Za-z0-9._-]+\.md$` and contain no `..`; a skill name must match `^[a-z0-9][a-z0-9-]*$`. Copy these regexes verbatim from `src/sources.controller.ts`.
- Marketplace has no zod; its `api.ts` uses plain `fetch` + `JSON.parse`. Follow that pattern, don't introduce zod there.
- Root tests run from compiled `dist/` (`dist/**/__tests__/**/*.test.js`); marketplace tests run in-place via its own vitest. Build before running root tests.
- Git identity: commits authored by Raymond Feng <raymond@ninemind.ai>.

---

## File Structure

- `packages/marketplace/src/types.ts` (modify) — add `CuratedSource`, `SourceDivision`, `SourceAgentRef`, `ImportedSkill`.
- `packages/marketplace/src/api.ts` (modify) — add a `post<T>` helper + 4 source methods.
- `packages/marketplace/src/api.test.ts` (modify) — cover the new methods.
- `packages/marketplace/src/pages/Sources.tsx` (create) — the browse page.
- `packages/marketplace/src/pages/Sources.test.tsx` (create) — page test.
- `packages/marketplace/src/Router.tsx` (modify) — add `/sources` route.
- `packages/marketplace/src/App.tsx` (modify) — add a "Sources" nav link.
- `src/sourcesCore.ts` (create) — `installAgencySkill()` shared by controller + CLI.
- `src/__tests__/sourcesCore.test.ts` (create) — install writes / dry-run / validation.
- `src/sources.controller.ts` (modify) — `install()` delegates to `installAgencySkill`.
- `src/sourcesCli.ts` (create) — `runSourcesCommand()`.
- `src/__tests__/sourcesCli.test.ts` (create) — CLI happy path + usage error.
- `src/cli.ts` (modify) — dispatch `sources` + HELP line.

Four tasks: A1 (api client), A2 (page + routing), A3 (install core + controller refactor), A4 (CLI). A1→A2 are marketplace; A3→A4 are server/CLI; A3 before A4 (A4 depends on the core).

---

### Task A1: Marketplace source API client

**Files:**
- Modify: `packages/marketplace/src/types.ts`
- Modify: `packages/marketplace/src/api.ts`
- Test: `packages/marketplace/src/api.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `makeApi(base)` gains `getSources()`, `getSourceDivisions(source)`, `getSourceAgents(source, division)`, `importSourceSkill(source, path)`. Types `CuratedSource`, `SourceDivision`, `SourceAgentRef`, `ImportedSkill` from `types.ts`.

- [ ] **Step 1: Add the types**

In `packages/marketplace/src/types.ts`, append:

```ts
export interface CuratedSource {
  id: string; label: string; description: string;
  repo: string; ref: string; kind: string;
  license?: string; homepage?: string;
}
export interface SourceDivision { key: string; label: string; icon?: string; color?: string }
export interface SourceAgentRef { division: string; slug: string; name: string; path: string }
export interface ImportedSkill { name: string; description?: string; content: string; source?: string }
```

- [ ] **Step 2: Write the failing test**

In `packages/marketplace/src/api.test.ts`, add (match the file's existing `vi.stubGlobal("fetch", …)` style; if the file has none, add the imports shown):

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeApi } from "./api";

afterEach(() => vi.restoreAllMocks());
const res = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as unknown as Response;

describe("makeApi sources", () => {
  it("getSources unwraps {sources}", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ sources: [{ id: "agency-agents", label: "The Agency", description: "d", repo: "o/r", ref: "main", kind: "agency-layout" }] })));
    const out = await makeApi("").getSources();
    expect(out[0].id).toBe("agency-agents");
  });

  it("importSourceSkill POSTs body and returns content", async () => {
    const spy = vi.fn(async () => res({ name: "ai-engineer", content: "SKILL_BODY" }));
    vi.stubGlobal("fetch", spy);
    const out = await makeApi("").importSourceSkill("agency-agents", "engineering/ai-engineer.md");
    expect(out.content).toBe("SKILL_BODY");
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ source: "agency-agents", path: "engineering/ai-engineer.md" });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/marketplace && pnpm exec vitest run src/api.test.ts`
Expected: FAIL — `getSources`/`importSourceSkill` are not functions.

- [ ] **Step 4: Implement the client methods**

In `packages/marketplace/src/api.ts`: extend the type import on line 1 to include the new types, add a `post` helper after `get`, and add the four methods inside the `makeApi` return object.

```ts
// line 1 — add the new types to the existing import:
import type { AggIngredient, AggCoOccurrence, AdoptionPoint, RegistryGem, Profile,
  CuratedSource, SourceDivision, SourceAgentRef, ImportedSkill } from "./types";
```

```ts
// after the get<T> function:
async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return JSON.parse(await res.text()) as T;
}
```

```ts
// inside makeApi's returned object, add:
    getSources: () =>
      get<{ sources: CuratedSource[] }>(base, "/api/sources").then((r) => r.sources),
    getSourceDivisions: (source: string) =>
      get<{ divisions: SourceDivision[] }>(base, "/api/sources/divisions", { source }).then((r) => r.divisions),
    getSourceAgents: (source: string, division: string) =>
      get<{ agents: SourceAgentRef[] }>(base, "/api/sources/agents", { source, division }).then((r) => r.agents),
    importSourceSkill: (source: string, path: string) =>
      post<ImportedSkill>(base, "/api/sources/import", { source, path }),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/marketplace && pnpm exec vitest run src/api.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/marketplace/src/types.ts packages/marketplace/src/api.ts packages/marketplace/src/api.test.ts
git commit -m "feat(marketplace): source-browse API client methods"
```

---

### Task A2: Marketplace `/sources` page + routing

**Files:**
- Create: `packages/marketplace/src/pages/Sources.tsx`
- Test: `packages/marketplace/src/pages/Sources.test.tsx`
- Modify: `packages/marketplace/src/Router.tsx`
- Modify: `packages/marketplace/src/App.tsx`

**Interfaces:**
- Consumes: `makeApi(base)` sources methods from A1.
- Produces: `Sources` component (default-styled), route `/sources`, nav link.

- [ ] **Step 1: Write the failing test**

Create `packages/marketplace/src/pages/Sources.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Sources } from "./Sources";
import { makeApi } from "../api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const res = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as unknown as Response;

const stub = () => vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
  const u = String(url);
  if (u.includes("/api/sources/divisions")) return res({ divisions: [{ key: "engineering", label: "Engineering" }] });
  if (u.includes("/api/sources/agents")) return res({ agents: [{ division: "engineering", slug: "ai-engineer", name: "ai-engineer", path: "engineering/ai-engineer.md" }] });
  if (u.includes("/api/sources/import")) return res({ name: "ai-engineer", content: "HELLO_SKILL_BODY" });
  if (u.includes("/api/sources")) return res({ sources: [{ id: "agency-agents", label: "The Agency", description: "d", repo: "o/agency-agents", ref: "main", kind: "agency-layout", license: "MIT", homepage: "https://github.com/o/agency-agents" }] });
  throw new Error(`unexpected: ${u}`);
}));

describe("Sources page", () => {
  it("shows the install command and the full SKILL.md on View skill", async () => {
    stub();
    render(<Sources api={makeApi("")} />);
    fireEvent.click(await screen.findByText("Engineering"));
    // the copy-able install command is present
    expect(await screen.findByText(/agentgem sources install agency-agents engineering\/ai-engineer\.md/)).toBeTruthy();
    // View skill loads the full body
    fireEvent.click(screen.getByText("View skill"));
    await waitFor(() => expect(screen.getByText(/HELLO_SKILL_BODY/)).toBeTruthy());
    expect(screen.getByText("Hide skill")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/marketplace && pnpm exec vitest run src/pages/Sources.test.tsx`
Expected: FAIL — cannot find `./Sources`.

- [ ] **Step 3: Create the page**

Create `packages/marketplace/src/pages/Sources.tsx`:

```tsx
import { useEffect, useState } from "react";
import type { makeApi } from "../api";
import type { CuratedSource, SourceDivision, SourceAgentRef } from "../types";

export function Sources({ api }: { api: ReturnType<typeof makeApi> }) {
  const [sources, setSources] = useState<CuratedSource[] | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [divisions, setDivisions] = useState<SourceDivision[] | null>(null);
  const [division, setDivision] = useState("");
  const [agents, setAgents] = useState<SourceAgentRef[] | null>(null);
  const [skill, setSkill] = useState<{ path: string; content: string } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getSources().then((s) => { setSources(s); setSourceId((id) => id || s[0]?.id || ""); }).catch((e) => setError(String(e)));
  }, [api]);

  useEffect(() => {
    if (!sourceId) return;
    setDivisions(null); setDivision(""); setAgents(null); setSkill(null);
    api.getSourceDivisions(sourceId).then(setDivisions).catch((e) => setError(String(e)));
  }, [api, sourceId]);

  useEffect(() => {
    if (!sourceId || !division) return;
    setAgents(null); setSkill(null);
    api.getSourceAgents(sourceId, division).then(setAgents).catch((e) => setError(String(e)));
  }, [api, sourceId, division]);

  const viewSkill = async (a: SourceAgentRef) => {
    if (skill?.path === a.path) { setSkill(null); return; }
    setError(null); setLoading(a.path);
    try {
      const art = await api.importSourceSkill(sourceId, a.path);
      setSkill({ path: a.path, content: art.content });
    } catch (e) { setError(String(e)); } finally { setLoading(null); }
  };

  const source = sources?.find((s) => s.id === sourceId);
  if (!sources && !error) return <p className="ex-empty">Loading…</p>;

  return (
    <div className="ex-sources">
      {source && (
        <p className="ex-source-head">
          {source.description}
          {source.license && <span className="ex-chip"> {source.license}</span>}
          {source.homepage && <> · <a href={source.homepage} target="_blank" rel="noreferrer">{source.repo}</a></>}
        </p>
      )}
      {error && <p className="ex-error">{error}</p>}
      {divisions && (
        <div className="ex-divisions">
          {divisions.map((d) => (
            <button type="button" key={d.key} className={"ex-chip" + (division === d.key ? " is-active" : "")} onClick={() => setDivision(d.key)}>{d.label}</button>
          ))}
        </div>
      )}
      {agents && (
        <ul className="ex-agent-list">
          {agents.map((a) => (
            <li className="ex-agent" key={a.path}>
              <div className="ex-agent-head">
                <span className="ex-agent-name">{a.name}</span>
                <button type="button" className="ex-btn" disabled={loading === a.path} onClick={() => void viewSkill(a)}>
                  {loading === a.path ? "Loading…" : skill?.path === a.path ? "Hide skill" : "View skill"}
                </button>
              </div>
              <code className="ex-install-cmd">agentgem sources install {sourceId} {a.path}</code>
              {skill?.path === a.path && (
                <pre className="ex-skill-body" aria-label={`${a.name} SKILL.md`}>{skill.content}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the route**

In `packages/marketplace/src/Router.tsx`: import the page and add the route.

```tsx
import { Sources } from "./pages/Sources";
```

```tsx
// add before the `/gems` handling:
  if (path === "/sources") return <Sources api={api} />;
```

- [ ] **Step 5: Add the nav link**

In `packages/marketplace/src/App.tsx`, add inside `<nav className="ex-nav">` after the Gems link:

```tsx
          <a href="/sources" className={"ex-navlink" + (path.startsWith("/sources") ? " is-active" : "")}>Sources</a>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/marketplace && pnpm exec vitest run src/pages/Sources.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck + full marketplace suite**

Run: `cd packages/marketplace && pnpm exec tsc -p tsconfig.json --noEmit && pnpm exec vitest run`
Expected: no type errors; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/marketplace/src/pages/Sources.tsx packages/marketplace/src/pages/Sources.test.tsx packages/marketplace/src/Router.tsx packages/marketplace/src/App.tsx
git commit -m "feat(marketplace): read-only /sources browse page with install command"
```

---

### Task A3: Shared install core + controller refactor

**Files:**
- Create: `src/sourcesCore.ts`
- Test: `src/__tests__/sourcesCore.test.ts`
- Modify: `src/sources.controller.ts`

**Interfaces:**
- Consumes: `@agentgem/distribute` (`curatedSourceById`, `cfgForCuratedSource`, `importAgencyAgentSkill`), `@agentgem/model` (`InvalidInputError`).
- Produces: `installAgencySkill(sourceId: string, path: string, opts?: { dryRun?: boolean; home?: string }): Promise<{ ok: boolean; skill: string; dir: string; content: string }>`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sourcesCore.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@agentgem/distribute", () => ({
  curatedSourceById: (id: string) => (id === "agency-agents" ? { id, kind: "agency-layout" } : undefined),
  cfgForCuratedSource: () => ({}),
  importAgencyAgentSkill: async () => ({ type: "skill", name: "ai-engineer", source: "agency-agents", content: "SKILL_BODY" }),
}));

import { installAgencySkill } from "../sourcesCore.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "agsrc-")); });

describe("installAgencySkill", () => {
  it("writes SKILL.md under <home>/.agents/skills/<name>", async () => {
    const r = await installAgencySkill("agency-agents", "engineering/ai-engineer.md", { home });
    expect(r.skill).toBe("ai-engineer");
    expect(readFileSync(join(home, ".agents", "skills", "ai-engineer", "SKILL.md"), "utf8")).toBe("SKILL_BODY");
    expect(r.ok).toBe(true);
  });
  it("dry-run returns content without writing", async () => {
    const r = await installAgencySkill("agency-agents", "engineering/ai-engineer.md", { home, dryRun: true });
    expect(r.content).toBe("SKILL_BODY");
    expect(existsSync(join(home, ".agents", "skills", "ai-engineer"))).toBe(false);
  });
  it("rejects an unknown source", async () => {
    await expect(installAgencySkill("nope", "engineering/ai-engineer.md", { home })).rejects.toThrow(/Unknown curated source/);
  });
  it("rejects a traversal path", async () => {
    await expect(installAgencySkill("agency-agents", "../etc/passwd.md", { home })).rejects.toThrow(/Invalid agent path/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm exec vitest run dist/__tests__/sourcesCore.test.js`
Expected: FAIL — cannot find `../sourcesCore.js`.

- [ ] **Step 3: Implement the core**

Create `src/sourcesCore.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Shared "install a curated persona as a local skill" core, used by both the
// /api/sources/install route and the `agentgem sources install` CLI so the two
// can't drift. Writes ~/.agents/skills/<name>/SKILL.md (the dir introspect reads).
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { curatedSourceById, cfgForCuratedSource, importAgencyAgentSkill } from "@agentgem/distribute";
import { InvalidInputError } from "@agentgem/model";

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const AGENCY_PATH_RE = /^[a-z0-9-]+\/[A-Za-z0-9._-]+\.md$/;

export interface InstallAgencyResult { ok: boolean; skill: string; dir: string; content: string }

export async function installAgencySkill(
  sourceId: string,
  path: string,
  opts: { dryRun?: boolean; home?: string } = {},
): Promise<InstallAgencyResult> {
  const source = curatedSourceById(sourceId);
  if (!source) throw new InvalidInputError(`Unknown curated source '${sourceId}'.`);
  if (path.includes("..") || !AGENCY_PATH_RE.test(path)) throw new InvalidInputError(`Invalid agent path '${path}'.`);
  const skill = await importAgencyAgentSkill(path, cfgForCuratedSource(source));
  if (!SKILL_NAME_RE.test(skill.name)) throw new InvalidInputError(`Unsafe skill name '${skill.name}'.`);
  const dir = join(opts.home ?? homedir(), ".agents", "skills", skill.name);
  if (!opts.dryRun) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), skill.content, "utf8");
  }
  return { ok: !opts.dryRun, skill: skill.name, dir, content: skill.content };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm exec vitest run dist/__tests__/sourcesCore.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor the controller to use the core**

In `src/sources.controller.ts`, replace the body of `install()` (lines ~108-117) so it delegates, and add the import. Remove the now-unused `homedir`/`join`/`mkdir`/`writeFile`/`SKILL_NAME_RE` **only if** no other method uses them (they aren't used elsewhere — remove them).

```ts
// add to imports:
import { installAgencySkill } from "./sourcesCore.js";
```

```ts
  @post("/install", { body: ImportBody, response: InstallResult })
  async install(input: { body: z.infer<typeof ImportBody> }): Promise<z.infer<typeof InstallResult>> {
    const { ok, skill, dir } = await installAgencySkill(input.body.source, input.body.path);
    return { ok, skill, dir };
  }
```

Delete the now-unused top-of-file imports `homedir`, `join`, `mkdir`, `writeFile`, and the `SKILL_NAME_RE` constant (the `install` handler was their only consumer; `sourceOrThrow`/`agencyPathOrThrow` remain for the other handlers).

- [ ] **Step 6: Verify controller tests still pass**

Run: `pnpm build && pnpm exec vitest run dist/__tests__/sources.controller.test.js`
Expected: PASS (existing install test still green — behavior unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/sourcesCore.ts src/__tests__/sourcesCore.test.ts src/sources.controller.ts
git commit -m "refactor(sources): extract installAgencySkill core, shared by controller + CLI"
```

---

### Task A4: `agentgem sources install` CLI

**Files:**
- Create: `src/sourcesCli.ts`
- Test: `src/__tests__/sourcesCli.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `installAgencySkill` from A3.
- Produces: `runSourcesCommand(argv: string[]): Promise<number>` (exit code).

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/sourcesCli.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const install = vi.fn(async (_s: string, _p: string, opts: { dryRun?: boolean } = {}) =>
  ({ ok: !opts.dryRun, skill: "ai-engineer", dir: "/home/u/.agents/skills/ai-engineer", content: "BODY" }));
vi.mock("../sourcesCore.js", () => ({ installAgencySkill: install }));

import { runSourcesCommand } from "../sourcesCli.js";

beforeEach(() => install.mockClear());

describe("runSourcesCommand", () => {
  it("install calls the core with sourceId + path and returns 0", async () => {
    const code = await runSourcesCommand(["install", "agency-agents", "engineering/ai-engineer.md"]);
    expect(code).toBe(0);
    expect(install).toHaveBeenCalledWith("agency-agents", "engineering/ai-engineer.md", { dryRun: false });
  });
  it("passes dryRun through", async () => {
    await runSourcesCommand(["install", "agency-agents", "engineering/ai-engineer.md", "--dry-run"]);
    expect(install).toHaveBeenCalledWith("agency-agents", "engineering/ai-engineer.md", { dryRun: true });
  });
  it("missing args returns 1 and does not call the core", async () => {
    const code = await runSourcesCommand(["install"]);
    expect(code).toBe(1);
    expect(install).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm exec vitest run dist/__tests__/sourcesCli.test.js`
Expected: FAIL — cannot find `../sourcesCli.js`.

- [ ] **Step 3: Implement the CLI command**

Create `src/sourcesCli.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// `agentgem sources install <sourceId> <path>` — install a curated persona as a
// local skill (the command the marketplace /sources page tells visitors to copy).
import { installAgencySkill } from "./sourcesCore.js";

const USAGE = "usage: agentgem sources install <sourceId> <path>\n  e.g. agentgem sources install agency-agents engineering/ai-engineer.md\n  flags: --dry-run  (print the SKILL.md without writing)";

export async function runSourcesCommand(argv: string[]): Promise<number> {
  const [sub, sourceId, path] = argv;
  if (sub !== "install" || !sourceId || !path) {
    console.error(USAGE);
    return 1;
  }
  const dryRun = argv.includes("--dry-run");
  try {
    const r = await installAgencySkill(sourceId, path, { dryRun });
    if (dryRun) {
      console.log(r.content);
      console.error(`(dry-run) would install '${r.skill}' -> ${r.dir}/SKILL.md`);
    } else {
      console.log(`installed '${r.skill}' -> ${r.dir}/SKILL.md`);
    }
    return 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm exec vitest run dist/__tests__/sourcesCli.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the dispatch + help in `src/cli.ts`**

Add the dispatch block after the `learn` block (after line ~96):

```ts
  // `agentgem sources install <sourceId> <path>` — install a curated persona as a local skill.
  if (argv[0] === "sources") {
    const { runSourcesCommand } = await import("./sourcesCli.js");
    process.exitCode = await runSourcesCommand(argv.slice(1));
    return;
  }
```

Add this line to the `HELP` string, after the `learn` line:

```
  agentgem sources install <src> <path>  Install a curated persona as a local skill (--dry-run)
```

- [ ] **Step 6: Build + run the CLI test and the full server suite**

Run: `pnpm build && pnpm exec vitest run dist/__tests__/sourcesCli.test.js dist/__tests__/sourcesCore.test.js`
Expected: PASS.

- [ ] **Step 7: Manual smoke (real network — optional but recommended)**

Run: `node dist/cli.js sources install agency-agents engineering/ai-engineer.md --dry-run`
Expected: prints the persona's `SKILL.md` to stdout and a `(dry-run) would install …` note to stderr; writes nothing.

- [ ] **Step 8: Commit**

```bash
git add src/sourcesCli.ts src/__tests__/sourcesCli.test.ts src/cli.ts
git commit -m "feat(cli): agentgem sources install <sourceId> <path>"
```

---

## Self-Review

**Spec coverage (Sub-project A):**
- A1 §"Browse surface" data bindings → Task A1. ✓
- A1 marketplace `/sources` page (view skill + attribution + copy command) → Task A2. ✓
- A2 `agentgem sources install` CLI reusing the install core → Tasks A3 (core) + A4 (CLI). ✓
- A3 testing (page fetch-stub test, CLI test) → A2 Step 1, A4 Step 1, A3 Step 1. ✓
- Sub-project B (seed script) is intentionally a separate plan — not covered here.

**Placeholder scan:** No TBD/TODO; every code step has complete code. The install-command string is identical in A2 (`agentgem sources install {sourceId} {a.path}`) and A4 (usage + dispatch).

**Type consistency:** `installAgencySkill(sourceId, path, opts)` signature identical across A3 (definition), A3 Step 5 (controller call — 2-arg form, opts defaulted), and A4 (CLI call + test mock). `ImportedSkill.content` used by A1 method and A2 `viewSkill`. `SourceAgentRef.path` used consistently.
