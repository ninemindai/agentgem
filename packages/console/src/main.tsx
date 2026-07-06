import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./shell/Shell.js";
import { pages } from "./pages.js";
import "./shell/theme.css";

// Cold-start default: Observe › Inspect (the reorg is Observe-first). Was #/your-gems.
if (!window.location.hash) window.location.hash = "#/inspect";

const el = document.getElementById("root");
if (el) createRoot(el).render(<StrictMode><Shell pages={pages} apiBase="" /></StrictMode>);
