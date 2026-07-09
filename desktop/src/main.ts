import { app, BrowserWindow, Menu, dialog, ipcMain, shell, Notification } from "electron";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { autoUpdater } from "electron-updater";
import type { Tray } from "electron";
import { startEmbeddedServer, type EmbeddedServer } from "./server.js";
import { PICK_FOLDER, UPDATE_EVENT, NOTIFY, pickFolderResult, notifyPayload } from "./ipc.js";
import { buildMenuTemplate } from "./menu.js";
import { configureUpdater, updaterFeed, repoUrlFromPackageJson } from "./updater.js";
import { createTray } from "./tray.js";
import { DESKTOP_NAME } from "./version.js";
import { deepLinkHash, argvDeepLink, DEEP_LINK_SCHEME } from "./deeplink.js";

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

// A web "Open in AgentGem" link (agentgem://get-gems?q=<key>) → focus the window and route the loaded
// console to the matching hash. A cold start via the link reaches here before the window exists, so
// stash it for boot() to flush once createWindow has run.
let pendingDeepLink: string | null = null;
function handleDeepLink(rawUrl: string): void {
  const hash = deepLinkHash(rawUrl);
  if (!hash) return;
  if (!win) { pendingDeepLink = rawUrl; return; }
  showWindow();
  const nav = () => { void win?.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {}); };
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", nav);
  else nav();
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
  // Open external links (window.open, target=_blank, e.g. the GitHub device-flow
  // sign-in page) in the user's default browser instead of an in-app Electron
  // window. GitHub's Google sign-in and passkeys/WebAuthn don't work in an
  // Electron BrowserWindow, so the loopback console must hand http(s) URLs to the
  // real browser. Everything else is denied (no in-app popups).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
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

  // Renderer-requested OS notification. Native Notification needs no permission
  // and no HTTPS in the main process. Clicking it surfaces the window.
  ipcMain.on(NOTIFY, (_e, arg: unknown) => {
    if (!Notification.isSupported()) return;
    const p = notifyPayload(arg);
    if (!p) return;
    const n = new Notification({ title: p.title, body: p.body });
    n.on("click", () => showWindow());
    n.show();
  });

  try {
    server = await startEmbeddedServer(join(__dirname), process.resourcesPath);
  } catch (err) {
    dialog.showErrorBox("AgentGem failed to start", String((err as Error)?.message ?? err));
    app.exit(1);
    return;
  }

  await createWindow(server.url);

  // Flush a deep link that arrived before the window existed: a macOS open-url stashed during launch,
  // or (Windows/Linux) the agentgem:// URL passed as a cold-start argument.
  const initialLink = pendingDeepLink ?? argvDeepLink(process.argv);
  pendingDeepLink = null;
  if (initialLink) handleDeepLink(initialLink);

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        platform: process.platform,
        isDev,
        appName: DESKTOP_NAME,
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
  // Register agentgem:// so the OS routes "Open in AgentGem" links to this app. macOS delivers them
  // via open-url (which can fire before the window is ready → handleDeepLink stashes it); Windows/
  // Linux deliver them as a launch arg on the second instance (argv) or the cold-start argv above.
  //
  // Packaged only. Unpackaged, process.execPath is node_modules/electron/dist/Electron.app, so this
  // hands the whole scheme to a bare Electron.app: every agentgem:// link then opens a blank Electron
  // (or whichever dev checkout registered last), not AgentGem — and it keeps winning after the dev run
  // exits, because the LaunchServices claim outlives the process. The packaged app declares the scheme
  // via CFBundleURLTypes (electron-builder `protocols`), so this call only promotes it to default.
  if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  app.on("open-url", (event, url) => { event.preventDefault(); handleDeepLink(url); });
  app.on("second-instance", (_event, argv) => {
    showWindow();
    const link = argvDeepLink(argv);
    if (link) handleDeepLink(link);
  });
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
