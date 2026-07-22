import { lazy, Suspense, useEffect, useState } from "react";
import { AskView } from "./views/AskView";

const DashboardView = lazy(() =>
  import("./views/DashboardView").then((m) => ({ default: m.DashboardView })),
);

type Route = "ask" | "results";

const routeFromHash = (): Route =>
  window.location.hash === "#/results" ? "results" : "ask";

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="wordmark" href="#/">
            tos-rag
          </a>
          <span className="topbar-sub">
            An empirical study of RAG pipeline design
          </span>
          <nav aria-label="Primary">
            <a
              className="nav-link"
              href="#/"
              aria-current={route === "ask" ? "page" : undefined}
            >
              Ask the corpus
            </a>
            <a
              className="nav-link"
              href="#/results"
              aria-current={route === "results" ? "page" : undefined}
            >
              Results
            </a>
          </nav>
          <span className="config-chip">
            winning config <strong>sentence × 256</strong>
          </span>
        </div>
      </header>
      <main id="main">
        {route === "ask" ? (
          <AskView />
        ) : (
          <Suspense
            fallback={
              <div className="loading-row">
                <span className="dot" aria-hidden="true" /> Loading results…
              </div>
            }
          >
            <DashboardView />
          </Suspense>
        )}
      </main>
      <footer className="footer">
        <div className="footer-inner">
          <span>
            Corpus: GitHub Terms of Service (CC0) · Netflix Terms of Use
            (excerpted for research)
          </span>
          <span>
            Laxmi Lamichhane &amp; Sudha Paudel · Gandaki College of Engineering
            and Science
          </span>
        </div>
      </footer>
    </>
  );
}
