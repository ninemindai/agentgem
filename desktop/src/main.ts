import { app, BrowserWindow, Menu, dialog, ipcMain } from "electron";
import { join } from "node:path";
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
