// The composable seam: add a screen with one import + one array entry.
import type { ConsolePage } from "./registry.js";
import { observePage } from "./panels/Observe/index.js";
import { sessionsPage } from "./panels/Sessions/index.js";
import { setupPage } from "./panels/Setup/index.js";
import { insightsPage } from "./panels/Insights/index.js";
import { rubricsPage } from "./panels/Rubrics/index.js";
import { rubricLibraryPage } from "./panels/RubricLibrary/index.js";
import { dreamingPage } from "./panels/Dreaming/index.js";
import { benchmarkPage } from "./panels/Benchmark/index.js";
import { optimizePage } from "./panels/Optimize/index.js";
import { minePage } from "./panels/Mine/index.js";
import { curatePage } from "./panels/Curate/index.js";
import { materializePage } from "./panels/Materialize/index.js";
import { gemsPage } from "./panels/Gems/index.js";
import { publishPage } from "./panels/Publish/index.js";
import { sourcesPage } from "./panels/Sources/index.js";
import { settingsPage } from "./panels/Settings/index.js";
import { deployPage } from "./panels/Deploy/index.js";
import { chatPage } from "./panels/Chat/index.js";
import { watchPage } from "./panels/Watch/index.js";
import { playPage } from "./panels/Play/index.js";

// Yours / Received / Get-more are folded into the single tabbed `gemsPage` (Variant B);
// their component bodies are reused inside packages/console/src/panels/Gems/Gems.tsx.
export const pages: ConsolePage[] = [observePage, sessionsPage, setupPage, watchPage, insightsPage, rubricsPage, dreamingPage, benchmarkPage, optimizePage, minePage, curatePage, materializePage, gemsPage, publishPage, sourcesPage, rubricLibraryPage, settingsPage, deployPage, chatPage, playPage];
