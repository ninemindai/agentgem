// The build-time extension seam: OSS ships an empty list; a downstream build can
// point AGENTGEM_CONSOLE_EXTRA at a replacement module (esbuild onResolve plugin in
// build-client.mjs) to add screens without editing pages.tsx. Keep this file's
// shape (named `extraPages: ConsolePage[]`) stable — the plugin's redirect target must match it.
import type { ConsolePage } from "./registry.js";

export const extraPages: ConsolePage[] = [];
