// The composable seam: add a screen with one import + one array entry.
import type { ConsolePage } from "./registry.js";
import { observePage } from "./panels/Observe/index.js";
import { insightsPage } from "./panels/Insights/index.js";
import { rubricsPage } from "./panels/Rubrics/index.js";
import { rubricLibraryPage } from "./panels/RubricLibrary/index.js";
import { dreamingPage } from "./panels/Dreaming/index.js";
import { benchmarkPage } from "./panels/Benchmark/index.js";
import { optimizePage } from "./panels/Optimize/index.js";
import { minePage } from "./panels/Mine/index.js";
import { curatePage } from "./panels/Curate/index.js";
import { materializePage } from "./panels/Materialize/index.js";
import { workspacesPage } from "./panels/Workspaces/index.js";
import { publishPage } from "./panels/Publish/index.js";
import { getGemsPage } from "./panels/GetGems/index.js";
import { sourcesPage } from "./panels/Sources/index.js";
import { settingsPage } from "./panels/Settings/index.js";
import { receivedPage } from "./panels/Received/index.js";
import { deployPage } from "./panels/Deploy/index.js";
import { chatPage } from "./panels/Chat/index.js";
import { watchPage } from "./panels/Watch/index.js";

export const pages: ConsolePage[] = [observePage, watchPage, insightsPage, rubricsPage, dreamingPage, benchmarkPage, optimizePage, minePage, curatePage, materializePage, workspacesPage, publishPage, getGemsPage, sourcesPage, rubricLibraryPage, settingsPage, receivedPage, deployPage, chatPage];
