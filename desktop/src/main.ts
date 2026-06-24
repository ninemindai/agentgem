import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { autoUpdater } from "electron-updater";
import type { Tray } from "electron";
import { startEmbeddedServer, type EmbeddedServer } from "./server.js";
import { PICK_FOLDER, UPDATE_EVENT, pickFolderResult } from "./ipc.js";
import { buildMenuTemplate } from "./menu.js";
import { configureUpdater, updaterFeed, repoUrlFromPackageJson } from "./updater.js";
import { createTray } from "./tray.js";
import { DESKTOP_NAME } from "./version.js";

const isDev = process.env.AGENTGEM_DEV === "1";

// macOS surfaces app.name in the menu bar (the bold app menu) and dock. Running
// raw electron in dev it would default to "Electron"; packaged builds get it from
// productName. Set it before whenReady so dev is branded consistently too.
app.setName(DESKTOP_NAME);

// Packaged: extraResources puts the icon at resources/icon.png. Dev: it sits
// next to the build dir two levels up from desktop/dist.
function resolveIconPath(): string {
  const candidates = [
    join(process.resourcesPath, "icon.png"),
    join(__dirname, "..", "build", "icon.png"),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];
}
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
  // Set the update feed explicitly from package.json's repository field. If that
  // fails (missing/odd repository), fall back to the publish config baked into
  // app-update.yml by electron-builder at package time.
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    autoUpdater.setFeedURL(updaterFeed(repoUrlFromPackageJson(pkg)));
  } catch {
    /* keep the baked-in app-update.yml feed */
  }
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

  const iconPath = resolveIconPath();
  tray = createTray({ onOpen: showWindow, onQuit: () => app.quit(), iconPath });

  if (!isDev) setupUpdates();
}

// Single-instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox("AgentGem failed to start", String((err as Error)?.message ?? err));
    app.exit(1);
  });
  app.on("activate", () => {
    if (win) showWindow();
  });
  app.on("window-all-closed", () => {
    // Stay alive in the tray; do not quit on window close.
  });
  app.on("before-quit", (e) => {
    if (quitting) return;              // second pass after cleanup — let it exit
    e.preventDefault();
    quitting = true;
    tray?.destroy();
    const finish = () => app.exit(0);
    if (server) server.stop().then(finish, finish);
    else finish();
  });
}
