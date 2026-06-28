/** Decode a base64 string (e.g. the server's `tarGz`) to raw bytes for download. */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Trigger a browser download of `data` as `filename`. */
export function downloadBlob(filename: string, type: string, data: string | Uint8Array): void {
  const blob = new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Copy text to the clipboard (no-op-safe: callers ignore rejection). */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
