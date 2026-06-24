import { pathToFileURL } from "node:url";
import { getFreePort } from "./net.js";
import { coreEntryCandidates, resolveCoreEntry } from "./core.js";

export interface EmbeddedServer {
  url: string;
  stop: () => Promise<void>;
}

interface CoreApp {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  restServer: Promise<{ url: string }>;
}
interface CoreModule {
  createApp(port: number): Promise<CoreApp>;
}

// Dynamically import the ESM core from CommonJS main. tsconfig module=node16
// preserves this import() instead of rewriting it to require() (which would
// throw ERR_REQUIRE_ESM against the ESM core).
export async function startEmbeddedServer(
  mainDir: string,
  resourcesPath: string,
): Promise<EmbeddedServer> {
  const entry = resolveCoreEntry(coreEntryCandidates(mainDir, resourcesPath));
  const mod = (await import(pathToFileURL(entry).href)) as CoreModule;
  const port = await getFreePort();
  const app = await mod.createApp(port);
  await app.start();
  const server = await app.restServer;
  return {
    url: server.url,
    stop: async () => {
      await app.stop();
    },
  };
}
