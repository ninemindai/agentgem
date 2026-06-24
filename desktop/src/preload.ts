import { contextBridge, ipcRenderer } from "electron";
import { PICK_FOLDER, UPDATE_EVENT } from "./ipc.js";

// contextIsolation is on; expose only a minimal, typed surface to the page.
contextBridge.exposeInMainWorld("agentgem", {
  pickFolder: (): Promise<{ path: string | null }> => ipcRenderer.invoke(PICK_FOLDER),
  onUpdate: (cb: (info: { status: string }) => void): void => {
    ipcRenderer.on(UPDATE_EVENT, (_e, info) => cb(info));
  },
});
