export class NotSignedIn extends Error { constructor() { super("not signed in"); this.name = "NotSignedIn"; } }

// FileReader.readAsDataURL is the browser-safe way to base64 a File (no Buffer / no
// String.fromCharCode spread overflow). Strip the "data:...;base64," prefix.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("could not read the file"));
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(",") + 1)); };
    r.readAsDataURL(file);
  });
}

export function makeUpload(base: string) {
  return {
    async publish(args: { file: File; scope: string; version: string; name?: string; tags?: string[] }): Promise<{ ref: string; version: string; path: string }> {
      const bytesBase64 = await fileToBase64(args.file);
      const r = await fetch(base + "/api/registry/upload-publish", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: args.scope, version: args.version, name: args.name, tags: args.tags, bytesBase64 }),
      });
      if (r.status === 401) throw new NotSignedIn();
      if (!r.ok) throw new Error(await r.text());
      return JSON.parse(await r.text()) as { ref: string; version: string; path: string };
    },
  };
}
