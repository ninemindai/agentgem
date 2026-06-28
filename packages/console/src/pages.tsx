// The composable seam: add a screen with one import + one array entry.
import type { ConsolePage } from "./registry.js";
import { testbedPage } from "./panels/Testbed/index.js";
import { ledgerPage } from "./panels/Ledger/index.js";
import { workspacesPage } from "./panels/Workspaces/index.js";
import { getGemsPage } from "./panels/GetGems/index.js";

export const pages: ConsolePage[] = [testbedPage, ledgerPage, workspacesPage, getGemsPage];
