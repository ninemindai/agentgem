// The composable seam: add a screen with one import + one array entry.
import type { ConsolePage } from "./registry.js";
import { ledgerPage } from "./panels/Ledger/index.js";
import { workspacesPage } from "./panels/Workspaces/index.js";

export const pages: ConsolePage[] = [ledgerPage, workspacesPage];
