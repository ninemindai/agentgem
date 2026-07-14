import { app, BrowserWindow, Menu, dialog, ipcMain, shell, Notification, utilityProcess } from "electron";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { autoUpdater } from "electron-updater";
import type { Tray } from "electron";
import { startEmbeddedServer, type EmbeddedServer, type ForkCore } from "./server.js";
import { PICK_FOLDER, NOTIFY, pickFolderResult, notifyPayload } from "./ipc.js";
import { buildMenuTemplate, buildContextMenuTemplate } from "./menu.js";
import {
  createUpdateController,
  updaterFeed,
  repoUrlFromPackageJson,
  type UpdateController,
  type UpdateSurface,
} from "./updater.js";
import { createTray } from "./tray.js";
import { DESKTOP_NAME } from "./version.js";
import { deepLinkHash, deepLinkInstall, argvDeepLink, DEEP_LINK_SCHEME } from "./deeplink.js";

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
let updateController: UpdateController | null = null;
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

// An install link runs no code by itself — the archive is still lock-verified on import and the gem's
// agent still runs under the OS sandbox — but it does put an attacker-chosen gem on the machine with
// one click from any web page. Ask first, and default to Cancel so a stray Enter is safe.
async function confirmInstall(target: { key: string; version?: string }): Promise<boolean> {
  const version = target.version ? `@${target.version}` : "";
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Cancel", "Install"],
    defaultId: 0,
    cancelId: 0,
    title: "Install a Gem?",
    message: `Install ${target.key}${version}?`,
    detail:
      "A website asked AgentGem to install this Gem. Only continue if you trust the source — " +
      "a Gem can add skills, MCP servers and hooks to your agent setup.",
  });
  return response === 1;
}

function handleDeepLink(rawUrl: string): void {
  const hash = deepLinkHash(rawUrl);
  if (!hash) return;
  if (!win) { pendingDeepLink = rawUrl; return; }
  showWindow();
  const nav = () => { void win?.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {}); };
  const go = () => { if (win?.webContents.isLoading()) win.webContents.once("did-finish-load", nav); else nav(); };

  const install = deepLinkInstall(rawUrl);
  if (!install) { go(); return; }               // browse-only link: nothing is installed, no prompt.
  void confirmInstall(install).then((ok) => { if (ok) go(); });
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
  win.webContents.on("context-menu", (_e, params) => {
    const template = buildContextMenuTemplate(params);
    if (template.length && win) Menu.buildFromTemplate(template).popup({ window: win });
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

// Native dialogs for the update lifecycle. The renderer is intentionally not involved:
// these must be visible even before the console has loaded (a startup check can finish
// a download first), and a main-process dialog is guaranteed to show.
function makeUpdateSurface(): UpdateSurface {
  const box = (opts: Parameters<typeof dialog.showMessageBox>[0]) =>
    void dialog.showMessageBox({ title: DESKTOP_NAME, ...opts }).catch(() => {});
  return {
    upToDate: (version) =>
      box({
        type: "info",
        buttons: ["OK"],
        message: "You're up to date.",
        detail: `${DESKTOP_NAME} ${version || app.getVersion()} is the latest version.`,
      }),
    downloading: (version) =>
      box({
        type: "info",
        buttons: ["OK"],
        message: "An update is available.",
        detail: `Downloading ${DESKTOP_NAME} ${version}… you'll be prompted to restart when it's ready.`,
      }),
    ready: (version) => {
      void dialog
        .showMessageBox({
          type: "question",
          buttons: ["Later", "Restart now"],
          defaultId: 1,
          cancelId: 0,
          title: DESKTOP_NAME,
          message: "Update ready to install.",
          detail: `${DESKTOP_NAME} ${version} has been downloaded. Restart to apply it now?`,
        })
        .then(({ response }) => {
          if (response !== 1) return; // Later: the update installs on the next quit
          // Drain the core, then let electron-updater run the normal quit → swap → relaunch.
          // quitAndInstall() calls app.quit(); `quitting` lets before-quit pass through instead
          // of force-exiting via app.exit(), which would skip the install-on-quit hook.
          quitting = true;
          tray?.destroy();
          const relaunch = () => autoUpdater.quitAndInstall();
          if (server) void server.stop().then(relaunch, relaunch);
          else relaunch();
        })
        .catch(() => {});
    },
    failed: (err) =>
      box({ type: "error", buttons: ["OK"], message: "Update check failed.", detail: err?.message ?? String(err) }),
  };
}

function setupUpdates(): UpdateController {
  // Set the update feed explicitly from package.json's repository field. If that
  // fails (missing/odd repository), fall back to the publish config baked into
  // app-update.yml by electron-builder at package time.
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    autoUpdater.setFeedURL(updaterFeed(repoUrlFromPackageJson(pkg)));
  } catch {
    /* keep the baked-in app-update.yml feed */
  }
  return createUpdateController(autoUpdater, makeUpdateSurface());
}

// The core runs in a utility process, not on main's event loop. stdio must be "pipe"
// (it defaults to "inherit") or the child's ready line never reaches startEmbeddedServer.
// Electron reaps the child when the app exits, so a crashed host leaves no orphan.
const forkCore: ForkCore = (entry, env) =>
  utilityProcess.fork(entry, [], { stdio: "pipe", env, serviceName: "agentgem-core" });

// Every teardown path runs through here, and it sets `quitting` before the core can
// die. Electron reaps the utility process on the way out, and a SIGINT/SIGTERM aimed
// at the process group (dev ctrl-c, logout) reaches the core directly — either way the
// core exits 0, and without this flag onCrash would report that orderly exit as a crash.
function shutdown(code: number): void {
  if (quitting) return;                // already draining; the second pass just exits
  quitting = true;
  tray?.destroy();
  const finish = (): void => app.exit(code);
  if (server) void server.stop().then(finish, finish);
  else finish();
}

// The window is still up but everything behind it is gone: the renderer's next fetch
// would fail with no explanation. Say so, then exit rather than pretend.
function onCrash(code: number | null): void {
  if (quitting) return;                // we asked for this exit — it is not a crash
  dialog.showErrorBox("AgentGem stopped", `The AgentGem background service exited unexpectedly (code ${code}).`);
  shutdown(1);
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
    server = await startEmbeddedServer(join(__dirname), process.resourcesPath, { fork: forkCore, onCrash });
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

  updateController = setupUpdates();

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        platform: process.platform,
        isDev,
        appName: DESKTOP_NAME,
        onCheckUpdates: () => {
          // electron-updater can't update an unpackaged build (dev run) — a manual check would
          // just error with "not packed". Say so plainly instead of a confusing failure dialog.
          if (!app.isPackaged) {
            void dialog
              .showMessageBox({
                type: "info",
                buttons: ["OK"],
                title: DESKTOP_NAME,
                message: "Updates are disabled in development.",
                detail: "Run a packaged build to test auto-update.",
              })
              .catch(() => {});
            return;
          }
          updateController?.check({ manual: true });
        },
      }),
    ),
  );

  const iconPath = resolveIconPath();
  tray = createTray({ onOpen: showWindow, onQuit: () => app.quit(), iconPath });

  // Silent startup check: a found update downloads in the background and prompts to restart
  // when ready. Skipped in dev, where the app is unpackaged and can't self-update.
  if (!isDev) updateController.check();
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
    shutdown(0);
  });
  // ctrl-c in dev, and logout/restart, signal the whole process group: the core drains
  // itself and exits 0. Claim the quit here so that orderly exit isn't read as a crash.
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => shutdown(0));
}
