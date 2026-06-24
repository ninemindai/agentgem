import { contextBridge, ipcRenderer } from "electron";

// Channel names are inlined (not imported from ./ipc.js) because the renderer is
// sandboxed (Electron's default): a sandboxed preload can only require "electron"
// and cannot load sibling modules, so importing ./ipc.js throws and the bridge
// below never runs. Keep these two literals in sync with ./ipc.ts (the canonical
// source the main process imports).
const PICK_FOLDER = "agentgem:pick-folder";
const UPDATE_EVENT = "agentgem:update";

// contextIsolation is on; expose only a minimal, typed surface to the page.
contextBridge.exposeInMainWorld("agentgem", {
  pickFolder: (): Promise<{ path: string | null }> => ipcRenderer.invoke(PICK_FOLDER),
  onUpdate: (cb: (info: { status: string }) => void): void => {
    ipcRenderer.on(UPDATE_EVENT, (_e, info) => cb(info));
  },
});
