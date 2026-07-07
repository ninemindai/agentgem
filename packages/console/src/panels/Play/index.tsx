// packages/console/src/panels/Play/index.tsx
import { useState } from "react";
import { defineConsolePage } from "../../contract.js";
import { Arcade } from "./Arcade.js";
import { Composer } from "./Composer.js";
import { Studio } from "./Studio.js";

type View = { kind: "arcade" } | { kind: "composer" } | { kind: "studio"; name: string };

export function Play({ apiBase }: { apiBase: string }) {
  const [view, setView] = useState<View>({ kind: "arcade" });
  return (
    <section className="analyze">
      {view.kind !== "studio" && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button className={`ledger-search${view.kind === "arcade" ? " is-active" : ""}`} style={{ width: "auto", marginBottom: 0 }} onClick={() => setView({ kind: "arcade" })}>Arcade</button>
          <button className={`ledger-search${view.kind === "composer" ? " is-active" : ""}`} style={{ width: "auto", marginBottom: 0 }} onClick={() => setView({ kind: "composer" })}>+ New miniapp</button>
        </div>
      )}
      {view.kind === "arcade" && <Arcade apiBase={apiBase} onOpen={(name) => setView({ kind: "studio", name })} />}
      {view.kind === "composer" && <Composer apiBase={apiBase} onCreated={(name) => setView({ kind: "studio", name })} />}
      {view.kind === "studio" && <Studio apiBase={apiBase} name={view.name} onBack={() => setView({ kind: "arcade" })} />}
    </section>
  );
}

export const playPage = defineConsolePage({
  id: "play", title: "Play", icon: "🎮", order: 35,
  phase: "build", category: "setup",
  route: "#/play",
  component: ({ apiBase }) => <Play apiBase={apiBase} />,
});
