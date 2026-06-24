// Shared channel names + the dialog→REST shape mapper, kept free of electron
// imports so it is unit-testable in a plain node environment.
export const PICK_FOLDER = "agentgem:pick-folder";
export const UPDATE_EVENT = "agentgem:update";

export function pickFolderResult(r: { canceled: boolean; filePaths: string[] }): {
  path: string | null;
} {
  if (r.canceled || r.filePaths.length === 0) return { path: null };
  return { path: r.filePaths[0] };
}
