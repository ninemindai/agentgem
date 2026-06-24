import type { MenuItemConstructorOptions } from "electron";

export interface MenuOpts {
  platform: NodeJS.Platform;
  isDev: boolean;
  appName: string;
  onCheckUpdates: () => void;
}

// Role-based template: Electron supplies the native behavior/labels for roles,
// so copy/paste/quit/reload work without manual accelerator wiring.
export function buildMenuTemplate(opts: MenuOpts): MenuItemConstructorOptions[] {
  const { platform, isDev, appName, onCheckUpdates } = opts;
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

  // Build the macOS app menu explicitly (rather than role:"appMenu") so the
  // About/Hide/Quit items carry the product name. The bold app-menu *title* and
  // the Dock name still come from the running bundle's CFBundleName — "Electron"
  // in an unpackaged dev run, correct in the packaged AgentGem.app.
  if (platform === "darwin") {
    template.unshift({
      label: appName,
      submenu: [
        { role: "about", label: `About ${appName}` },
        { type: "separator" },
        { role: "hide", label: `Hide ${appName}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${appName}` },
      ],
    });
  }
  return template;
}
