import { defineConsolePage } from "../../registry.js";
import { Gems } from "./Gems.js";

export { Gems } from "./Gems.js";

export const gemsPage = defineConsolePage({
  id: "gems",
  title: "Gems",
  icon: "💎",
  order: 30,
  phase: "build",
  category: "setup",
  route: "#/gems",
  component: ({ apiBase }) => <Gems apiBase={apiBase} />,
});
