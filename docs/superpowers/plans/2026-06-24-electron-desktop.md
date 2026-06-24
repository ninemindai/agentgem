# AgentGem Desktop (Electron) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a native desktop app that hosts the existing AgentGem server in Electron's main process and points a window at it, adding a native folder picker, app menu, system tray, and scaffolded auto-update.

**Architecture:** A self-contained `desktop/` package compiles its own CommonJS main process. On launch, main resolves and dynamically `import()`s the already-built ESM core (`createApp`), starts it on an OS-assigned localhost port, and loads `http://127.0.0.1:<port>/` in a `BrowserWindow`. REST/MCP/UI are reused unchanged; native features are layered on via IPC and Electron APIs.

**Tech Stack:** Electron, electron-builder, electron-updater, TypeScript (`module: node16`), vitest. Core is `@ninemind/agentgem` (AgentBack REST + MCP), already built to `dist/`.

## Global Constraints

- Work entirely in the worktree `../agentgem-desktop` on branch `desktop-electron`.
- The root `package.json`, its `files` array, and the published npm tarball MUST NOT change. Electron deps live only under `desktop/`.
- `desktop/` is NOT a pnpm workspace member; it has its own isolated `node_modules`.
- Desktop TypeScript MUST use `"module": "node16"` / `"moduleResolution": "node16"` so dynamic `import()` of the ESM core is preserved (plain `commonjs` rewrites it to `require()` and breaks on `ERR_REQUIRE_ESM`).
- `desktop/package.json` has NO `"type": "module"` (Electron main runs as CommonJS).
- The native folder picker MUST return `{ path: string | null }` — identical to the existing `/api/pick-folder` REST shape — so the UI stays drop-in.
- Git identity for all commits: `Raymond Feng <raymond@ninemind.ai>`. End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- All commands below run from the worktree root `../agentgem-desktop` unless a `-C desktop` flag is shown.

---

### Task 1: Scaffold the `desktop/` package and toolchain

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/tsconfig.json`
- Create: `desktop/vitest.config.ts`
- Create: `desktop/.gitignore`
- Create: `desktop/src/version.ts`
- Test: `desktop/src/__tests__/version.test.ts`

**Interfaces:**
- Produces: `DESKTOP_NAME: string` from `desktop/src/version.ts` (a trivial export used only to prove the toolchain compiles and tests run).

- [ ] **Step 1: Write `desktop/package.json`**

```json
{
  "name": "agentgem-desktop",
  "version": "0.1.0",
  "private": true,
  "description": "Native desktop host for AgentGem",
  "author": "ninemind.ai",
  "main": "dist/main.js",
  "scripts": {
    "build:core": "pnpm -C .. build",
    "build": "tsc -p .",
    "dev": "pnpm build:core && pnpm build && cross-env AGENTGEM_DEV=1 electron dist/main.js",
    "dist": "pnpm build:core && pnpm build && electron-builder",
    "release": "pnpm build:core && pnpm build && electron-builder --publish always",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "cross-env": "^7.0.3",
    "electron": "^33.0.0",
    "electron-builder": "^25.1.8",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "dependencies": {
    "electron-updater": "^6.3.9"
  }
}
```

- [ ] **Step 2: Write `desktop/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "node16",
    "moduleResolution": "node16",
    "lib": ["es2022", "dom"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "rootDir": "src",
    "outDir": "dist",
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "src/**/__tests__"]
}
```

- [ ] **Step 3: Write `desktop/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Write `desktop/.gitignore`**

```
node_modules/
dist/
release/
```

- [ ] **Step 5: Write the failing test `desktop/src/__tests__/version.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { DESKTOP_NAME } from "../version.js";

describe("version", () => {
  it("exposes the desktop name", () => {
    expect(DESKTOP_NAME).toBe("AgentGem");
  });
});
```

- [ ] **Step 6: Install deps and run the test to verify it fails**

Run: `pnpm -C desktop install && pnpm -C desktop test`
Expected: FAIL — cannot resolve `../version.js` (module does not exist).

- [ ] **Step 7: Write `desktop/src/version.ts`**

```ts
// The product/display name surfaced in the window title, menu, and packaging.
export const DESKTOP_NAME = "AgentGem";
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm -C desktop test`
Expected: PASS (1 test).

- [ ] **Step 9: Commit**

```bash
git add desktop/package.json desktop/tsconfig.json desktop/vitest.config.ts desktop/.gitignore desktop/src/version.ts desktop/src/__tests__/version.test.ts desktop/pnpm-lock.yaml
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "chore(desktop): scaffold Electron package and toolchain

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Free-port helper

**Files:**
- Create: `desktop/src/net.ts`
- Test: `desktop/src/__tests__/net.test.ts`

**Interfaces:**
- Produces: `getFreePort(): Promise<number>` — resolves an OS-assigned, currently-free TCP port on `127.0.0.1`.

- [ ] **Step 1: Write the failing test `desktop/src/__tests__/net.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { getFreePort } from "../net.js";

describe("getFreePort", () => {
  it("returns a usable TCP port number", async () => {
    const port = await getFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(1023);
    expect(port).toBeLessThan(65536);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C desktop test net`
Expected: FAIL — cannot resolve `../net.js`.

- [ ] **Step 3: Write `desktop/src/net.ts`**

```ts
import net from "node:net";

// Bind to port 0 so the OS picks a free port, read it back, then release it.
// We pass the number to createApp(port) immediately after, so the brief gap
// between close and re-bind is acceptable for a single-user local app.
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C desktop test net`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/net.ts desktop/src/__tests__/net.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(desktop): add free-port helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Core-entry resolver

**Files:**
- Create: `desktop/src/core.ts`
- Test: `desktop/src/__tests__/core.test.ts`

**Interfaces:**
- Produces:
  - `coreEntryCandidates(mainDir: string, resourcesPath: string): string[]` — ordered list of where the built core `index.js` may live (packaged first, dev fallback second).
  - `resolveCoreEntry(candidates: string[]): string` — first existing path, else throws with the searched list.

- [ ] **Step 1: Write the failing test `desktop/src/__tests__/core.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreEntryCandidates, resolveCoreEntry } from "../core.js";

describe("coreEntryCandidates", () => {
  it("lists packaged resources first, dev dist second", () => {
    const list = coreEntryCandidates("/app/desktop/dist", "/app/resources");
    expect(list).toEqual([
      join("/app/resources", "core", "index.js"),
      join("/app/desktop/dist", "..", "..", "dist", "index.js"),
    ]);
  });
});

describe("resolveCoreEntry", () => {
  it("returns the first existing candidate", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-"));
    mkdirSync(join(dir, "real"));
    const real = join(dir, "real", "index.js");
    writeFileSync(real, "// core");
    expect(resolveCoreEntry([join(dir, "missing.js"), real])).toBe(real);
  });

  it("throws listing all candidates when none exist", () => {
    expect(() => resolveCoreEntry(["/nope/a.js", "/nope/b.js"])).toThrow(/\/nope\/a\.js/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C desktop test core`
Expected: FAIL — cannot resolve `../core.js`.

- [ ] **Step 3: Write `desktop/src/core.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

// Mirrors the core's own candidate-path probing (src/index.ts looks for
// index.html in two places). Packaged builds copy the core's dist into
// resources/core via electron-builder extraResources; dev runs against the
// sibling repo dist two levels up from desktop/dist.
export function coreEntryCandidates(mainDir: string, resourcesPath: string): string[] {
  return [
    join(resourcesPath, "core", "index.js"),
    join(mainDir, "..", "..", "dist", "index.js"),
  ];
}

export function resolveCoreEntry(candidates: string[]): string {
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`AgentGem core not found. Looked in:\n${candidates.join("\n")}`);
  }
  return found;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C desktop test core`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/core.ts desktop/src/__tests__/core.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(desktop): resolve core entry across dev and packaged layouts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Embedded server bootstrap

**Files:**
- Create: `desktop/src/server.ts`
- Test: `desktop/src/__tests__/server.test.ts`

**Interfaces:**
- Consumes: `getFreePort` (Task 2); `coreEntryCandidates`, `resolveCoreEntry` (Task 3); the core's `createApp(port: number): Promise<RestApplication>` where `RestApplication` has `start()`, `stop()`, and `restServer` (a promise of `{ url: string }`).
- Produces: `startEmbeddedServer(mainDir: string, resourcesPath: string): Promise<EmbeddedServer>` where `EmbeddedServer = { url: string; stop: () => Promise<void> }`.

- [ ] **Step 1: Build the core so the dev candidate exists**

Run: `pnpm -C desktop build:core`
Expected: builds repo `dist/` including `dist/index.js`.

- [ ] **Step 2: Write the failing test `desktop/src/__tests__/server.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { startEmbeddedServer } from "../server.js";

// __dirname at runtime is desktop/src/__tests__ under vitest; the core resolver
// expects the compiled main dir (desktop/dist). The dev candidate walks two
// levels up from there to repo dist, so pass a path two levels below repo root.
const fakeMainDir = join(__dirname, "..", "..", "dist");

describe("startEmbeddedServer", () => {
  it("starts the core and serves the UI, then stops cleanly", async () => {
    const srv = await startEmbeddedServer(fakeMainDir, "/nonexistent-resources");
    try {
      expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${srv.url}/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body.toLowerCase()).toContain("<!doctype html");
    } finally {
      await srv.stop();
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm -C desktop test server`
Expected: FAIL — cannot resolve `../server.js`.

- [ ] **Step 4: Write `desktop/src/server.ts`**

```ts
import { pathToFileURL } from "node:url";
import { getFreePort } from "./net.js";
import { coreEntryCandidates, resolveCoreEntry } from "./core.js";

export interface EmbeddedServer {
  url: string;
  stop: () => Promise<void>;
}

interface CoreApp {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  restServer: Promise<{ url: string }>;
}
interface CoreModule {
  createApp(port: number): Promise<CoreApp>;
}

// Dynamically import the ESM core from CommonJS main. tsconfig module=node16
// preserves this import() instead of rewriting it to require() (which would
// throw ERR_REQUIRE_ESM against the ESM core).
export async function startEmbeddedServer(
  mainDir: string,
  resourcesPath: string,
): Promise<EmbeddedServer> {
  const entry = resolveCoreEntry(coreEntryCandidates(mainDir, resourcesPath));
  const mod = (await import(pathToFileURL(entry).href)) as CoreModule;
  const port = await getFreePort();
  const app = await mod.createApp(port);
  await app.start();
  const server = await app.restServer;
  return {
    url: server.url,
    stop: async () => {
      await app.stop();
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -C desktop test server`
Expected: PASS — fetches the served `index.html`.

- [ ] **Step 6: Commit**

```bash
git add desktop/src/server.ts desktop/src/__tests__/server.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(desktop): boot the embedded AgentGem server in main

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Folder-picker IPC contract

**Files:**
- Create: `desktop/src/ipc.ts`
- Test: `desktop/src/__tests__/ipc.test.ts`

**Interfaces:**
- Produces:
  - `PICK_FOLDER: string` — the IPC channel name (`"agentgem:pick-folder"`).
  - `UPDATE_EVENT: string` — the renderer update channel (`"agentgem:update"`).
  - `pickFolderResult(r: { canceled: boolean; filePaths: string[] }): { path: string | null }` — maps Electron's `dialog.showOpenDialog` return to the existing REST `{ path }` shape.

- [ ] **Step 1: Write the failing test `desktop/src/__tests__/ipc.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { PICK_FOLDER, UPDATE_EVENT, pickFolderResult } from "../ipc.js";

describe("ipc channels", () => {
  it("uses stable, namespaced channel names", () => {
    expect(PICK_FOLDER).toBe("agentgem:pick-folder");
    expect(UPDATE_EVENT).toBe("agentgem:update");
  });
});

describe("pickFolderResult", () => {
  it("returns the first path when a folder is chosen", () => {
    expect(pickFolderResult({ canceled: false, filePaths: ["/a/b"] })).toEqual({ path: "/a/b" });
  });
  it("returns null path when canceled", () => {
    expect(pickFolderResult({ canceled: true, filePaths: [] })).toEqual({ path: null });
  });
  it("returns null path when no selection", () => {
    expect(pickFolderResult({ canceled: false, filePaths: [] })).toEqual({ path: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C desktop test ipc`
Expected: FAIL — cannot resolve `../ipc.js`.

- [ ] **Step 3: Write `desktop/src/ipc.ts`**

```ts
// Shared channel names + the dialog→REST shape mapper, kept free of electron
// imports so it is unit-testable in a plain node environment.
export const PICK_FOLDER = "agentgem:pick-folder";
export const UPDATE_EVENT = "agentgem:update";

export function pickFolderResult(r: { canceled: boolean; filePaths: string[] }): {
  path: string | null;
} {
  if (r.canceled || r.filePaths.length === 0) return { path: null };
  return { path: r.filePaths[0] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C desktop test ipc`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/ipc.ts desktop/src/__tests__/ipc.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(desktop): define folder-picker IPC contract

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Application menu template

**Files:**
- Create: `desktop/src/menu.ts`
- Test: `desktop/src/__tests__/menu.test.ts`

**Interfaces:**
- Produces: `buildMenuTemplate(opts: { platform: NodeJS.Platform; isDev: boolean; onCheckUpdates: () => void }): import("electron").MenuItemConstructorOptions[]`.

- [ ] **Step 1: Write the failing test `desktop/src/__tests__/menu.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { buildMenuTemplate } from "../menu.js";

const noop = () => {};

describe("buildMenuTemplate", () => {
  it("adds the macOS app menu first on darwin", () => {
    const t = buildMenuTemplate({ platform: "darwin", isDev: false, onCheckUpdates: noop });
    expect(t[0].role).toBe("appMenu");
  });

  it("omits the app menu on non-darwin", () => {
    const t = buildMenuTemplate({ platform: "linux", isDev: false, onCheckUpdates: noop });
    expect(t.some((m) => m.role === "appMenu")).toBe(false);
  });

  it("always includes a reload item in the View menu", () => {
    const t = buildMenuTemplate({ platform: "linux", isDev: false, onCheckUpdates: noop });
    const view = t.find((m) => m.label === "View");
    const labels = (view?.submenu as any[]).map((i) => i.role);
    expect(labels).toContain("reload");
  });

  it("only exposes devtools when isDev", () => {
    const dev = buildMenuTemplate({ platform: "linux", isDev: true, onCheckUpdates: noop });
    const prod = buildMenuTemplate({ platform: "linux", isDev: false, onCheckUpdates: noop });
    const hasDevtools = (t: any[]) =>
      t.some((m) => Array.isArray(m.submenu) && m.submenu.some((i: any) => i.role === "toggleDevTools"));
    expect(hasDevtools(dev)).toBe(true);
    expect(hasDevtools(prod)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C desktop test menu`
Expected: FAIL — cannot resolve `../menu.js`.

- [ ] **Step 3: Write `desktop/src/menu.ts`**

```ts
import type { MenuItemConstructorOptions } from "electron";

export interface MenuOpts {
  platform: NodeJS.Platform;
  isDev: boolean;
  onCheckUpdates: () => void;
}

// Role-based template: Electron supplies the native behavior/labels for roles,
// so copy/paste/quit/reload work without manual accelerator wiring.
export function buildMenuTemplate(opts: MenuOpts): MenuItemConstructorOptions[] {
  const { platform, isDev, onCheckUpdates } = opts;
  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  if (isDev) viewSubmenu.push({ type: "separator" }, { role: "toggleDevTools" });

  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        { label: "Check for Updates…", click: onCheckUpdates },
        { type: "separator" },
        platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { label: "View", submenu: viewSubmenu },
    { role: "windowMenu" },
  ];

  if (platform === "darwin") template.unshift({ role: "appMenu" });
  return template;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C desktop test menu`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/menu.ts desktop/src/__tests__/menu.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(desktop): build role-based application menu

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Auto-update feed parser

**Files:**
- Create: `desktop/src/updater.ts`
- Test: `desktop/src/__tests__/updater.test.ts`

**Interfaces:**
- Produces:
  - `updaterFeed(repoUrl: string): { provider: "github"; owner: string; repo: string }` — parses a GitHub repo URL into an electron-updater GitHub feed.
  - `configureUpdater(updater: { autoDownload: boolean; on: (e: string, cb: (...a: any[]) => void) => void; checkForUpdatesAndNotify: () => Promise<unknown> }, handlers: { onAvailable: () => void; onDownloaded: () => void }): void` — wires update events (verified manually; only `updaterFeed` is unit-tested).

- [ ] **Step 1: Write the failing test `desktop/src/__tests__/updater.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { updaterFeed } from "../updater.js";

describe("updaterFeed", () => {
  it("parses an https git url", () => {
    expect(updaterFeed("git+https://github.com/ninemindai/agentgem.git")).toEqual({
      provider: "github",
      owner: "ninemindai",
      repo: "agentgem",
    });
  });
  it("parses an ssh url", () => {
    expect(updaterFeed("git@github.com:ninemindai/agentgem.git")).toEqual({
      provider: "github",
      owner: "ninemindai",
      repo: "agentgem",
    });
  });
  it("throws on a non-github url", () => {
    expect(() => updaterFeed("https://gitlab.com/x/y.git")).toThrow(/github/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -C desktop test updater`
Expected: FAIL — cannot resolve `../updater.js`.

- [ ] **Step 3: Write `desktop/src/updater.ts`**

```ts
export interface GithubFeed {
  provider: "github";
  owner: string;
  repo: string;
}

export function updaterFeed(repoUrl: string): GithubFeed {
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!m) throw new Error(`Cannot parse a GitHub repo from: ${repoUrl}`);
  return { provider: "github", owner: m[1], repo: m[2] };
}

interface MinimalUpdater {
  autoDownload: boolean;
  on(event: string, cb: (...args: any[]) => void): void;
  checkForUpdatesAndNotify(): Promise<unknown>;
}

// Thin wiring around electron-updater; exercised via the manual smoke checklist
// (a real update requires a published, signed release).
export function configureUpdater(
  updater: MinimalUpdater,
  handlers: { onAvailable: () => void; onDownloaded: () => void },
): void {
  updater.autoDownload = true;
  updater.on("update-available", handlers.onAvailable);
  updater.on("update-downloaded", handlers.onDownloaded);
  void updater.checkForUpdatesAndNotify();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -C desktop test updater`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/updater.ts desktop/src/__tests__/updater.test.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(desktop): parse GitHub auto-update feed

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Preload bridge

**Files:**
- Create: `desktop/src/preload.ts`

**Interfaces:**
- Consumes: `PICK_FOLDER`, `UPDATE_EVENT` (Task 5).
- Produces: a renderer global `window.agentgem` with `pickFolder(): Promise<{ path: string | null }>` and `onUpdate(cb: (info: { status: string }) => void): void`.

> No unit test: this module only calls Electron's `contextBridge`/`ipcRenderer`, which require a live renderer. It is verified by the manual smoke checklist (Task 12). Keep it a thin pass-through with no logic.

- [ ] **Step 1: Write `desktop/src/preload.ts`**

```ts
import { contextBridge, ipcRenderer } from "electron";
import { PICK_FOLDER, UPDATE_EVENT } from "./ipc.js";

// contextIsolation is on; expose only a minimal, typed surface to the page.
contextBridge.exposeInMainWorld("agentgem", {
  pickFolder: (): Promise<{ path: string | null }> => ipcRenderer.invoke(PICK_FOLDER),
  onUpdate: (cb: (info: { status: string }) => void): void => {
    ipcRenderer.on(UPDATE_EVENT, (_e, info) => cb(info));
  },
});
```

- [ ] **Step 2: Build to verify it compiles**

Run: `pnpm -C desktop build`
Expected: `tsc` succeeds; `desktop/dist/preload.js` exists.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/preload.ts
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(desktop): expose pickFolder + update bridge via preload

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Main process — window, tray, IPC, lifecycle

**Files:**
- Create: `desktop/src/tray.ts`
- Create: `desktop/src/main.ts`
- Create: `desktop/build/icon.png` (1024×1024 placeholder; see step 1)

**Interfaces:**
- Consumes: `startEmbeddedServer` (Task 4); `PICK_FOLDER`, `UPDATE_EVENT`, `pickFolderResult` (Task 5); `buildMenuTemplate` (Task 6); `updaterFeed`, `configureUpdater` (Task 7); `DESKTOP_NAME` (Task 1).
- Produces:
  - `createTray(opts: { onOpen: () => void; onQuit: () => void; iconPath: string }): import("electron").Tray`.
  - `desktop/dist/main.js` — the Electron entry (`package.json` `main`). No exported API; verified by `dev` launch + smoke checklist.

> Main-process lifecycle (`app.whenReady`, windows, tray) can't be meaningfully unit-tested without a full Electron runtime. Verification is the manual smoke checklist (Task 12). Keep all testable logic in Tasks 2–7 (already covered); `main.ts` only wires them.

- [ ] **Step 1: Create a placeholder app icon**

Run:
```bash
mkdir -p desktop/build
# 1024x1024 solid-color PNG placeholder; replace with real art before release.
node -e "const z=require('zlib');const w=1024,h=1024;const row=Buffer.alloc(1+w*4);for(let x=0;x<w;x++){row[1+x*4]=0x21;row[2+x*4]=0x1c;row[3+x*4]=0x15;row[4+x*4]=0xff;}const raw=Buffer.concat(Array.from({length:h},()=>row));const idat=z.deflateSync(raw);function chunk(t,d){const len=Buffer.alloc(4);len.writeUInt32BE(d.length);const tb=Buffer.from(t);const crc=Buffer.alloc(4);crc.writeUInt32BE(require('zlib').crc32?require('zlib').crc32(Buffer.concat([tb,d]))>>>0:0);return Buffer.concat([len,tb,d,crc]);}" 2>/dev/null || true
```

If the inline generator is unavailable, create any 1024×1024 PNG at `desktop/build/icon.png` (a flat brand-color square is fine for now). The release art is out of scope; electron-builder derives platform icons from this file.

- [ ] **Step 2: Write `desktop/src/tray.ts`**

```ts
import { Tray, Menu, nativeImage } from "electron";

// Tray lives for the app's lifetime; closing the window hides to tray rather
// than quitting, so the embedded server keeps running until explicit Quit.
export function createTray(opts: {
  onOpen: () => void;
  onQuit: () => void;
  iconPath: string;
}): Tray {
  const image = nativeImage.createFromPath(opts.iconPath).resize({ width: 18, height: 18 });
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("AgentGem");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open AgentGem", click: opts.onOpen },
      { type: "separator" },
      { label: "Quit", click: opts.onQuit },
    ]),
  );
  tray.on("click", opts.onOpen);
  return tray;
}
```

- [ ] **Step 3: Write `desktop/src/main.ts`**

```ts
import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { autoUpdater } from "electron-updater";
import type { Tray } from "electron";
import { startEmbeddedServer, type EmbeddedServer } from "./server.js";
import { PICK_FOLDER, UPDATE_EVENT, pickFolderResult } from "./ipc.js";
import { buildMenuTemplate } from "./menu.js";
import { configureUpdater } from "./updater.js";
import { createTray } from "./tray.js";
import { DESKTOP_NAME } from "./version.js";

const isDev = process.env.AGENTGEM_DEV === "1";
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: EmbeddedServer | null = null;
let quitting = false;

function showWindow(): void {
  if (win) {
    win.show();
    win.focus();
  }
}

async function createWindow(url: string): Promise<void> {
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: DESKTOP_NAME,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Closing the window hides to tray; the server keeps running until Quit.
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  await win.loadURL(`${url}/`);
}

function setupUpdates(): void {
  const notify = (status: string) => win?.webContents.send(UPDATE_EVENT, { status });
  configureUpdater(autoUpdater, {
    onAvailable: () => notify("available"),
    onDownloaded: () => notify("downloaded"),
  });
}

async function boot(): Promise<void> {
  ipcMain.handle(PICK_FOLDER, async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return pickFolderResult(r);
  });

  try {
    server = await startEmbeddedServer(join(__dirname), process.resourcesPath);
  } catch (err) {
    dialog.showErrorBox("AgentGem failed to start", String((err as Error)?.message ?? err));
    app.exit(1);
    return;
  }

  await createWindow(server.url);

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        platform: process.platform,
        isDev,
        onCheckUpdates: () => void autoUpdater.checkForUpdatesAndNotify(),
      }),
    ),
  );

  const iconPath = join(__dirname, "..", "build", "icon.png");
  tray = createTray({ onOpen: showWindow, onQuit: () => app.quit(), iconPath });

  if (!isDev) setupUpdates();
}

// Single-instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(boot);
  app.on("activate", () => {
    if (win) showWindow();
  });
  app.on("window-all-closed", () => {
    // Stay alive in the tray; do not quit on window close.
  });
  app.on("before-quit", async () => {
    quitting = true;
    tray?.destroy();
    if (server) await server.stop();
  });
}

// Silence an unused-import warning for readFileSync if tree-shaking complains.
void readFileSync;
```

- [ ] **Step 4: Build and launch to smoke-test**

Run: `pnpm -C desktop dev`
Expected: an AgentGem window opens showing the existing UI; no errors in the terminal. Close the window — the app stays in the tray. Use the tray "Quit" to exit.

> If `readFileSync`/`void readFileSync` triggers a lint or unused complaint, delete both the import and the `void` line — they are only present as a guard and are not required.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/main.ts desktop/src/tray.ts desktop/build/icon.png
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(desktop): wire window, tray, IPC, and lifecycle in main

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Wire the native picker into the web UI

**Files:**
- Modify: `src/public/index.html` (around `:425-430` and `:1055-1062`)

**Interfaces:**
- Consumes: renderer global `window.agentgem.pickFolder` (Task 8), with REST `/api/pick-folder` as the browser fallback.

> Verified by the manual smoke checklist (Task 12): the change is a 5-line guarded helper plus two call-site swaps. In a plain browser the fallback path keeps the existing behavior; under Electron the native dialog is used.

- [ ] **Step 1: Add a `pickFolderPath()` helper**

In `src/public/index.html`, add this helper in the page's main `<script>` (place it just above the first `browse`/pick handler near line 425):

```js
// Prefer the Electron-native folder dialog when running in the desktop app;
// fall back to the local REST picker in a plain browser. Both return { path }.
async function pickFolderPath() {
  if (window.agentgem && window.agentgem.pickFolder) {
    return await window.agentgem.pickFolder();
  }
  return await (await fetch("/api/pick-folder")).json();
}
```

- [ ] **Step 2: Replace the first call site (~line 427)**

Change:
```js
  const pick = await (await fetch("/api/pick-folder")).json();
```
to:
```js
  const pick = await pickFolderPath();
```

- [ ] **Step 3: Replace the second call site (~line 1059)**

Change:
```js
  const picked = await (await fetch("/api/pick-folder")).json();
```
to:
```js
  const picked = await pickFolderPath();
```

- [ ] **Step 4: Rebuild the core and smoke-test both paths**

Run: `pnpm -C desktop dev`
Expected (Electron): clicking Browse opens the **native** macOS/Windows/Linux directory dialog (not the osascript shell-out), and a chosen folder populates the candidate.

Run (plain browser): `pnpm build && node dist/index.js`, open the printed URL, click Browse.
Expected: the existing REST picker still works unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/public/index.html
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "feat(desktop): use native folder dialog in the UI when available

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Packaging and release scaffolding

**Files:**
- Create: `desktop/electron-builder.yml`
- Create: `desktop/build/entitlements.mac.plist`
- Create: `.github/workflows/desktop-release.yml`

**Interfaces:**
- Consumes: `desktop/dist/**` (compiled main/preload), the repo `dist/**` (core, copied as `extraResources` → `core`), `desktop/build/icon.png`.

> Verified by `pnpm -C desktop dist` producing an installer locally (unsigned). Signing/notarization is scaffolded via env vars but not executed.

- [ ] **Step 1: Write `desktop/electron-builder.yml`**

```yaml
appId: ai.ninemind.agentgem
productName: AgentGem
copyright: © ninemind.ai
directories:
  output: release
  buildResources: build
files:
  - dist/**
  - package.json
extraResources:
  # Copy the built core into resources/core so resolveCoreEntry finds it
  # at runtime in the packaged app.
  - from: ../dist
    to: core
    filter:
      - "**/*"
      - "!**/__tests__/**"
      - "!**/*.test.*"
mac:
  category: public.app-category.developer-tools
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  target:
    - target: dmg
      arch: [x64, arm64]
    - target: zip
      arch: [x64, arm64]
win:
  target:
    - nsis
linux:
  category: Development
  target:
    - AppImage
publish:
  provider: github
  owner: ninemindai
  repo: agentgem
```

- [ ] **Step 2: Write `desktop/build/entitlements.mac.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
</dict>
</plist>
```

- [ ] **Step 3: Write `.github/workflows/desktop-release.yml`**

```yaml
name: Desktop Release
on:
  push:
    tags:
      - "desktop-v*"
  workflow_dispatch:

jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.29.2
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: pnpm install
      - run: pnpm -C desktop install
      # Signing/notarization run only when the secrets are present; absent
      # secrets produce an unsigned build instead of failing.
      - run: pnpm -C desktop release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_LINK: ${{ secrets.CSC_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

- [ ] **Step 4: Build an unsigned installer locally to verify packaging**

Run: `pnpm -C desktop dist`
Expected: electron-builder produces an artifact under `desktop/release/` (e.g. a `.dmg`/`.zip` on macOS). It is unsigned (a warning about missing identity is expected and acceptable for v1).

- [ ] **Step 5: Smoke-test the packaged app finds the core via extraResources**

Open the built app from `desktop/release/`. Expected: the window loads the UI, proving `resolveCoreEntry` found `resources/core/index.js`.

- [ ] **Step 6: Commit**

```bash
git add desktop/electron-builder.yml desktop/build/entitlements.mac.plist .github/workflows/desktop-release.yml
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "build(desktop): add electron-builder packaging and release workflow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Docs and manual smoke checklist

**Files:**
- Create: `desktop/README.md`
- Modify: `README.md` (add a short "Desktop app" pointer near the Quickstart)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Write `desktop/README.md`**

````markdown
# AgentGem Desktop

A native Electron host for AgentGem. The main process starts the existing
AgentGem server on a private localhost port and loads its UI in a window,
adding a native folder picker, app menu, system tray, and (scaffolded)
auto-update.

## Develop

```bash
pnpm -C desktop install
pnpm -C desktop dev      # builds the core + desktop, launches Electron with devtools
```

## Test

```bash
pnpm -C desktop test
```

## Package

```bash
pnpm -C desktop dist     # unsigned local installer under desktop/release/
```

## Signing (scaffolded, not wired)

Set these env vars (or CI secrets) to produce signed/notarized builds; absent,
builds are unsigned:

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
- Windows: `CSC_LINK`, `CSC_KEY_PASSWORD`

Release CI triggers on a `desktop-v*` tag (`.github/workflows/desktop-release.yml`).

## Manual smoke checklist

1. `pnpm -C desktop dev` → an AgentGem window opens with the UI.
2. Click **Browse** → a native directory dialog opens; pick a folder → the
   candidate populates.
3. Build a Gem end-to-end → the save dialog uses the native picker.
4. Close the window → the app hides to the tray (server keeps running).
5. Tray → **Open AgentGem** restores the window; tray → **Quit** exits and
   releases the port.
6. Launch a second instance → it focuses the existing window (no second server).
7. With no published release, **File → Check for Updates…** no-ops gracefully
   (no crash).
````

- [ ] **Step 2: Add a pointer in the root `README.md`**

After the Quickstart section, add:

```markdown
### Desktop app

Prefer a double-click app over the CLI? A native Electron build lives in
[`desktop/`](desktop/README.md): `pnpm -C desktop dev` to run it, or
`pnpm -C desktop dist` to package an installer.
```

- [ ] **Step 3: Run the full desktop test suite once more**

Run: `pnpm -C desktop test`
Expected: all tests from Tasks 1–7 PASS.

- [ ] **Step 4: Commit**

```bash
git add desktop/README.md README.md
git -c user.name="Raymond Feng" -c user.email="raymond@ninemind.ai" commit -m "docs(desktop): add desktop README and smoke checklist

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Thin host over existing server → Tasks 4, 9. ✓
- `desktop/` self-contained, root untouched → Tasks 1, 11 (extraResources, no root edits except the optional README pointer in Task 12, which does not affect the npm tarball). ✓
- Port 0 / read back → Task 2 (`getFreePort`) + Task 4. ✓
- CJS main + dynamic import of ESM core (`module: node16`) → Tasks 1 (tsconfig), 4. ✓
- Native folder picker returning `{ path }` → Tasks 5, 8, 9, 10. ✓
- App menu + shortcuts → Task 6, 9. ✓
- System tray (status/open/quit, hide-to-tray) → Task 9. ✓
- Auto-update, GitHub provider, launch + menu check → Tasks 7, 9, 11. ✓
- Signing scaffolded not wired (env vars, entitlements, hardenedRuntime, CI) → Task 11. ✓
- Build targets dmg/zip/nsis/AppImage → Task 11. ✓
- Error handling: showErrorBox + clean exit, single-instance, stop on quit → Task 9. ✓
- Testing: unit tests for pure helpers + manual smoke → Tasks 2–7, 12. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N"; every code step shows full code. The app icon is an explicit placeholder by design (real art is out of scope), called out in Task 9. ✓

**Type consistency:** `EmbeddedServer { url, stop }` produced in Task 4, consumed in Task 9. `pickFolderResult`/`PICK_FOLDER`/`UPDATE_EVENT` defined in Task 5, consumed in Tasks 8, 9. `buildMenuTemplate(opts)` signature consistent across Tasks 6 and 9. `updaterFeed`/`configureUpdater` from Task 7 consumed in Task 9. `DESKTOP_NAME` from Task 1 used in Task 9. ✓
