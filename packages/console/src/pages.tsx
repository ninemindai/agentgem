// The composable seam: add a screen with one import + one array entry.
import type { ConsolePage } from "./registry.js";
import { ledgerPage } from "./panels/Ledger/index.js";

export const pages: ConsolePage[] = [ledgerPage];
