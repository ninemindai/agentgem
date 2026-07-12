import { useEffect, useState } from "react";
import { makeApi, defaultApiBase } from "./api";
import { makeAuth, type Me } from "./auth";
import { makeStars } from "./stars";
import { makeReviews } from "./reviews";
import { Router } from "./Router";
import { navigate } from "./nav";
import { IconMiniapps, IconIngredients, IconGems, IconSources, IconPublish, IconMyApps } from "./icons";

const api = makeApi(defaultApiBase());
const auth = makeAuth(defaultApiBase());
const starsApi = makeStars(defaultApiBase());
const reviewsApi = makeReviews(defaultApiBase());

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [me, setMe] = useState<Me | null>(null);
  const [theme, setTheme] = useState(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));
  const [signInError, setSignInError] = useState<string | null>(null);

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
      navigate(href);
    };
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onPop);
    return () => { alive = false; document.removeEventListener("click", onClick); window.removeEventListener("popstate", onPop); };
  }, []);

  const onGems = path.startsWith("/gems");
  // Home ("/") is Miniapps; "/minigames" is the old path we still serve. `startsWith("/ingredient")`
  // deliberately covers both the "/ingredients" board and an "/ingredient/:id" detail page.
  const onMiniapps = path === "/" || path.startsWith("/miniapps") || path.startsWith("/minigames");
  const onSources = path.startsWith("/sources");
  const onIngredients = path.startsWith("/ingredient");
  const onMyApps = path === "/my-apps";
  const signOut = async () => { await auth.logout(); setMe(null); };
  // Surface a failed sign-in (misconfigured provider, rate-limit, 5xx, network error) instead of
  // the click having zero visible effect — this is the primary login path, shared by the header
  // link and every loginUrl-triggered prompt (StarButton, review prompts, Team Pulse sign-in).
  const signIn = (provider: "github" | "google" = "github") => {
    setSignInError(null);
    auth.signIn(provider, window.location.href).catch((err) => setSignInError(err instanceof Error ? err.message : String(err)));
  };
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
          <a href="/miniapps" className={"ex-navlink" + (onMiniapps ? " is-active" : "")}><IconMiniapps />Miniapps</a>
          <a href="/ingredients" className={"ex-navlink" + (onIngredients ? " is-active" : "")}><IconIngredients />Ingredients</a>
          <a href="/gems" className={"ex-navlink" + (onGems ? " is-active" : "")}><IconGems />Gems</a>
          <a href="/sources" className={"ex-navlink" + (onSources ? " is-active" : "")}><IconSources />Sources</a>
          {me && <a href="/publish" className="ex-navlink"><IconPublish />Publish</a>}
          {me && <a href="/my-apps" className={"ex-navlink" + (onMyApps ? " is-active" : "")}><IconMyApps />My apps</a>}
        </nav>
        <span className="ex-auth">
          <button type="button" className="ex-theme-toggle" aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggleTheme}>
            <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
          </button>
          {me ? (
            <>
              {me.handle ? (
                <a className="ex-me" href={`/@${me.handle}`} title="Your profile">
                  {me.avatarUrl && <img className="ex-avatar" src={me.avatarUrl} alt="" width={20} height={20} />}
                  <span className="ex-login">{me.name}</span>
                </a>
              ) : (
                <span className="ex-me" title="Claim a handle from Publish to get a profile page">
                  {me.avatarUrl && <img className="ex-avatar" src={me.avatarUrl} alt="" width={20} height={20} />}
                  <span className="ex-login">{me.name}</span>
                </span>
              )}
              <a className="ex-navlink" href="/account">Account</a>
              <button type="button" className="ex-signout" onClick={signOut}>Sign out</button>
            </>
          ) : (
            <>
              <a className="ex-signin" href="#" onClick={(e) => { e.preventDefault(); signIn("github"); }}>Sign in with GitHub</a>
              <a className="ex-signin" href="#" onClick={(e) => { e.preventDefault(); signIn("google"); }}>Sign in with Google</a>
            </>
          )}
        </span>
      </header>
      {signInError && <p className="ex-error" role="alert" style={{ margin: "0 24px 16px" }}>Sign-in failed: {signInError}</p>}
      <main className="ex-main"><Router api={api} me={me} stars={{ signedIn: !!me, loginUrl: signIn, api: starsApi }} reviews={{ signedIn: !!me, loginUrl: signIn, api: reviewsApi }} /></main>
      <footer className="ex-footer">Early testbed — accounts, stars, and reviews may be reset. Trusted-adoption data, k-anonymized. <a href="https://agentgem.ai">agentgem.ai</a></footer>
    </div>
  );
}
