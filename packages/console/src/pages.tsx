// The composable seam: add a screen with one import + one array entry.
import type { ConsolePage } from "./registry.js";
import { curatePage } from "./panels/Curate/index.js";
import { materializePage } from "./panels/Materialize/index.js";
import { workspacesPage } from "./panels/Workspaces/index.js";
import { getGemsPage } from "./panels/GetGems/index.js";
import { settingsPage } from "./panels/Settings/index.js";
import { receivedPage } from "./panels/Received/index.js";
import { deployPage } from "./panels/Deploy/index.js";
import { insightsPage } from "./panels/Insights/index.js";

export const pages: ConsolePage[] = [curatePage, materializePage, workspacesPage, getGemsPage, settingsPage, receivedPage, deployPage, insightsPage];
