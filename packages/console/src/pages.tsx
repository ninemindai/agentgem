// The composable seam: add a screen with one import + one array entry.
import type { ConsolePage } from "./registry.js";
import { observePage } from "./panels/Observe/index.js";
import { sessionsPage } from "./panels/Sessions/index.js";
import { recallPage } from "./panels/Recall/index.js";
import { setupPage } from "./panels/Setup/index.js";
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
import { memoryPage } from "./panels/Memory/index.js";
import { deployPage } from "./panels/Deploy/index.js";
import { chatPage } from "./panels/Chat/index.js";
import { watchPage } from "./panels/Watch/index.js";
import { playPage } from "./panels/Play/index.js";
import { arcadePage } from "./panels/Arcade/index.js";
import { reviewsPage } from "./panels/Reviews/index.js";
import { extraPages } from "./extraPages.js";

// Yours / Received / Get-more are folded into the single tabbed `gemsPage` (Variant B);
// their component bodies are reused inside packages/console/src/panels/Gems/Gems.tsx.
export const corePages: ConsolePage[] = [observePage, sessionsPage, recallPage, setupPage, watchPage, rubricsPage, dreamingPage, benchmarkPage, optimizePage, minePage, curatePage, materializePage, gemsPage, publishPage, reviewsPage, sourcesPage, rubricLibraryPage, settingsPage, memoryPage, deployPage, chatPage, playPage, arcadePage];

// The composed list the shell renders. corePages is the open-core set; extraPages
// is empty in OSS and alias-swapped by a downstream build (see extraPages.ts).
export const pages: ConsolePage[] = [...corePages, ...extraPages];
