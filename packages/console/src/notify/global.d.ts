import type { AgentGemBridge } from "./osNotify.js";

declare global {
  interface Window {
    agentgem?: AgentGemBridge;
  }
}

export {};
