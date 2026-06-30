import { useEffect, useState } from "react";
import { makeApi, defaultApiBase } from "./api";
import { makeAuth, type Me } from "./auth";
import { Router } from "./Router";

const api = makeApi(defaultApiBase());
const auth = makeAuth(defaultApiBase());

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    let alive = true;
    auth.getMe().then((m) => { if (alive) setMe(m); });
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
    return () => { alive = false; document.removeEventListener("click", onClick); window.removeEventListener("popstate", onPop); };
  }, []);

  const onGems = path.startsWith("/gems");
  const signOut = async () => { await auth.logout(); setMe(null); };

  return (
    <div className="ex-app">
      <header className="ex-header">
        <a href="/" className="ex-brand">AgentGem Explore</a>
        <nav className="ex-nav">
          <a href="/" className={"ex-navlink" + (onGems ? "" : " is-active")}>Ingredients</a>
          <a href="/gems" className={"ex-navlink" + (onGems ? " is-active" : "")}>Gems</a>
        </nav>
        <span className="ex-auth">
          {me ? (
            <>
              {me.avatarUrl && <img className="ex-avatar" src={me.avatarUrl} alt="" width={20} height={20} />}
              <span className="ex-login">{me.login}</span>
              <button type="button" className="ex-signout" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <a className="ex-signin" href={auth.loginUrl(window.location.href)}>Sign in with GitHub</a>
          )}
        </span>
      </header>
      <main className="ex-main"><Router api={api} /></main>
      <footer className="ex-footer">Trusted-adoption data, k-anonymized. <a href="https://agentgem.ai">agentgem.ai</a></footer>
    </div>
  );
}
