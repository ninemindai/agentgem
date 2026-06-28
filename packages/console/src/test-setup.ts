import { afterEach } from "vitest";
import { resetGem } from "./activeGem.js";

// Reset the active-Gem store between tests so module-level singleton state
// does not leak across test cases (equivalent to useState resetting per mount).
afterEach(() => resetGem());
