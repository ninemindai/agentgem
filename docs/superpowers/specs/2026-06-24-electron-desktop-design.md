# AgentGem Desktop (Electron) — Design

**Date:** 2026-06-24
**Branch:** `desktop-electron` (worktree `../agentgem-desktop`)
**Status:** Approved design, pre-implementation

## Goal

Wrap AgentGem in a native desktop app that delivers **both** a zero-friction
install (double-click, no `npx`/server management) **and** native desktop
integrations (folder picker, app menu, system tray, auto-update). The desktop
app is a thin host over the existing AgentGem server — not a UI rewrite.

## Architecture — thin host over the existing server

The Electron **main process** loads the already-built AgentGem core and calls the
existing `createApp(port)` on an ephemeral localhost port (`127.0.0.1`, port `0`
→ OS-assigned), starts it, then opens a `BrowserWindow` pointed at
`http://127.0.0.1:<port>/`. The renderer is the existing web UI. REST,
MCP-over-HTTP, and the API explorer keep working unchanged.

```
┌─ Electron main (Node) ───────────────┐
│  createApp(0) → RestApplication       │   ← existing src/index.ts, untouched
│  app.start() → 127.0.0.1:<port>       │
│  + native: dialog, Menu, Tray, updater│
│         ▲ IPC (preload, contextIsolated)
│  ┌─ BrowserWindow (Chromium) ───────┐ │
│  │  loadURL(127.0.0.1:<port>/)       │ │   ← existing index.html UI
│  └───────────────────────────────────┘ │
└───────────────────────────────────────┘
```

Key decisions:
- **Embed the server in the main process** (chosen over subprocess or pure-IPC):
  maximum reuse of REST/MCP surfaces, fewest moving parts.
- **Port `0`**, then read back `server.address().port`, to avoid collisions with a
  stray `agentgem` CLI or a second instance.
- The ESM core is loaded from CommonJS main via dynamic `import()`.

## Layout — self-contained `desktop/` (root npm package untouched)

```
desktop/
  package.json        # electron, electron-builder, electron-updater (own install)
  tsconfig.json       # compiles desktop/src → desktop/dist (CommonJS)
  src/
    main.ts           # app lifecycle, start server, window, menu, tray, updater
    preload.ts        # contextBridge: expose pickFolder + update events to renderer
    menu.ts           # app menu (File/Edit/View/Window) + shortcuts
    tray.ts           # tray icon, status, open/quit
    updater.ts        # electron-updater wiring (GitHub provider)
    server.ts         # acquire port + start embedded core, stop on quit
  build/              # icons (icns/ico/png), entitlements.mac.plist
  electron-builder.yml
```

- `desktop/` resolves the core from the repo root via `file:..` (or a direct path
  to `../dist`). The root `package.json`, its `files` array, and the published npm
  tarball are **not modified** — Electron deps never ship to npm.
- `desktop/` is **not** a pnpm workspace member: it gets its own isolated
  `node_modules` so electron-builder can prune/pack cleanly and Electron's large
  binaries stay out of the lean library that publishes to npm.

## Native features (all in v1)

- **Folder picker.** Today `src/pickFolder.ts` shells out to
  `osascript`/`zenity`/`powershell` (fragile, esp. Linux `zenity`). Under Electron
  we expose `dialog.showOpenDialog({ properties: ['openDirectory'] })` via a
  `preload` `contextBridge`. The UI prefers `window.agentgem?.pickFolder` when
  present and falls back to the existing REST `/pick-folder` in a plain browser.
  One small, guarded change to `src/public/index.html`; server code untouched.
- **App menu + shortcuts.** Role-based menu (File/Edit/View/Window):
  Cmd/Ctrl+R reload, Cmd/Ctrl+Q quit, native copy/paste/selectall,
  View→toggle devtools (dev only).
- **System tray.** Tray icon shows server status (●/○), "Open AgentGem", "Quit".
  Closing the window hides to tray; Quit fully exits and stops the server.
- **Auto-update.** `electron-updater` with the GitHub Releases provider; checks on
  launch + a menu item. Update-available/-downloaded surfaced via a small renderer
  toast over IPC.

## Build & distribution

- **TypeScript:** `desktop/` compiles its own `src → dist` as CommonJS (simplest
  for Electron main); the bundled core is ESM, loaded via dynamic `import()`.
- **Packaging:** electron-builder. Targets: `dmg` + `zip` (mac, x64 + arm64),
  `nsis` (Windows), `AppImage` (Linux). Config in `electron-builder.yml`.
- **Signing/notarization — scaffolded, not wired.** `electron-builder.yml`
  references `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env vars, with
  `entitlements.mac.plist` and `hardenedRuntime: true` ready. Local builds run
  unsigned until credentials are supplied. A `.github/workflows/desktop-release.yml`
  publishes to GitHub Releases, gated on those secrets.
- **Scripts** in `desktop/package.json`: `dev` (build core + launch electron with
  devtools), `build`, `dist` (electron-builder), `release`.

## Error handling

- If the embedded server fails to start, main shows `dialog.showErrorBox` with the
  cause and quits cleanly (no zombie window).
- Single-instance lock (`app.requestSingleInstanceLock()`): a second launch focuses
  the existing window instead of starting a second server.
- On `window-all-closed` / `before-quit`: `await app.stop()` to release the port.

## Testing

- Unit-test pure helpers with vitest in `desktop/`: port acquisition, menu template
  builder, updater feed config, the `pickFolder` IPC contract shape.
- Full E2E Electron launch is **manual** for v1 (headless Electron in CI is heavy);
  ship a documented manual smoke checklist (launch → window loads UI → pick folder
  → build a Gem → tray open/quit → update check no-ops gracefully).

## Out of scope (v1)

- Real code-signing credentials / notarization execution.
- Deep-link / file-association handlers.
- In-app onboarding distinct from the existing web UI.
- Packaging the core *into* the app via asar rewrites beyond what electron-builder
  does by default.

## First implementation step

Already done: `git worktree add ../agentgem-desktop -b desktop-electron`. All work
happens in that worktree.
