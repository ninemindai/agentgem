import { useEffect, useState } from "react";
import { makeApi, defaultApiBase } from "./api";
import { makeAuth, type Me } from "./auth";
import { makeStars } from "./stars";
import { makeReviews } from "./reviews";
import { Router } from "./Router";

const api = makeApi(defaultApiBase());
const auth = makeAuth(defaultApiBase());
const starsApi = makeStars(defaultApiBase());
const reviewsApi = makeReviews(defaultApiBase());

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [me, setMe] = useState<Me | null>(null);
  const [theme, setTheme] = useState(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));

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
  const onSources = path.startsWith("/sources");
  const onIngredients = path === "/" || path.startsWith("/ingredient");
  const signOut = async () => { await auth.logout(); setMe(null); };
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
    setTheme(next);
  };

  return (
    <div className="ex-app">
      <header className="ex-header">
        <a href="/" className="ex-brand">AgentGem</a>
        <nav className="ex-nav">
          <a href="/" className={"ex-navlink" + (onIngredients ? " is-active" : "")}>Ingredients</a>
          <a href="/gems" className={"ex-navlink" + (onGems ? " is-active" : "")}>Gems</a>
          <a href="/sources" className={"ex-navlink" + (onSources ? " is-active" : "")}>Sources</a>
          {me && <a href="/publish" className="ex-navlink">Publish</a>}
        </nav>
        <span className="ex-auth">
          <button type="button" className="ex-theme-toggle" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggleTheme}>
            <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
          </button>
          {me ? (
            <>
              <a className="ex-me" href={`/@${me.login}`} title="Your profile">
                {me.avatarUrl && <img className="ex-avatar" src={me.avatarUrl} alt="" width={20} height={20} />}
                <span className="ex-login">{me.login}</span>
              </a>
              <button type="button" className="ex-signout" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <a className="ex-signin" href={auth.loginUrl(window.location.href)}>Sign in with GitHub</a>
          )}
        </span>
      </header>
      <main className="ex-main"><Router api={api} me={me} stars={{ signedIn: !!me, loginUrl: () => auth.loginUrl(window.location.href), api: starsApi }} reviews={{ signedIn: !!me, loginUrl: () => auth.loginUrl(window.location.href), api: reviewsApi }} /></main>
      <footer className="ex-footer">Trusted-adoption data, k-anonymized. <a href="https://agentgem.ai">agentgem.ai</a></footer>
    </div>
  );
}
