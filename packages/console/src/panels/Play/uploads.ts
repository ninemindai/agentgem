// packages/console/src/panels/Play/uploads.ts
import { useState } from "react";

export type Upload = { name: string; bytesBase64: string; type: string; size: number; role: "ship" | "reference" };

export const SHIP_MAX_FILE = 500_000, SHIP_MAX_TOTAL = 1_000_000, REF_MAX_FILE = 5_000_000, REF_MAX_TOTAL = 15_000_000, MAX_FILES = 20;

function fileToBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onerror = () => rej(new Error(`could not read ${f.name}`));
    r.onload = () => res(String(r.result).replace(/^data:[^;]*;base64,/, ""));
    r.readAsDataURL(f);
  });
}

export function uploadsError(u: Upload[]): string {
  const ship = u.filter((x) => x.role === "ship"), ref = u.filter((x) => x.role === "reference");
  if (ship.some((x) => x.size > SHIP_MAX_FILE)) return "a ship file exceeds 500 KB (it must inline into the miniapp)";
  if (ship.reduce((n, x) => n + x.size, 0) > SHIP_MAX_TOTAL) return "ship files exceed 1 MB total";
  if (ref.some((x) => x.size > REF_MAX_FILE)) return "a reference file exceeds 5 MB";
  if (ref.reduce((n, x) => n + x.size, 0) > REF_MAX_TOTAL) return "reference files exceed 15 MB total";
  return "";
}

// Preamble for the CREATE path (raw staged names). The mid-session path uses uploadsPreambleFromStored
// (routes.ts) with the server's actual stored names instead.
export function uploadsPreamble(u: Upload[]): string {
  if (!u.length) return "";
  const ship = u.filter((x) => x.role === "ship").map((x) => x.name);
  const ref = u.filter((x) => x.role === "reference").map((x) => x.name);
  const lines: string[] = [];
  if (ship.length) lines.push(`Ship files (inline into index.html): ${ship.join(", ")} — data: URIs are in ./uploads/assets.json.`);
  if (ref.length) lines.push(`Reference files (context only, do not ship): ${ref.join(", ")} in ./ref/.`);
  return `I've added files to this project's workspace.\n${lines.join("\n")}`;
}

export function useUploads() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState("");

  async function addUploads(list: FileList | null | undefined) {
    if (!list?.length) return;
    const seen = new Set(uploads.map((u) => u.name));
    const additions: Upload[] = [];
    for (const f of Array.from(list)) {
      if (seen.has(f.name)) { setError(`duplicate filename skipped: ${f.name}`); continue; }
      if (uploads.length + additions.length >= MAX_FILES) { setError(`at most ${MAX_FILES} files`); break; }
      seen.add(f.name);
      additions.push({ name: f.name, bytesBase64: await fileToBase64(f), type: f.type, size: f.size, role: "ship" });
    }
    if (!additions.length) return;
    setUploads((prev) => {
      const prevNames = new Set(prev.map((u) => u.name));
      const merged = [...prev];
      for (const a of additions) if (!prevNames.has(a.name)) { prevNames.add(a.name); merged.push(a); }
      return merged;
    });
  }
  const setRole = (name: string, role: "ship" | "reference") => setUploads((u) => u.map((x) => (x.name === name ? { ...x, role } : x)));
  const remove = (name: string) => setUploads((u) => u.filter((x) => x.name !== name));
  const payload = () => (uploads.length ? { files: uploads.map(({ name, bytesBase64, type, role }) => ({ name, bytesBase64, type, role })) } : {});
  const reset = () => { setUploads([]); setError(""); };

  return { uploads, addUploads, setRole, remove, error, setError, limitError: () => uploadsError(uploads), payload, preamble: () => uploadsPreamble(uploads), reset };
}
