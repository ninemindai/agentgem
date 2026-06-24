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
