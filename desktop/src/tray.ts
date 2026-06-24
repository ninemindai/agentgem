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
