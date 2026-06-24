# Desktop app

AgentGem ships as a native **desktop app** (macOS, Windows, Linux) in addition to
the `npx` CLI. It's the same Gem Builder — the desktop app just hosts the local
AgentGem server for you and opens it in its own window, so there's no terminal and
no `localhost` URL to manage.

Under the hood it's a thin [Electron](https://www.electronjs.org/) host: the app's
main process starts the normal AgentGem server on a private `127.0.0.1` port and
points a window at it. Every REST endpoint, the MCP surface, and the web UI work
exactly as they do over `npx` — secrets still never leave your machine.

## Download

Grab the latest build from the
[**Releases**](https://github.com/ninemindai/agentgem/releases) page (look for a
`desktop-v*` release):

| Platform | File |
| --- | --- |
| macOS (Apple Silicon / Intel) | `AgentGem-<version>-arm64.dmg` · `AgentGem-<version>.dmg` |
| Windows | `AgentGem-Setup-<version>.exe` |
| Linux | `AgentGem-<version>.AppImage` |

> **The builds are currently unsigned.** Code-signing and notarization are
> scaffolded but not yet wired, so your OS will warn on first launch:
>
> - **macOS** — right-click the app and choose **Open** (or **System Settings →
>   Privacy & Security → Open Anyway**) the first time.
> - **Windows** — on the SmartScreen prompt, choose **More info → Run anyway**.
>
> If you'd rather not run an unsigned build, [run it from source](#run-from-source)
> instead.

## What you get

- **Native folder picker** — choose your agent project with the OS folder dialog
  instead of typing a path.
- **App menu & shortcuts** — standard menu bar with `Cmd/Ctrl+R` reload and native
  copy/paste.
- **System tray** — closing the window hides the app to the tray and keeps the
  server running; reopen or quit from the tray icon.
- **Auto-update** — scaffolded via GitHub Releases; it activates once signed
  builds are published.

Everything else — building, publishing, merging, and deploying Gems — is identical
to the web UI.

## Run from source

The desktop app lives in [`desktop/`](https://github.com/ninemindai/agentgem/tree/main/desktop)
as a self-contained package:

```bash
git clone https://github.com/ninemindai/agentgem.git
cd agentgem
pnpm -C desktop install
pnpm -C desktop dev      # builds the core + desktop, launches the app
```

`pnpm -C desktop test` runs the desktop unit tests. See the
[`desktop/` README](https://github.com/ninemindai/agentgem/blob/main/desktop/README.md)
for the full developer workflow.

## Build an installer

```bash
pnpm -C desktop dist     # unsigned installers under desktop/release/
```

This bundles the core into a self-contained file, ships the app's assets and its
runtime dependencies, and packages a `.dmg`/`.zip` (macOS), `.exe` (Windows), or
`.AppImage` (Linux) with [electron-builder](https://www.electron.build/). To
produce signed builds, set the signing environment variables
(`CSC_LINK`, `APPLE_ID`, …) documented in the `desktop/` README; absent them the
build is unsigned.

## How it works

The packaged app can't ship the loose server `dist/` — it's an ES module with its
own dependency tree — so the build **bundles the core** into a single
self-contained file (with its runtime peers alongside) that the Electron main
process loads on startup. The window then loads the local server's URL. This means
the desktop app is never a fork of the web UI: it's the same server, hosted.

## Troubleshooting

- **"AgentGem can't be opened" / SmartScreen** — see the unsigned-build note under
  [Download](#download).
- **Window is blank or the app won't start** — the app shows the underlying error
  in a dialog. Rebuild from source (`pnpm -C desktop dev`) to see the full logs.
- **A second launch focuses the existing window** — that's intentional; AgentGem
  is single-instance so you never run two servers at once.
