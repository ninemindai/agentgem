import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "./shell/Shell.js";
import { pages } from "./pages.js";
import "./shell/theme.css";

const el = document.getElementById("root");
if (el) createRoot(el).render(<StrictMode><Shell pages={pages} apiBase="" /></StrictMode>);
