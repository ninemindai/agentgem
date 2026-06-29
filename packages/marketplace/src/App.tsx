import { useEffect } from "react";
import { makeApi, defaultApiBase } from "./api";
import { Router } from "./Router";

const api = makeApi(defaultApiBase());

export function App() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/") || a.target === "_blank" || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return (
    <div className="ex-app">
      <header className="ex-header"><a href="/" className="ex-brand">AgentGem Explore</a></header>
      <main className="ex-main"><Router api={api} /></main>
      <footer className="ex-footer">Trusted-adoption data, k-anonymized. <a href="https://agentgem.ai">agentgem.ai</a></footer>
    </div>
  );
}
