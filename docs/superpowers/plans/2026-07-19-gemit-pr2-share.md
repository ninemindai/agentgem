# gemit PR-2 (`--share`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agentgem gemit --share` publishes the steering report as a cataloged **unlisted** game gem on the hosted aggregator and prints the share URL + a prefilled X intent URL.

**Architecture:** A new pure module `src/gemit/share.ts` derives a privacy-stripped share variant of `GemitData`, re-renders it, packages the HTML as a one-artifact game gem (`exportGem`), and builds the signed `CatalogManifest`. The CLI (`src/gemitCli.ts`) gains `--share`/`--yes`: it ensures a GitHub binding (inline device flow if unbound), writes the exact share HTML to disk, asks for confirmation, then POSTs via the existing `postGemPublish` seam. No server changes — the hosted `/api/aggregator/publish-gem` endpoint already accepts this shape.

**Tech Stack:** existing packages only — `@agentgem/model` (Gem, GameArtifact, identity), `@agentgem/distribute` (exportGem/importGem), `@agentgem/contract` (CatalogManifest via aggregator re-export), `src/gem/gemPublishClient.ts` (postGemPublish), `src/bind/bindCore.ts` (binding + device flow). Vitest in root `src/__tests__/`.

## Global Constraints

- Tests live ONLY in root `src/__tests__/` (the only place CI collects).
- `src/cli.ts` lazy-imports subcommand modules; anything imported from `gemitCli.ts` bundles into cli.js automatically (no bundle-bins entries).
- gemKey = `<login>/gemit-<windowTo>` (windowTo = ISO day), version `"1.0.0"`, visibility `"unlisted"`, tags `["gemit"]`.
- Privacy: the shared HTML (including its `#gemit-data` JSON island) must NOT contain `topSkills`/`topSubagents` names. Variety counts stay.
- Nothing publishes without explicit confirmation: TTY y/N prompt, `--yes` skips; non-TTY without `--yes` refuses.
- Share URL base is hardcoded `https://app.agentgem.ai` (mirrors `packages/console/src/panels/Play/Studio.tsx:379`).
- PR description = mechanics only; no growth rationale.
- Verified seam facts (2026-07-19, worktree at origin/main 871b63b1):
  - `postGemPublish` (`src/gem/gemPublishClient.ts:26`) signs `catalogSigningPayload` and POSTs `{manifest, archiveBase64, pubkey, signedAt, signature}` to `${base}/api/aggregator/publish-gem`.
  - Server (`src/aggregator.controller.ts:347`) verifies archive via `importGem`, checks `manifest.gemDigest` against the archive digest, then `recordCatalogShare` (`packages/aggregator/src/catalog.ts:222`) requires a bound account and a slash-containing key; upsert per (key,version) with ownership guard; visibility preserved on republish.
  - `readBindingStatus()` (`src/bind/bindCore.ts:112`) → `{bound, login}` from `~/.agentgem/binding.json`; device flow = `startDeviceBind` + `completeDeviceBind`.
  - `GameArtifact` (`packages/model/src/types.ts:94`) requires `type,name,title,genre,html,createdFrom,engineVersion`; `GAME_GENRES` = replay | skill-run | project-fun | session-heatmap.
  - `exportGem(gem, {version})` (`packages/distribute/src/share.ts:20`) → `{bytes}`; `importGem(bytes).meta.gemDigest` binds the signature.
  - `renderRpgTheme` embeds the FULL `GemitData` as `<script id="gemit-data">` (`src/gemit/themeRpg.ts:85,191`) — this is why the share variant must strip names before rendering.

---

### Task 1: `src/gemit/share.ts` — pure share builder

**Files:**
- Create: `src/gemit/share.ts`
- Test: `src/__tests__/gemitShare.test.ts`

**Interfaces:**
- Consumes: `GemitData` (`src/gemit/score.ts`), `renderRpgTheme`/`TIER_NAMES` (`src/gemit/themeRpg.ts`), `exportGem`/`importGem` (`@agentgem/distribute`), `Gem`/`GameArtifact` (`@agentgem/model`), `CatalogManifest` (`@agentgem/aggregator/catalog`).
- Produces (used by Task 2's CLI wiring):
  - `shareVariantOf(data: GemitData): GemitData`
  - `buildGemitShare(args: { data: GemitData; login: string; render?: (d: GemitData) => string }): { gemKey: string; version: string; html: string; archiveBase64: string; manifest: CatalogManifest }`
  - `gemitShareUrls(gemKey: string, data: GemitData): { shareUrl: string; xIntentUrl: string }`
  - `GEMIT_SHARE_VERSION = "1.0.0"`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/gemitShare.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { shareVariantOf, buildGemitShare, gemitShareUrls, GEMIT_SHARE_VERSION } from "../gemit/share.js";
import { computeGemitData, type GemitSessionInput, type GemitScoredInput } from "../gemit/score.js";
import { importGem } from "@agentgem/distribute";

const NOW = Date.parse("2026-07-19T12:00:00Z");

function session(i: number): GemitSessionInput {
  return {
    sessionId: `s${i}`, agent: "claude", endMs: NOW - i * 3600_000, msgs: 20, tokensOut: 5000,
    skillNames: ["secret-skill", "other-skill"], subagentNames: ["secret-agent"],
    projectKey: `p${i % 2}`,
  };
}

function scored(i: number): GemitScoredInput {
  return {
    session: session(i), hygieneScore: 90, hygieneVerdict: "bounded",
    processScore: 80, processLabel: "disciplined",
    findings: [{ id: "f1", title: "Finding", count: 1 }], verifications: 1,
  };
}

const data = computeGemitData([0, 1, 2, 3, 4, 5].map(session), [0, 1, 2].map(scored), NOW);

describe("shareVariantOf", () => {
  it("strips skill/subagent names but keeps variety counts and scores", () => {
    const v = shareVariantOf(data);
    expect(v.topSkills).toEqual([]);
    expect(v.topSubagents).toEqual([]);
    expect(v.skillVariety).toBe(data.skillVariety);
    expect(v.subagentVariety).toBe(data.subagentVariety);
    expect(v.composite).toBe(data.composite);
    // source object untouched
    expect(data.topSkills.length).toBeGreaterThan(0);
  });
});

describe("buildGemitShare", () => {
  const built = buildGemitShare({ data, login: "raymondfeng" });

  it("keys the gem by login and window end date, version fixed", () => {
    expect(built.gemKey).toBe(`raymondfeng/gemit-${data.windowTo}`);
    expect(built.version).toBe(GEMIT_SHARE_VERSION);
    expect(built.manifest.gemKey).toBe(built.gemKey);
    expect(built.manifest.version).toBe(GEMIT_SHARE_VERSION);
  });

  it("publishes unlisted, tagged gemit, with a game artifact preview", () => {
    expect(built.manifest.visibility).toBe("unlisted");
    expect(built.manifest.tags).toContain("gemit");
    expect(built.manifest.artifactKinds).toEqual(["game"]);
    expect(built.manifest.artifacts).toEqual([{ name: `gemit-${data.windowTo}`, type: "game" }]);
    expect(built.manifest.description).toContain(String(data.composite));
    expect(built.manifest.description).toContain(`${data.scoredSessions} of ${data.qualifyingSessions}`);
  });

  it("round-trips as a valid gem archive whose digest is in the signed manifest", () => {
    const bytes = Buffer.from(built.archiveBase64, "base64");
    const { gem, meta } = importGem(bytes); // throws on bad lock
    expect(built.manifest.gemDigest).toBe(meta.gemDigest);
    expect(gem.artifacts).toHaveLength(1);
    const a = gem.artifacts[0] as { type: string; html: string; genre: string; engineVersion: string };
    expect(a.type).toBe("game");
    expect(a.genre).toBe("session-heatmap");
    expect(a.html).toBe(built.html);
  });

  it("ships NO skill or subagent names anywhere in the html", () => {
    expect(built.html).not.toContain("secret-skill");
    expect(built.html).not.toContain("secret-agent");
    // the JSON island carries the stripped variant
    expect(built.html).toContain('"topSkills":[]');
    expect(built.html).toContain('"topSubagents":[]');
  });
});

describe("gemitShareUrls", () => {
  it("builds the marketplace game URL and an X intent URL that embeds it", () => {
    const { shareUrl, xIntentUrl } = gemitShareUrls("raymondfeng/gemit-2026-07-19", data);
    expect(shareUrl).toBe("https://app.agentgem.ai/games/raymondfeng/gemit-2026-07-19");
    expect(xIntentUrl.startsWith("https://x.com/intent/post?text=")).toBe(true);
    expect(decodeURIComponent(xIntentUrl)).toContain(shareUrl);
    expect(decodeURIComponent(xIntentUrl)).toContain(`${data.composite}/100`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/gemit-pr2 && pnpm build >/dev/null 2>&1 || true; npx vitest run src/__tests__/gemitShare.test.ts`
Expected: FAIL — `Cannot find module '../gemit/share.js'` (note: root vitest runs compiled `dist/` in some suites but gemit tests import TS sources via vitest transform — mirror however `gemitScore.test.ts` imports; if the suite resolves `dist/`, run `pnpm build` first, matching PR-1's flow).

- [ ] **Step 3: Write the implementation**

Create `src/gemit/share.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/share.ts
//
// `agentgem gemit --share` packaging: derive the privacy-stripped share variant
// of a GemitData payload, render it, and wrap the HTML as a one-artifact game
// gem plus the signed catalog manifest. Pure — no filesystem, no network — the
// CLI owns confirmation and the actual POST (postGemPublish).
import type { Gem, GameArtifact } from "@agentgem/model";
import { exportGem, importGem } from "@agentgem/distribute";
import type { CatalogManifest } from "@agentgem/aggregator/catalog";
import type { GemitData } from "./score.js";
import { renderRpgTheme, TIER_NAMES } from "./themeRpg.js";

export const GEMIT_SHARE_VERSION = "1.0.0";
const MARKETPLACE_BASE = "https://app.agentgem.ai"; // mirrors Studio.tsx publish toast

// The local report may name the operator's skills/subagents; the shared copy must
// not (the theme embeds the full payload as a JSON island). Variety COUNTS stay —
// they are what the perks derive from.
export function shareVariantOf(data: GemitData): GemitData {
  return { ...data, topSkills: [], topSubagents: [] };
}

export function buildGemitShare(args: {
  data: GemitData;
  login: string;
  render?: (d: GemitData) => string;
}): { gemKey: string; version: string; html: string; archiveBase64: string; manifest: CatalogManifest } {
  const shareData = shareVariantOf(args.data);
  const html = (args.render ?? renderRpgTheme)(shareData);
  const name = `gemit-${args.data.windowTo}`;
  const gemKey = `${args.login}/${name}`;
  const tierName = TIER_NAMES[args.data.tierLevel - 1];

  const artifact: GameArtifact = {
    type: "game", name, title: `${tierName} — Agent Steering Report`,
    genre: "session-heatmap", html,
    createdFrom: { kind: "html", title: "agentgem gemit steering report" },
    engineVersion: "gemit-rpg-1",
  };
  const gem: Gem = { name, createdFrom: "gemit", artifacts: [artifact], checks: [], requiredSecrets: [] };
  const { bytes } = exportGem(gem, { version: GEMIT_SHARE_VERSION });
  const { meta } = importGem(bytes); // same round-trip publishSetup does: digest binds the signature

  const manifest: CatalogManifest = {
    gemKey, version: GEMIT_SHARE_VERSION, visibility: "unlisted", tags: ["gemit"],
    description: `Agent steering assessment ${args.data.windowFrom} → ${args.data.windowTo}: ` +
      `${tierName}, ${args.data.composite}/100. Scored ${args.data.scoredSessions} of ` +
      `${args.data.qualifyingSessions} sessions.`,
    artifactKinds: ["game"],
    artifacts: [{ name, type: "game" }],
    gemDigest: meta.gemDigest,
  };
  return { gemKey, version: GEMIT_SHARE_VERSION, html, archiveBase64: bytes.toString("base64"), manifest };
}

export function gemitShareUrls(gemKey: string, data: GemitData): { shareUrl: string; xIntentUrl: string } {
  const shareUrl = `${MARKETPLACE_BASE}/games/${gemKey}`;
  const tierName = TIER_NAMES[data.tierLevel - 1];
  const text = `${tierName} — ${data.composite}/100 on agent steering. What's your level?\n${shareUrl}`;
  return { shareUrl, xIntentUrl: `https://x.com/intent/post?text=${encodeURIComponent(text)}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/gemitShare.test.ts`
Expected: PASS (all 6). If import of `@agentgem/aggregator/catalog` fails type-check, use `import type { CatalogManifest } from "@agentgem/contract";` instead — both export it; pick whichever `src/gem/gemPublishClient.ts` compiles against (it uses the aggregator re-export).

- [ ] **Step 5: Typecheck + commit**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/gemit-pr2
npx tsc -b
git add src/gemit/share.ts src/__tests__/gemitShare.test.ts
git commit -m "feat(gemit): share builder — privacy-stripped report packaged as unlisted game gem"
```

---

### Task 2: CLI `--share` / `--yes` wiring

**Files:**
- Modify: `src/gemitCli.ts`
- Modify: `src/cli.ts` (help line only, `:51`)
- Test: `src/__tests__/gemitCli.test.ts` (extend)

**Interfaces:**
- Consumes from Task 1: `buildGemitShare`, `gemitShareUrls` (exact signatures above).
- Consumes existing: `postGemPublish` (`src/gem/gemPublishClient.ts:26`), `loadOrCreateIdentity` (`@agentgem/model`), `readBindingStatus`/`bindConfig`/`startDeviceBind`/`completeDeviceBind` (`./bind/bindCore.js`, `./bind/deviceFlow.js` indirectly).
- Produces: `GemitArgs` gains `share: boolean; yes: boolean`; `GemitCliDeps` gains `ensureBound?`, `publish?`, `confirm?`.

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/gemitCli.test.ts` (match its existing dep-injection style — read the file first and reuse its fixture helpers for collect/compute if present):

```ts
describe("gemit --share", () => {
  // Minimal deps: collect/compute stubs that yield a scoreable window.
  // Reuse the file's existing stub helpers; the shapes below are the contract.
  function shareDeps(overrides: Partial<GemitCliDeps> = {}) {
    const lines: string[] = [];
    const published: unknown[] = [];
    const deps: GemitCliDeps = {
      collect: async () => ({ qualifying, scored }),   // existing fixtures, ≥5 sessions
      writeFile: () => {},
      open: () => {},
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
      isTTY: true,
      nowMs: NOW,
      ensureBound: async () => "tester",
      confirm: async () => true,
      publish: async (args) => { published.push(args); return { shared: true, publishedBy: "tester" }; },
      ...overrides,
    };
    return { deps, lines, published };
  }

  it("parses --share and --yes", () => {
    const p = parseGemitArgs(["--share", "--yes"]);
    expect(p).toMatchObject({ share: true, yes: true });
    expect(parseGemitArgs([])).toMatchObject({ share: false, yes: false });
  });

  it("publishes after confirm and prints share + X URLs", async () => {
    const { deps, lines, published } = shareDeps();
    const code = await runGemitCommand(["--share"], deps);
    expect(code).toBe(0);
    expect(published).toHaveLength(1);
    const arg = published[0] as { manifest: { gemKey: string; visibility: string } };
    expect(arg.manifest.gemKey).toMatch(/^tester\/gemit-\d{4}-\d{2}-\d{2}$/);
    expect(arg.manifest.visibility).toBe("unlisted");
    expect(lines.some((l) => l.includes("app.agentgem.ai/games/tester/gemit-"))).toBe(true);
    expect(lines.some((l) => l.includes("x.com/intent/post"))).toBe(true);
  });

  it("does not publish when the confirm prompt is declined", async () => {
    const { deps, published } = shareDeps({ confirm: async () => false });
    const code = await runGemitCommand(["--share"], deps);
    expect(code).toBe(0);
    expect(published).toHaveLength(0);
  });

  it("refuses non-TTY share without --yes", async () => {
    const { deps, published } = shareDeps({ isTTY: false });
    const code = await runGemitCommand(["--share"], deps);
    expect(code).toBe(2);
    expect(published).toHaveLength(0);
  });

  it("--yes skips the prompt (works non-TTY)", async () => {
    let confirmCalled = false;
    const { deps, published } = shareDeps({ isTTY: false, confirm: async () => { confirmCalled = true; return true; } });
    const code = await runGemitCommand(["--share", "--yes"], deps);
    expect(code).toBe(0);
    expect(published).toHaveLength(1);
    expect(confirmCalled).toBe(false);
  });

  it("errors when binding fails", async () => {
    const { deps, published } = shareDeps({ ensureBound: async () => null });
    const code = await runGemitCommand(["--share", "--yes"], deps);
    expect(code).toBe(1);
    expect(published).toHaveLength(0);
  });

  it("skips share on insufficient data", async () => {
    const { deps, published } = shareDeps({ collect: async () => ({ qualifying: [], scored: [] }) });
    const code = await runGemitCommand(["--share", "--yes"], deps);
    expect(code).toBe(0);
    expect(published).toHaveLength(0);
  });

  it("surfaces a publish rejection", async () => {
    const { deps, lines } = shareDeps({ publish: async () => ({ shared: false, rejected: "conflict" }) });
    const code = await runGemitCommand(["--share", "--yes"], deps);
    expect(code).toBe(1);
    expect(lines.some((l) => l.includes("conflict"))).toBe(true);
  });

  it("writes the share html beside the report and ships that exact file", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const { deps, published } = shareDeps({ writeFile: (p, c) => writes.push({ path: p, content: c }) });
    await runGemitCommand(["--share", "--yes"], deps);
    const shareWrite = writes.find((w) => w.path.endsWith(".share.html"));
    expect(shareWrite).toBeDefined();
    expect(shareWrite!.content).not.toContain("secret-skill"); // fixture skill names never ship
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/__tests__/gemitCli.test.ts`
Expected: existing tests PASS, new `--share` tests FAIL (`share`/`yes` unknown option; deps missing).

- [ ] **Step 3: Implement in `src/gemitCli.ts`**

Changes (surgical — keep existing flow intact):

1. `GemitArgs` gains `share: boolean; yes: boolean;` — default both `false` in `parseGemitArgs`; parse `--share` and `--yes`/`-y` as flags (no value).
2. Update `GEMIT_HELP` options block:

```
  --share          Publish the report as an unlisted card on app.agentgem.ai
  --yes, -y        Skip the pre-publish confirmation
```

and append after the trailing paragraph: `--share uploads ONLY the rendered report (scores, counts, window — no skill/subagent names, no transcripts, no project names) after showing you exactly what ships.`

3. `GemitCliDeps` gains:

```ts
  /** Resolve the bound GitHub login, running the device flow inline if needed. null = failed. */
  ensureBound?: (out: (line: string) => void) => Promise<string | null>;
  publish?: typeof postGemPublish;
  /** TTY y/N prompt; only called when interactive and --yes absent. */
  confirm?: (question: string) => Promise<boolean>;
```

Import types lazily-compatible: `import { postGemPublish } from "./gem/gemPublishClient.js";` and `import { buildGemitShare, gemitShareUrls } from "./gemit/share.js";` at top of `gemitCli.ts` (cli.ts already lazy-imports gemitCli as a whole, so cli.js startup cost is unchanged).

4. Default implementations (module-level, in `gemitCli.ts`):

```ts
async function defaultEnsureBound(out: (l: string) => void): Promise<string | null> {
  const { readBindingStatus, bindConfig, startDeviceBind, completeDeviceBind } = await import("./bind/bindCore.js");
  const st = readBindingStatus();
  if (st.bound && st.login) return st.login;
  const cfg = bindConfig();
  const dc = await startDeviceBind(cfg);
  out("Publishing needs a one-time GitHub bind:");
  out(`  1. open ${dc.verificationUri}`);
  out(`  2. enter code: ${dc.userCode}`);
  const res = await completeDeviceBind(cfg, { deviceCode: dc.deviceCode, interval: dc.interval });
  return res.bound ? res.login : null;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); }
  finally { rl.close(); }
}
```

5. Share flow — append inside `runGemitCommand` after the existing `Report:` print (before the browser-open), guarded by `parsed.share`:

```ts
  if (parsed.share) {
    if (data.insufficient) {
      out("Nothing to share yet — score appears once 5 substantial sessions exist in the window.");
      return 0;
    }
    if (!parsed.yes && !isTTY) {
      err("gemit: --share needs a terminal to confirm (or pass --yes).");
      return 2;
    }
    const login = await (deps.ensureBound ?? defaultEnsureBound)(out);
    if (!login) {
      err("gemit: publishing requires a GitHub bind (agentgem bind).");
      return 1;
    }
    const built = buildGemitShare({ data, login });
    const sharePath = outPath.replace(/\.html$/, ".share.html");
    write(sharePath, built.html);
    out("");
    out("Ready to publish an UNLISTED card (visible only via its link):");
    out(`  ${built.manifest.description}`);
    out(`  Card: ${built.gemKey} v${built.version} — exact file: ${sharePath}`);
    out("  Ships: scores, counts, window dates. Never: skill/subagent names, projects, transcripts.");
    if (!parsed.yes) {
      const okay = await (deps.confirm ?? defaultConfirm)("Publish? [y/N] ");
      if (!okay) { out("Not published."); return 0; }
    }
    const { loadOrCreateIdentity } = await import("@agentgem/model");
    const r = await (deps.publish ?? postGemPublish)({
      manifest: built.manifest, archiveBase64: built.archiveBase64, identity: loadOrCreateIdentity(),
    });
    if (!r.shared) {
      err(`gemit: share rejected (${r.rejected})${r.rejected === "conflict" ? " — that key belongs to another account" : ""}`);
      return 1;
    }
    const urls = gemitShareUrls(built.gemKey, data);
    out(`Published: ${urls.shareUrl}`);
    out(`Share on X: ${urls.xIntentUrl}`);
  }
```

Note the `isTTY` const already exists later in the function — hoist it above the share block (single declaration, used by both share and open).

6. `src/cli.ts:51` help line becomes:

```
  agentgem gemit                        Score your last 30 days of agent steering into a local report (--share publishes an unlisted card)
```

- [ ] **Step 4: Run the full gemit suites**

Run: `npx vitest run src/__tests__/gemitCli.test.ts src/__tests__/gemitShare.test.ts src/__tests__/gemitScore.test.ts src/__tests__/gemitCollect.test.ts src/__tests__/gemitTheme.test.ts`
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gemitCli.ts src/cli.ts src/__tests__/gemitCli.test.ts
git commit -m "feat(gemit): --share publishes the report as a cataloged unlisted gem"
```

---

### Task 3: Full verification + PR

- [ ] **Step 1: Full build + root test suite**

```bash
cd /Users/rfeng/Projects/ninemind/agentgem-worktrees/gemit-pr2
pnpm build          # tsc -b && build-console (root build memory: tsc -b alone leaves console stale)
npx vitest run      # root suite = what CI gates
```
Expected: build clean, suite green (pre-existing flakes per memory: App.test Groups-nav race, coldBuildWorker — re-run in isolation if they trip).

- [ ] **Step 2: Manual smoke (no publish)**

```bash
node dist/cli.js gemit --no-open            # baseline still works
node dist/cli.js gemit --share < /dev/null  # non-TTY: must refuse with exit 2, no network
```
Expected: first prints tier + report path; second prints the `--share needs a terminal` error.

- [ ] **Step 3: Push + PR (mechanics-only description), watch CI, merge**

```bash
git push -u origin feat/gemit-share
gh pr create --title "feat(gemit): --share publishes the report as an unlisted marketplace card" --body "…mechanics only…"
gh run watch <run-id> --exit-status
gh pr merge --rebase --delete-branch   # local branch-delete may error (main checked out elsewhere) — remote merge still lands
```
Then verify BOTH commits' content on origin/main (`git fetch; git show origin/main:src/gemit/share.ts | head`, `git show origin/main:src/gemitCli.ts | grep -c share`).
