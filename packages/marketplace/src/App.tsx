import { useEffect, useState } from "react";
import { makeApi, defaultApiBase } from "./api";
import { Router } from "./Router";

const api = makeApi(defaultApiBase());

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/") || href.startsWith("//") || a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPop);
    return () => { document.removeEventListener("click", onClick); window.removeEventListener("popstate", onPop); };
  }, []);

  const onGems = path.startsWith("/gems");
  return (
    <div className="ex-app">
      <header className="ex-header">
        <a href="/" className="ex-brand">AgentGem Explore</a>
        <nav className="ex-nav">
          <a href="/" className={"ex-navlink" + (onGems ? "" : " is-active")}>Ingredients</a>
          <a href="/gems" className={"ex-navlink" + (onGems ? " is-active" : "")}>Gems</a>
        </nav>
      </header>
      <main className="ex-main"><Router api={api} /></main>
      <footer className="ex-footer">Trusted-adoption data, k-anonymized. <a href="https://agentgem.ai">agentgem.ai</a></footer>
    </div>
  );
}
