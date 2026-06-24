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
