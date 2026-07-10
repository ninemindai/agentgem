import { describe, it, expect } from "vitest";
import { ensureClientShim } from "../migrate.js";
import { MCP_CLIENT_MARKER } from "../mcpAppClient.js";

// A stored v1 miniapp: old marker, game logic that reads agentgemApp.
const V1 = `<!doctype html><html><head><script>
// agentgem:mcp-app-client
(function(){ window.agentgemApp = { callTool(){}, onNotification(){} }; })();
</script></head><body><script>
window.agentgemApp.onNotification("ui/notifications/tool-result", function (p) {
  if (p && p.toolName === "agentgem_get_session_data") { boot(p.chunk); }
});
</script></body></html>`;

describe("shim v2 migration", () => {
  it("uses a versioned marker", () => {
    expect(MCP_CLIENT_MARKER).toBe("agentgem:mcp-app-client:2");
  });
  it("replaces a v1 shim region with v2, leaving game logic byte-identical", () => {
    const out = ensureClientShim(V1);
    expect(out).toContain("agentgem:mcp-app-client:2");
    expect(out).not.toContain("// agentgem:mcp-app-client\n"); // the old marker line is gone
    // The game-logic script (the onNotification block) is untouched.
    expect(out).toContain(`if (p && p.toolName === "agentgem_get_session_data") { boot(p.chunk); }`);
  });
});
