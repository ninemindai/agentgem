# Usage in the Import view — global, cross-project (Spec A)

Date: 2026-06-27
Status: Approved (design)
Builds on: `2026-06-27-ledger-usage-sort-filter-design.md` (the main ledger usage feature, merged at `0a48383`)
Fast-follow (separate spec, NOT this one): Codex multi-flavor usage scanning. See "Out of scope" + "Sequencing".

## Problem

The main Lapidary Ledger pane (`#inventory`) shows per-artifact usage (badges, Uses/Last-used
sort, "Used only" filter) for the active testbed's **project** artifacts. The **Import view**
(`#importModal` / `#importInventory`, built by `openImport()` in `src/public/index.html`) lists
**global/plugin** artifacts available to import into a testbed — and shows **no usage at all**.
That's where the heavily-used global skills/MCP servers live, so it's the natural place to surface
usage for discovery ("which of my installed globals do I actually use?").

We want Import-view **parity** with the ledger: usage badges, the two sort toggles, and the
"Used only" filter (default on) — but with usage counted **across all projects** (a global skill's
true overall usage), not just one testbed's sessions.

## Decisions (locked)

1. **Parity = badges + Uses/Last-used sort + "Used only" filter.** Not the ledger's full
   search/source/agent/type stack (the Import view has none of those today and we're not adding them).
2. **"Used only" defaults ON** in Import, matching the ledger.
3. **Global usage is cross-project**: aggregated over ALL Claude session transcripts, not one project's.
4. **One endpoint, two modes**: extend `GET /api/usage` with a `scope=global` flag rather than adding
   a second endpoint.
5. **Cache the global scan** up front (it reads every transcript, so opening Import must stay fast).
6. **Source = Claude transcripts only, for now.** Codex scanning is a separate fast-follow spec;
   `agents`/`hermes` are not scannable (no tool-call transcripts on disk). See "Out of scope".

## Background (verified on `main` @ 0a48383)

- `GET /api/usage` (`src/gem.controller.ts:95`) today: takes `projects` (a single root via
  `parseProjectsQuery(...)[0]`), scans THAT project's transcripts
  (`claudeTranscriptsForCwd(dirs.claudeDir, root)`), runs `scanWorkflow(paths, { project, global })`,
  returns `ArtifactUsage[]` projected to `{type,name,root,invocations,sessionsUsedIn,lastUsedMs}`.
  Best-effort: `catch → { artifacts: [] }`.
- `scanWorkflow` (`src/gem/workflowScan.ts:262`) attributes a tool call to a **project** artifact
  before a **global** one; globals get `root: null`. Reads Claude JSONL lines
  (`message.role === "assistant"` → `content[].type === "tool_use"`).
- `claudeTranscriptsForCwd(claudeDir, cwd)` (workflowScan.ts:72) enumerates
  `~/.claude/projects/*/*.jsonl` and keeps those whose parsed `cwd` equals `cwd`.
- The ledger client (`decorateUsage`/`sortRows`/`filterRows`, index.html) stamps
  `data-invocations`/`data-lastused`/`data-passive`/`data-order` and joins on
  `${type}|${name}|${activeTestbed}`. `KIND_TO_USAGE_TYPE` maps `projectSkills→skill` etc.
- The Import view rows are SIMPLER than ledger rows:
  `<label class="row"><input data-ikind="skills|mcpServers|hooks|instructions" data-name="..."><span>…</span></label>`
  — note `data-ikind` (not `data-kind`), and NO `data-source`/`data-agent`/`data-type`/`data-project`,
  no "view" button. The Import modal has NO search/sort/filter controls.

## Design

### Part 1 — Backend: `GET /api/usage?scope=global`

Add a `scope` flag to the usage query and a global branch to the `usage()` method.

**Query schema** (`src/schemas.ts`) — a usage-specific schema so the shared `DirQuerySchema`
(used by `/inventory` too) is untouched:

```ts
export const UsageQuerySchema = z.object({
  dir: z.string().optional(),
  projects: z.string().optional(),
  scope: z.enum(["global"]).optional(),   // absent/omitted = existing per-project behavior
});
```

Point the `usage()` decorator at `UsageQuerySchema`.

**New helper** (`src/gem/workflowScan.ts`) — enumerate ALL Claude transcripts (no cwd filter):

```ts
/** Every Claude transcript under ~/.claude/projects, regardless of cwd. */
export function allClaudeTranscripts(claudeDir: string): string[] {
  const projectsDir = join(claudeDir, "projects");
  let folders; try { folders = readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const dir = join(projectsDir, folder.name);
    let files; try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) if (f.endsWith(".jsonl")) out.push(join(dir, f));
  }
  return out;
}
```

**`usage()` global branch** (`src/gem.controller.ts`): when `scope === "global"`, ignore `projects`
and scan everything against an EMPTY project inventory so every resolved call attributes to a global:

```ts
if (input.query.scope === "global") {
  const dirs = resolveDirs(input.query.dir);
  const paths = allClaudeTranscripts(dirs.claudeDir);
  const token = transcriptToken(paths);                       // reuse analysisCache's token helper
  const cached = readGlobalUsageCache(token);
  if (cached) return cached;
  const globalInv = introspectConfig(dirs);
  const emptyProject = { root: "", name: "", skills: [], mcpServers: [], instructions: [], hooks: [] };
  const scanInv = { project: emptyProject, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
  const signal = scanWorkflow(paths, scanInv);
  const result = { artifacts: signal.artifacts
    .filter((a) => a.root === null)                           // globals only
    .map((a) => ({ type: a.type, name: a.name, root: a.root, invocations: a.invocations, sessionsUsedIn: a.sessionsUsedIn, lastUsedMs: a.lastUsedMs })) };
  writeGlobalUsageCache(token, result);
  return result;
}
// ...existing per-project branch unchanged...
```

All wrapped in the existing `try/catch → { artifacts: [] }` (best-effort, never 500).

**Empty-project rationale:** `scanWorkflow` matches project artifacts before globals. A blank
project means a `Skill(qa)` call can only resolve to a *global* `qa` (if one exists) — never shadowed —
so counts reflect true global usage. Calls that resolve to neither (project-only skills) become
"unresolved" and are simply not counted, which is correct for a globals view.

**Cache** (`src/gem/usageCache.ts`, new — mirrors `analysisCache.ts`): a single-entry persistent
cache keyed by a transcript token.

```ts
// token = TOKEN_VERSION + transcript count + newest mtime across ALL transcripts (reuse transcriptToken)
export function readGlobalUsageCache(token: string): { artifacts: UsageItem[] } | null { /* best-effort */ }
export function writeGlobalUsageCache(token: string, result: { artifacts: UsageItem[] }): void { /* best-effort */ }
```

Persisted under `~/.agentgem/global-usage-cache.json` (a single `{token, result}` object; any read/write
failure is swallowed). Token invalidates whenever a transcript is added/updated, so it self-refreshes.

### Part 2 — Frontend: Import modal parity

In `src/public/index.html`:

**Controls** — add a control row at the top of the Import modal body (above `#importInventory`):
```html
<div class="bar" style="margin-bottom:8px">
  <button type="button" id="impSortUses" class="sortbtn" title="sort by usage count">Uses</button>
  <button type="button" id="impSortLast" class="sortbtn" title="sort by last used">Last used</button>
  <label class="chk"><input type="checkbox" id="impUsedOnly" checked> Used only</label>
</div>
```

**Kind map** for import rows (they use `data-ikind`):
```js
const IKIND_TO_USAGE_TYPE = { skills: "skill", mcpServers: "mcp_server", hooks: "hook", instructions: "instructions" };
```

**Decorate** — in `openImport()`, after `#importInventory.innerHTML = h`, stamp `data-order`
(per-group index, for sort "off"), then call `decorateImportUsage()`:
```js
async function decorateImportUsage(){
  let artifacts = [];
  try { artifacts = (await (await fetch("/api/usage?scope=global")).json()).artifacts || []; }
  catch { artifacts = []; }
  const map = new Map();                       // globals: key on type|name (root always null)
  for (const a of artifacts) map.set(`${a.type}|${a.name}`, a);
  document.querySelectorAll("#importInventory label.row").forEach(row => {
    const cb = row.querySelector("input[type=checkbox]");
    const type = IKIND_TO_USAGE_TYPE[cb && cb.dataset.ikind];
    const passive = type === "instructions" || type === "hook";
    if (passive) row.dataset.passive = "1"; else delete row.dataset.passive;
    const u = type ? map.get(`${type}|${(cb.dataset.name)||""}`) : null;
    const inv = u ? u.invocations : 0;
    row.dataset.invocations = String(inv);
    row.dataset.lastused = u && u.lastUsedMs ? String(u.lastUsedMs) : "";
    const host = row.querySelector("span");
    const old = host && host.querySelector(".usebadge"); if (old) old.remove();
    if (host && !passive && inv > 0) host.insertAdjacentHTML("beforeend", usageBadgeHtml(inv, u.lastUsedMs));
  });
  impUsageLoaded = true;
  sortRowsIn("#importInventory", impSortState);
  filterImportRows();
}
```

**Sort** — generalize the ledger's `sortRows()` into `sortRowsIn(containerSel, state)` (main ledger
calls `sortRowsIn("#inventory", sortState)`; behavior byte-identical). Add `impSortState` +
`cycleImportSort(key)` wired to `#impSortUses`/`#impSortLast` (same desc→asc→off, mutually exclusive).

**Filter** — `filterImportRows()` (import has only the used-filter; no search/source/agent/type):
```js
function filterImportRows(){
  const usedOnly = (document.getElementById("impUsedOnly")||{}).checked;
  document.querySelectorAll("#importInventory label.row").forEach(row => {
    const cbx = row.querySelector("input[type=checkbox]");
    const matchUsed = !usedOnly || !impUsageLoaded || row.dataset.passive === "1"
      || (cbx && cbx.checked) || Number(row.dataset.invocations || 0) > 0;
    row.style.display = matchUsed ? "" : "none";
  });
  // update each #importInventory .group h2 "— showing N" like the ledger's filterRows
}
```
Wire `#impUsedOnly` `change → filterImportRows`. `impUsageLoaded` starts `false`, reset to `false` at
the top of `openImport()` (so the modal opens showing everything until usage lands — no flash), set
`true` at the end of `decorateImportUsage()`.

**Shared extraction (DRY, ledger behavior preserved):**
- `usageBadgeHtml(inv, lastUsedMs)` — the `· N use(s) · date` builder, used by both `decorateUsage`
  (ledger) and `decorateImportUsage`. `fmtDay` already exists and is reused.
- `sortRowsIn(containerSel, state)` — the ledger's `sortRows` body, parameterized by container + state.
  The ledger keeps identical behavior; the import view passes its own container + `impSortState`.

## Data flow

```
openImport()
  ├─ GET /api/inventory            → render global groups (existing)
  └─ decorateImportUsage()
       └─ GET /api/usage?scope=global → [cache hit OR scan ALL transcripts w/ empty project]
                                       → stamp data-* + badges (join type|name)
                                       → sortRowsIn(#importInventory) + filterImportRows()
```

## Error handling

- `/api/usage?scope=global`: best-effort `catch → { artifacts: [] }`; logs `console.error("[usage] …")`.
- Cache read/write failures are swallowed; a miss just triggers a fresh scan.
- Client `decorateImportUsage()` tolerates an empty/failed fetch: rows keep `data-invocations="0"`,
  badges absent, and with `impUsedOnly` on only passive + checked rows show (acceptable — no signal).
- A usage entry with no matching import row is ignored; a row with no entry defaults to 0.

## Testing

Backend (vitest, mirrors `usage.test.ts`):
- `scope=global` aggregates a global skill's invocations across **two different projects'** transcripts
  (fixture: two project folders, both invoking the same global skill) → counts sum.
- A project-only skill (not in global inventory) does NOT appear in the `scope=global` result.
- Second call with unchanged transcripts is served from cache (assert identical result; optionally
  assert the scan isn't re-run by spying, if feasible — else just identity).
- `scope=global` with no transcripts → `{ artifacts: [] }` (no throw).
- Existing per-project `/api/usage` behavior unchanged (existing tests still pass).

Client (`index.html` inline JS — no harness in repo, consistent with the ledger feature): verified by
build + manual open of the Import modal. Where practical, keep `sortRowsIn`/the used-predicate pure so
they could be unit-tested if a harness is later added. State this honestly in the plan.

## Out of scope (and why)

- **Codex usage scanning** — feasible but a separate subsystem: Codex sessions
  (`~/.codex/sessions/Y/M/D/rollout-*.jsonl`) use the OpenAI Responses format (`response_item` lines,
  `payload.type:"function_call"` with `{name,arguments,call_id}`), which `scanWorkflow`'s Claude-only
  parser can't read. Supporting it needs `scanWorkflow` refactored to pluggable per-flavor parsers +
  a Codex `function_call → artifact` mapper. That benefits the ledger/analyze too, so it gets its own
  spec → plan → implement cycle. The `scope=global` endpoint and the import frontend built here are
  the integration point: when the Codex scanner lands, it feeds more transcripts into the same global
  scan and the badges update with no frontend change.
- **`agents` / `hermes` usage** — not implementable: `~/.agents` holds only a `skills/` dir (no
  session transcripts) and `~/.hermes` is Slack-thread/auth state (no filesystem tool-call log).
- **Search / source / agent / type filters in Import** — the Import view never had them; out of scope.
- **Surfacing `sessionsUsedIn` in the badge** — captured but not shown (same as the ledger).
```
