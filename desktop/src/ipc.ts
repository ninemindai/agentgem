// Shared channel names + the dialog→REST shape mapper, kept free of electron
// imports so it is unit-testable in a plain node environment.
export const PICK_FOLDER = "agentgem:pick-folder";
export const UPDATE_EVENT = "agentgem:update";
export const NOTIFY = "agentgem:notify";

export function pickFolderResult(r: { canceled: boolean; filePaths: string[] }): {
  path: string | null;
} {
  if (r.canceled || r.filePaths.length === 0) return { path: null };
  return { path: r.filePaths[0] };
}

export function notifyPayload(arg: unknown): { title: string; body: string } | null {
  if (!arg || typeof arg !== "object") return null;
  const { title, body } = arg as { title?: unknown; body?: unknown };
  if (typeof title !== "string" || typeof body !== "string") return null;
  return { title, body };
}
