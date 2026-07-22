import { lazy, Suspense, useEffect, useState } from "react";
import { Skeleton, TooltipProvider, cn } from "@tos-rag/ui";
import { AskView } from "./views/AskView";

const DashboardView = lazy(() =>
  import("./views/DashboardView").then((m) => ({ default: m.DashboardView })),
);

type Route = "ask" | "results";

const routeFromHash = (): Route =>
  window.location.hash === "#/results" ? "results" : "ask";

const NAV = [
  { href: "#/", label: "Ask the corpus", route: "ask" as const },
  { href: "#/results", label: "Results", route: "results" as const },
];

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
      <a
        className="bg-primary text-primary-foreground absolute -left-[9999px] top-0 z-50 px-4 py-2 focus:left-2 focus:top-2"
        href="#main"
      >
        Skip to content
      </a>

      <header className="border-border bg-background border-b">
        <div className="mx-auto flex max-w-[1140px] flex-wrap items-center gap-6 px-6 py-4">
          <a
            href="#/"
            className="text-foreground text-xl font-bold tracking-[-0.01em] no-underline"
          >
            tos-rag
          </a>
          <span className="text-ink-soft text-[13px]">
            An empirical study of RAG pipeline design
          </span>
          <nav aria-label="Primary" className="ml-auto flex gap-1">
            {NAV.map((item) => {
              const current = route === item.route;
              return (
                <a
                  key={item.href}
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "group relative rounded px-3 pb-2.5 pt-1.5 text-sm font-medium no-underline transition-colors",
                    current
                      ? "text-foreground"
                      : "text-ink-soft hover:text-foreground",
                  )}
                >
                  {item.label}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "bg-primary absolute inset-x-3 bottom-1 h-0.5 origin-left transition-transform duration-150",
                      current ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100",
                    )}
                  />
                </a>
              );
            })}
          </nav>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-[1140px] px-6 pb-22 pt-12">
        {route === "ask" ? (
          <AskView />
        ) : (
          <Suspense
            fallback={
              <div role="status" aria-label="Loading results">
                <Skeleton className="h-12 w-80" />
                <Skeleton className="mt-6 h-32 w-full max-w-md" />
                <Skeleton className="mt-10 h-64 w-full" />
              </div>
            }
          >
            <DashboardView />
          </Suspense>
        )}
      </main>

      <footer className="border-border text-muted-foreground border-t text-[12.5px]">
        <div className="mx-auto flex max-w-[1140px] flex-wrap gap-4 px-6 py-5">
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
    </TooltipProvider>
  );
}
