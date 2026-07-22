# "Annotated Brief" UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the tos-rag web app (app shell, ask view, dashboard) into the approved "Annotated Brief" design — an annotated-legal-document aesthetic with a light/dark theme toggle — per `docs/superpowers/specs/2026-07-18-ui-redesign-design.md`.

**Architecture:** Pure frontend change inside `apps/web`. All colors move to CSS custom properties defined on `:root` (light) and overridden on `:root[data-theme="dark"]`; a small pure module (`lib/theme.ts`) resolves the theme from localStorage + OS preference and a `useTheme` hook in `App.tsx` applies it via `data-theme` on `<html>`. Markup changes are class/structure tweaks in 5 components; SVG charts switch hardcoded hex fills to `var(--token)` so they theme automatically.

**Tech Stack:** React 18 + Vite + TypeScript, plain CSS (single `styles.css`), vitest. No new dependencies.

## Global Constraints

- **NEVER run `git commit` or `git add`. The user commits manually.** At the end of each task, report what changed instead.
- No new npm dependencies.
- `apps/backend`, `packages/core`, and `apps/web/src/lib/{api,citations,format,sample}.ts` must not change. `lib/scale.ts` may only have its `SEQ_RAMP` hex values swapped — signatures and logic untouched.
- All existing aria attributes, the skip link, and `:focus-visible` styles must survive every task.
- Verification commands (run from repo root): `pnpm --filter web test` (must pass), `pnpm --filter web build` (must succeed).
- Fonts stay as-is: Zilla Slab (display), Public Sans (body), IBM Plex Mono (data). Already imported in `src/main.tsx`.
- `styles.css` is organized in commented sections (`/* ————— shell ————— */` etc.). Each task replaces one section wholesale; do not leave duplicate rules behind.

---

### Task 1: Theme resolution module + toggle wiring

**Files:**
- Create: `apps/web/src/lib/theme.ts`
- Create: `apps/web/test/theme.test.ts`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `resolveTheme(stored: string | null, prefersDark: boolean): Theme`, `nextTheme(theme: Theme): Theme`, `type Theme = "light" | "dark"` from `src/lib/theme.ts`; `<html data-theme="light|dark">` set at runtime; a `.theme-toggle` button in the topbar (styled in Task 3).

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/theme.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { nextTheme, resolveTheme } from "../src/lib/theme";

describe("resolveTheme", () => {
  test("stored explicit theme wins over OS preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  test("falls back to OS preference when nothing stored", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
  });
  test("garbage in storage falls back to OS preference", () => {
    expect(resolveTheme("blue", true)).toBe("dark");
    expect(resolveTheme("", false)).toBe("light");
  });
});

describe("nextTheme", () => {
  test("toggles between light and dark", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter web test`
Expected: FAIL — `Cannot find module '../src/lib/theme'` (or equivalent resolve error).

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/lib/theme.ts`:

```ts
export type Theme = "light" | "dark";

/** Stored explicit preference wins; otherwise follow the OS. */
export function resolveTheme(
  stored: string | null,
  prefersDark: boolean,
): Theme {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

export function nextTheme(theme: Theme): Theme {
  return theme === "light" ? "dark" : "light";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter web test`
Expected: PASS — 16 previous tests + 4 new = 20 passed.

- [ ] **Step 5: Wire the hook and toggle button into App.tsx**

Replace the entire contents of `apps/web/src/App.tsx` with:

```tsx
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { AskView } from "./views/AskView";
import { nextTheme, resolveTheme, type Theme } from "./lib/theme";

const DashboardView = lazy(() =>
  import("./views/DashboardView").then((m) => ({ default: m.DashboardView })),
);

type Route = "ask" | "results";

const routeFromHash = (): Route =>
  window.location.hash === "#/results" ? "results" : "ask";

const THEME_KEY = "tos-rag-theme";

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {
      // storage unavailable (private mode) — fall through to OS preference
    }
    return resolveTheme(
      stored,
      window.matchMedia("(prefers-color-scheme: dark)").matches,
    );
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next = nextTheme(t);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // non-persistent is fine
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [theme, toggleTheme] = useTheme();

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
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={
              theme === "light" ? "Switch to dark theme" : "Switch to light theme"
            }
          >
            {theme === "light" ? "☾" : "☀"}
          </button>
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
```

- [ ] **Step 6: Verify tests and build**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: 20 tests PASS; build succeeds.

- [ ] **Step 7: Checkpoint (no commit)**

Report changed files. Do NOT commit (user commits manually).

---

### Task 2: Design tokens and base styles

**Files:**
- Modify: `apps/web/src/styles.css:1-84` (the token block through `.skip-link:focus`)

**Interfaces:**
- Consumes: `data-theme` attribute from Task 1.
- Produces: the token vocabulary every later task uses: `--paper --panel --card --ink --ink-soft --ink-faint --rule --rule-soft --marker --marker-wash --marker-soft --marker-text --rule-red --rule-red-faint --baseline --chart-blue --chart-aqua --chart-grid --chart-axis --font-display --font-body --font-mono --w-max`.

- [ ] **Step 1: Replace the token + base section**

In `apps/web/src/styles.css`, replace everything from line 1 through the `.skip-link:focus` rule (currently lines 1–84) with:

```css
/* ————————————————————————————————————————————————
   tos-rag design tokens — "annotated brief"
   warm paper + ink · highlighter marks · editor's-red rules
   themes: light "paper" / dark "desk lamp" via [data-theme]
   ———————————————————————————————————————————————— */
:root {
  --paper: #f7f4ec;
  --panel: #efeadd;
  --card: #fffdf6;
  --ink: #1f2630;
  --ink-soft: #57606e;
  --ink-faint: #83898f;
  --rule: #d9d3c4;
  --rule-soft: #e8e3d6;

  --marker: #ffe14d; /* solid marks: underlines, flags, swatches */
  --marker-wash: #ffe14d; /* text-highlight fill (translucent in dark) */
  --marker-soft: #fff3b0;
  --marker-text: #1f2630; /* text painted on solid marker */

  --rule-red: #b5432e; /* editor's red: thin rules, stamps, errors only */
  --rule-red-faint: rgba(181, 67, 46, 0.45);
  --baseline: rgba(31, 38, 48, 0.06); /* ruled-paper lines */

  --chart-blue: #2a78d6;
  --chart-aqua: #1baf7a;
  --chart-grid: #e1e0d9;
  --chart-axis: #c3c2b7;

  --font-display: "Zilla Slab", "Iowan Old Style", serif;
  --font-body: "Public Sans Variable", "Public Sans", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", monospace;

  --w-max: 1140px;

  color-scheme: light;
}

:root[data-theme="dark"] {
  --paper: #16181d;
  --panel: #1d2026;
  --card: #1b1e24;
  --ink: #e9e5da;
  --ink-soft: #aaa79d;
  --ink-faint: #7c7a72;
  --rule: #363a42;
  --rule-soft: #272b32;

  --marker: #e6c33c;
  --marker-wash: rgba(230, 195, 60, 0.3);
  --marker-soft: rgba(230, 195, 60, 0.14);

  --rule-red: #d96a52;
  --rule-red-faint: rgba(217, 106, 82, 0.5);
  --baseline: rgba(233, 229, 218, 0.05);

  --chart-blue: #5b9be0;
  --chart-aqua: #3fc492;
  --chart-grid: #2c2f36;
  --chart-axis: #4c515a;

  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-body);
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}

h1,
h2,
h3 {
  font-family: var(--font-display);
  font-weight: 700;
  line-height: 1.15;
  margin: 0;
}

a {
  color: inherit;
}

button,
input {
  font: inherit;
  color: inherit;
}

:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
  border-radius: 2px;
}

.skip-link {
  position: absolute;
  left: -9999px;
  top: 0;
  background: var(--marker);
  color: var(--marker-text);
  padding: 8px 16px;
  z-index: 100;
}
.skip-link:focus {
  left: 8px;
  top: 8px;
}
```

- [ ] **Step 2: Verify tests and build**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: 20 tests PASS; build succeeds. (The page still references old class styles below this section — that's fine; later tasks replace them.)

- [ ] **Step 3: Checkpoint (no commit)**

Report changed files. Do NOT commit.

---

### Task 3: App shell — topbar as document header, footer as colophon

**Files:**
- Modify: `apps/web/src/styles.css` — replace the entire `/* ————— shell ————— */` section (from that comment up to, not including, `/* ————— ask view ————— */`)

**Interfaces:**
- Consumes: tokens from Task 2; `.theme-toggle` button markup from Task 1.
- Produces: final shell classes `.topbar .topbar-inner .wordmark .topbar-sub .nav-link .config-chip .theme-toggle main .footer .footer-inner`.

- [ ] **Step 1: Replace the shell section**

```css
/* ————— shell ————— */
.topbar {
  border-bottom: 1px solid var(--rule);
  background: var(--paper);
}
.topbar-inner {
  max-width: var(--w-max);
  margin: 0 auto;
  padding: 14px 24px;
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}
.wordmark {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 22px;
  letter-spacing: 0.01em;
  text-decoration: none;
  background: linear-gradient(
    transparent 62%,
    var(--marker-wash) 62%,
    var(--marker-wash) 94%,
    transparent 94%
  );
  padding: 0 2px;
}
.topbar-sub {
  font-size: 12.5px;
  color: var(--ink-soft);
  letter-spacing: 0.02em;
}
.topbar nav {
  margin-left: auto;
  display: flex;
  gap: 4px;
}
.nav-link {
  position: relative;
  border: none;
  background: none;
  padding: 6px 12px 9px;
  font-size: 14px;
  font-weight: 500;
  color: var(--ink-soft);
  cursor: pointer;
  border-radius: 3px;
  text-decoration: none;
}
.nav-link::after {
  content: "";
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 4px;
  height: 3px;
  background: var(--marker);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform 0.22s ease;
}
.nav-link:hover {
  color: var(--ink);
}
.nav-link:hover::after,
.nav-link[aria-current="page"]::after {
  transform: scaleX(1);
}
.nav-link[aria-current="page"] {
  color: var(--ink);
}

/* rubber-stamp config chip */
.config-chip {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--rule-red);
  border: 1.5px solid var(--rule-red-faint);
  border-radius: 4px;
  padding: 4px 10px;
  white-space: nowrap;
  transform: rotate(-1deg);
}
.config-chip strong {
  color: inherit;
  font-weight: 600;
}

.theme-toggle {
  border: 1px solid var(--rule);
  background: var(--card);
  color: var(--ink-soft);
  border-radius: 999px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
}
.theme-toggle:hover {
  border-color: var(--ink);
  color: var(--ink);
}

main {
  max-width: var(--w-max);
  margin: 0 auto;
  padding: 40px 24px 80px;
}

/* colophon */
.footer {
  border-top: 1px solid var(--rule);
  color: var(--ink-faint);
  font-size: 12.5px;
}
.footer-inner {
  max-width: var(--w-max);
  margin: 0 auto;
  padding: 18px 24px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
```

- [ ] **Step 2: Verify tests and build**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: 20 tests PASS; build succeeds.

- [ ] **Step 3: Visual sanity check**

Run: `pnpm --filter web dev` — open the printed localhost URL. Verify: wordmark has a highlighter swipe, active nav link shows a yellow underline, hovering the other nav link draws its underline, config chip reads as a slightly rotated red stamp, theme toggle flips the whole page dark and back, choice persists on reload. Stop the dev server.

- [ ] **Step 4: Checkpoint (no commit)**

Report changed files. Do NOT commit.

---

### Task 4: Ask view — hero annotation, folder tabs, writing-line form, ledger exchange

**Files:**
- Modify: `apps/web/src/views/AskView.tsx`
- Modify: `apps/web/src/styles.css` — replace the entire `/* ————— ask view ————— */` section (up to, not including, `/* ————— evidence panel ————— */`)

**Interfaces:**
- Consumes: tokens from Task 2. `parseCitations`, `formatMs`, `EvidenceCard` unchanged.
- Produces: classes `.ask-hero .marker-stroke .offset-note .doc-chips .doc-chip .ask-form .ask-input .ask-button .ask-layout .suggestions .suggestion .exchange .exchange-q .answer .answer-abstained .stamp .verbatim .cite-chip .answer-meta .loading-row .error-note`. Evidence-panel classes are Task 5's.

- [ ] **Step 1: Update AskView markup**

In `apps/web/src/views/AskView.tsx` make exactly these three edits (everything else stays):

Edit A — hero (replace the `<section className="ask-hero">…</section>` block):

```tsx
      <section className="ask-hero">
        <h1>
          Ask the Terms of Service.
          <svg
            className="marker-stroke"
            viewBox="0 0 220 12"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d="M3 9 C 60 4, 150 3, 217 6" />
          </svg>
        </h1>
        <p>
          Answers come only from the frozen corpus, and every retrieved clause
          carries its exact character offsets.
        </p>
        <p className="offset-note">
          chunk.text === canonical.slice(start, end)
        </p>
      </section>
```

Edit B — abstention (replace the `<div className="answer-abstained">…</div>` block):

```tsx
                <div className="answer-abstained">
                  <span className="stamp">No answer in corpus</span>
                  The corpus doesn't answer this, so the model declined rather
                  than guess. Its reply, verbatim:{" "}
                  <span className="verbatim">{result.answer}</span>
                </div>
```

Edit C — loading copy (replace the `.loading-row` div's inner text only):

```tsx
            <div className="loading-row" role="status">
              <span className="dot" aria-hidden="true" />
              Retrieving clauses and generating…
            </div>
```

(Edit C is unchanged markup — keep it exactly as shown; the bar look comes from CSS.)

- [ ] **Step 2: Replace the ask-view CSS section**

```css
/* ————— ask view ————— */
.ask-hero {
  max-width: 620px;
}
.ask-hero h1 {
  font-size: clamp(30px, 4.5vw, 44px);
}
.marker-stroke {
  display: block;
  width: 250px;
  max-width: 70%;
  height: 12px;
  margin-top: 8px;
}
.marker-stroke path {
  fill: none;
  stroke: var(--marker);
  stroke-width: 7;
  stroke-linecap: round;
}
.ask-hero p {
  color: var(--ink-soft);
  margin: 12px 0 0;
  font-size: 16.5px;
}
/* margin-annotation bubble with caret */
.ask-hero .offset-note {
  position: relative;
  display: inline-block;
  margin-top: 14px;
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--ink-soft);
  background: var(--card);
  border: 1px solid var(--rule);
  border-left: 3px solid var(--marker);
  border-radius: 0 6px 6px 0;
  padding: 6px 12px;
}
.ask-hero .offset-note::before {
  content: "";
  position: absolute;
  top: -6px;
  left: 14px;
  width: 10px;
  height: 10px;
  background: var(--card);
  border-left: 1px solid var(--rule);
  border-top: 1px solid var(--rule);
  transform: rotate(45deg);
}

/* file-folder tabs sitting on the question card */
.doc-chips {
  display: flex;
  gap: 6px;
  margin: 28px 0 0;
  padding: 0 12px;
  flex-wrap: wrap;
}
.doc-chip {
  position: relative;
  top: 1px;
  border: 1px solid var(--rule);
  border-bottom: none;
  background: var(--panel);
  color: var(--ink-soft);
  border-radius: 8px 8px 0 0;
  padding: 7px 16px 9px;
  font-size: 13.5px;
  cursor: pointer;
}
.doc-chip[aria-pressed="true"] {
  background: var(--card);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 0 3px 0 var(--marker);
}

/* paper card with a ruled writing line */
.ask-form {
  display: flex;
  gap: 12px;
  margin-bottom: 34px;
  background: var(--card);
  border: 1px solid var(--rule);
  border-radius: 0 10px 10px 10px;
  padding: 16px;
}
.ask-input {
  flex: 1;
  border: none;
  border-bottom: 1.5px solid var(--rule);
  background: transparent;
  border-radius: 0;
  padding: 10px 4px;
  font-size: 16px;
}
.ask-input::placeholder {
  color: var(--ink-faint);
}
.ask-input:focus {
  border-bottom-color: var(--ink);
  outline: none;
}
.ask-button {
  background: var(--ink);
  color: var(--paper);
  border: none;
  border-radius: 6px;
  padding: 0 22px;
  font-weight: 600;
  cursor: pointer;
}
.ask-button:hover {
  box-shadow: inset 0 -4px 0 var(--marker);
}
.ask-button:disabled {
  opacity: 0.5;
  cursor: default;
  box-shadow: none;
}

.ask-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 380px;
  gap: 40px;
  align-items: start;
}

.suggestions {
  border: 1px dashed var(--rule);
  border-radius: 8px;
  padding: 22px;
  color: var(--ink-soft);
}
.suggestions p {
  margin: 0 0 12px;
  font-size: 14.5px;
}
.suggestion {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-top: 1px solid var(--rule-soft);
  padding: 10px 2px;
  font-size: 15px;
  cursor: pointer;
  color: var(--ink);
}
.suggestion:hover {
  background: var(--panel);
}

/* the exchange: ruled legal pad with a red margin rule */
.exchange {
  margin-bottom: 30px;
  padding: 20px 22px 22px 26px;
  border-left: 2px solid var(--rule-red-faint);
  background: repeating-linear-gradient(
    to bottom,
    transparent 0,
    transparent 29px,
    var(--baseline) 29px,
    var(--baseline) 30px
  );
}
.exchange-q {
  font-weight: 600;
  font-size: 17px;
  margin: 0 0 14px;
}
.exchange-q::before {
  content: "Q.";
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--rule-red);
  margin-right: 10px;
}
.answer {
  font-size: 18px;
  line-height: 1.7;
  margin: 0;
}
.answer::before {
  content: "A.";
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--rule-red);
  margin-right: 10px;
}
.answer .marked {
  background: linear-gradient(
      transparent 58%,
      var(--marker-wash) 58%,
      var(--marker-wash) 96%,
      transparent 96%
    )
    left / 0% 100% no-repeat;
  animation: sweep 0.7s ease-out 0.15s forwards;
  padding: 0 1px;
}
@keyframes sweep {
  to {
    background-size: 100% 100%;
  }
}
.answer-abstained {
  border: 1.5px dashed var(--rule);
  border-radius: 8px;
  padding: 16px 18px;
  color: var(--ink-soft);
  font-size: 16px;
  background: var(--card);
}
.answer-abstained .stamp {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--rule-red);
  border: 1.5px solid var(--rule-red);
  border-radius: 3px;
  padding: 3px 9px;
  transform: rotate(-1.2deg);
  margin: 0 10px 10px 0;
}
.answer-abstained .verbatim {
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--ink);
}
/* superscript margin markers */
.cite-chip {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  background: var(--marker);
  color: var(--marker-text);
  border: 1px solid rgba(31, 38, 48, 0.25);
  border-radius: 3px;
  padding: 2px 5px;
  margin: 0 3px;
  vertical-align: super;
  cursor: pointer;
}
.cite-chip:hover,
.cite-chip.active {
  outline: 1.5px solid var(--ink);
}
/* docket line */
.answer-meta {
  margin-top: 14px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ink-faint);
  display: flex;
  gap: 0;
  flex-wrap: wrap;
}
.answer-meta span + span::before {
  content: "·";
  margin: 0 10px;
  color: var(--rule);
}

/* highlighter-bar loading over a ghost line */
.loading-row {
  display: flex;
  gap: 12px;
  align-items: center;
  color: var(--ink-soft);
  font-size: 14.5px;
}
.loading-row .dot {
  width: 110px;
  height: 11px;
  border-radius: 3px;
  background:
    linear-gradient(90deg, var(--marker) 0 38%, transparent 38%) left / 260%
      100% no-repeat,
    var(--rule-soft);
  animation: scan 1.2s linear infinite;
}
@keyframes scan {
  to {
    background-position: -160% 0, 0 0;
  }
}

.error-note {
  border-left: 3px solid var(--rule-red);
  background: var(--card);
  padding: 12px 16px;
  color: var(--ink-soft);
  font-size: 14.5px;
}
```

- [ ] **Step 3: Verify tests and build**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: 20 tests PASS; build succeeds.

- [ ] **Step 4: Visual sanity check**

Run: `pnpm --filter web dev`. Verify in BOTH themes: marker stroke under the headline; annotation bubble with caret; folder tabs merge into the question card (active tab has a yellow top bar); asking a suggestion shows Q./A. in red slab on ruled paper, highlight sweeps in, citation squares sit superscript and clicking one scrolls the evidence rail; the docket line separates entries with middots. Force an abstention-style check by visually inspecting the stamp styles (any question the corpus can't answer, e.g. "What is the capital of France?"). Stop the dev server.

- [ ] **Step 5: Checkpoint (no commit)**

Report changed files. Do NOT commit.

---

### Task 5: Evidence rail — excerpt cards with similarity meter and corner flag

**Files:**
- Modify: `apps/web/src/components/EvidenceCard.tsx`
- Modify: `apps/web/src/styles.css` — replace the entire `/* ————— evidence panel ————— */` section (up to, not including, `/* ————— dashboard ————— */`)

**Interfaces:**
- Consumes: tokens from Task 2; `Evidence` type from `lib/api` (unchanged: `{ docId, charStart, charEnd, text, score }`).
- Produces: classes `.evidence-panel .evidence-empty .clause-card .clause-head .clause-index .clause-offsets .clause-score .sim-meter .clause-text`; card ids stay `evidence-<n>` (AskView's flash depends on them).

- [ ] **Step 1: Update EvidenceCard markup**

Replace the entire contents of `apps/web/src/components/EvidenceCard.tsx` with:

```tsx
import type { Evidence } from "../lib/api";

interface Props {
  index: number;
  evidence: Evidence;
  cited: boolean;
  flashed: boolean;
}

const DOC_LABELS: Record<string, string> = {
  "github-tos": "GitHub ToS",
  "netflix-tou": "Netflix ToU",
};

/**
 * The signature element: a retrieved chunk rendered as an excerpted clause
 * with its character-offset provenance — chunk.text === canonical.slice(start, end).
 */
export function EvidenceCard({ index, evidence, cited, flashed }: Props) {
  const classes = [
    "clause-card",
    cited ? "cited" : "",
    flashed ? "flash" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const pct = Math.round(Math.min(1, Math.max(0, evidence.score)) * 100);
  return (
    <article className={classes} id={`evidence-${index}`}>
      <div className="clause-head">
        <span className="clause-index">{index}</span>
        <span>{DOC_LABELS[evidence.docId] ?? evidence.docId}</span>
        <span className="clause-offsets">
          §{evidence.charStart}–{evidence.charEnd}
        </span>
        <span
          className="clause-score"
          title="Cosine similarity to the question embedding"
        >
          <span className="sim-meter" aria-hidden="true">
            <span style={{ width: `${pct}%` }} />
          </span>
          sim {evidence.score.toFixed(2)}
        </span>
      </div>
      <p className="clause-text">{evidence.text}</p>
    </article>
  );
}
```

- [ ] **Step 2: Replace the evidence-panel CSS section**

```css
/* ————— evidence panel ————— */
.evidence-panel h2 {
  font-size: 15px;
  font-family: var(--font-mono);
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: 14px;
}
.evidence-empty {
  color: var(--ink-faint);
  font-size: 14px;
  border-left: 3px solid var(--rule);
  padding: 6px 14px;
}
.clause-card {
  position: relative;
  overflow: hidden;
  background: var(--card);
  border: 1px solid var(--rule-soft);
  border-left: 3px solid var(--rule);
  border-radius: 0 6px 6px 0;
  padding: 12px 14px;
  margin-bottom: 12px;
  animation: rise 0.35s ease-out both;
}
.clause-card:nth-child(2) {
  animation-delay: 0.05s;
}
.clause-card:nth-child(3) {
  animation-delay: 0.1s;
}
.clause-card:nth-child(4) {
  animation-delay: 0.15s;
}
.clause-card:nth-child(n + 5) {
  animation-delay: 0.2s;
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
.clause-card.cited {
  border-left-color: var(--marker);
}
/* folded marker-yellow corner flag on cited cards */
.clause-card.cited::after {
  content: "";
  position: absolute;
  top: 0;
  right: 0;
  border-style: solid;
  border-width: 0 16px 16px 0;
  border-color: transparent var(--marker) transparent transparent;
}
.clause-card.flash {
  border-left-color: var(--ink);
  background: var(--marker-soft);
}
.clause-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--ink-faint);
  margin-bottom: 7px;
  flex-wrap: wrap;
}
.clause-index {
  color: var(--ink);
  font-weight: 500;
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 1px 5px;
}
.clause-offsets {
  letter-spacing: 0.02em;
}
.clause-score {
  margin-left: auto;
  color: var(--ink-soft);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sim-meter {
  display: inline-block;
  width: 36px;
  height: 5px;
  border-radius: 2px;
  background: var(--rule-soft);
  overflow: hidden;
}
.sim-meter > span {
  display: block;
  height: 100%;
  background: var(--ink-soft);
}
/* clause text as a red-ruled quotation */
.clause-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--ink-soft);
  border-left: 2px solid var(--rule-red-faint);
  padding-left: 10px;
}
.clause-text::first-line {
  color: var(--ink);
}
```

- [ ] **Step 3: Verify tests and build**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: 20 tests PASS; build succeeds.

- [ ] **Step 4: Visual sanity check**

Run: `pnpm --filter web dev`. Ask a suggestion question; verify in BOTH themes: each card shows index chip, doc tag, `§start–end`, a small filled meter next to `sim 0.xx`; cards cited in the answer show a yellow left edge and a folded corner flag; clicking a citation flashes the card. Stop the dev server.

- [ ] **Step 5: Checkpoint (no commit)**

Report changed files. Do NOT commit.

---

### Task 6: Dashboard — lab-report sections, stamp band, marker-highlighted bests

**Files:**
- Modify: `apps/web/src/views/DashboardView.tsx`
- Modify: `apps/web/src/styles.css` — replace the entire `/* ————— dashboard ————— */` section (up to, not including, `/* ————— responsive ————— */`)

**Interfaces:**
- Consumes: tokens from Task 2; `formatMeanCI`, `formatUSD`, sample data, viz components — all unchanged signatures.
- Produces: classes `.dash-header .sample-banner .dash-section .eyebrow .table-scroll table.results .viz-card .viz-row .viz-title .viz-sub .legend .win-pill`; eyebrow copy gains § numbers.

- [ ] **Step 1: Update DashboardView markup**

In `apps/web/src/views/DashboardView.tsx` make exactly these edits:

Edit A — sample banner copy (replace the `{live === false && (...)}` block's inner div):

```tsx
        <div className="sample-banner" role="note">
          <strong>Illustrative data</strong>
          <span>
            Not experimental findings — the experiment hasn't run yet. These
            numbers only demonstrate the dashboard.
          </span>
        </div>
```

Edit B — section eyebrows get § numbers (change these five strings only):

- `<p className="eyebrow">Phase 1 · Chunking</p>` above `id="phase1-table"` → `<p className="eyebrow">§1 · Phase 1 — Chunking</p>`
- above `id="heatmap-h"` → `<p className="eyebrow">§2 · Phase 1 — Chunking</p>`
- above `id="factors-h"` → `<p className="eyebrow">§3 · Phase 1 — Chunking</p>`
- above `id="phase2-h"` → `<p className="eyebrow">§4 · Phase 2 — Generators</p>`
- above `id="latency-h"` → `<p className="eyebrow">§5 · Operational</p>`
- above `id="cost-h"` → `<p className="eyebrow">§6 · Operational</p>`

Edit C — win-pill and legend colors move to tokens (in the Phase 2 section, replace the three inline `background` hexes in the pill spans and the three in the legend swatches):

- `background: "#2a78d6"` → `background: "var(--chart-blue)"`
- `background: "#ddd9ce"` → `background: "var(--chart-grid)"`
- `background: "#1baf7a"` → `background: "var(--chart-aqua)"`

(Six replacements total: three in the `.win-pill` spans, three in the `.legend` swatches.)

- [ ] **Step 2: Replace the dashboard CSS section**

```css
/* ————— dashboard ————— */
.dash-header {
  max-width: 720px;
  margin-bottom: 8px;
}
.dash-header h1 {
  font-size: clamp(28px, 4vw, 38px);
}
.dash-header p {
  color: var(--ink-soft);
}
/* illustrative-data stamp band */
.sample-banner {
  display: flex;
  gap: 14px;
  align-items: baseline;
  background: var(--card);
  border: 1.5px dashed var(--rule-red-faint);
  border-radius: 6px;
  padding: 12px 16px;
  font-size: 14px;
  margin: 18px 0 34px;
  color: var(--ink-soft);
}
.sample-banner strong {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--rule-red);
  border: 1.5px solid var(--rule-red);
  border-radius: 3px;
  padding: 3px 9px;
  transform: rotate(-1deg);
  white-space: nowrap;
}

.dash-section {
  margin: 46px 0;
  border-top: 1px solid var(--rule-soft);
  padding-top: 26px;
}
.eyebrow {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--rule-red);
  margin: 0 0 6px;
}
.dash-section h2 {
  font-size: 24px;
  margin-bottom: 6px;
}
.dash-section > p {
  color: var(--ink-soft);
  font-size: 14.5px;
  max-width: 640px;
  margin-top: 0;
}

.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--rule);
  border-radius: 8px;
  background: var(--card);
}
table.results {
  border-collapse: collapse;
  width: 100%;
  font-size: 13.5px;
}
table.results th,
table.results td {
  text-align: right;
  padding: 8px 14px;
  border-bottom: 1px solid var(--rule-soft);
  white-space: nowrap;
}
table.results th {
  font-family: var(--font-mono);
  font-weight: 500;
  font-size: 11.5px;
  letter-spacing: 0.04em;
  color: var(--ink-faint);
  text-transform: uppercase;
  border-bottom: 1px solid var(--rule);
}
table.results td {
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--ink-soft);
}
table.results th:first-child,
table.results td:first-child {
  text-align: left;
}
table.results td:first-child {
  color: var(--ink);
}
table.results tr:last-child td {
  border-bottom: none;
}
/* best-in-column: highlighter mark, not just bold */
table.results td.best {
  font-weight: 700;
  color: var(--ink);
  background: var(--marker-soft);
  box-shadow: inset 3px 0 0 var(--marker);
}
table.results tr.winner td {
  background: var(--marker-soft);
}
table.results tr.winner td:first-child::after {
  content: " ← winner";
  font-size: 11px;
  color: var(--ink-soft);
}

.viz-card {
  background: var(--card);
  border: 1px solid var(--rule);
  border-radius: 8px;
  padding: 20px;
}
.viz-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}
.viz-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 4px;
  border-left: 3px solid var(--rule-red-faint);
  padding-left: 8px;
}
.viz-sub {
  font-size: 12.5px;
  color: var(--ink-faint);
  margin: 0 0 14px;
}
.legend {
  display: flex;
  gap: 16px;
  font-size: 12.5px;
  color: var(--ink-soft);
  margin-top: 10px;
  flex-wrap: wrap;
}
.legend .swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-right: 6px;
  vertical-align: -1px;
}

svg text {
  font-family: var(--font-body);
}
svg .mono {
  font-family: var(--font-mono);
}

.win-pill {
  display: flex;
  height: 14px;
  border-radius: 7px;
  overflow: hidden;
  min-width: 120px;
}
.win-pill span {
  display: block;
  height: 100%;
}
.win-pill .gap {
  width: 2px;
  background: var(--card);
}
```

- [ ] **Step 3: Verify tests and build**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: 20 tests PASS; build succeeds.

- [ ] **Step 4: Checkpoint (no commit)**

Report changed files. Do NOT commit.

---

### Task 7: Charts — ink→marker heatmap ramp and token-driven SVG colors

**Files:**
- Modify: `apps/web/src/lib/scale.ts:5-13` (SEQ_RAMP values only)
- Modify: `apps/web/src/components/viz/Heatmap.tsx`
- Modify: `apps/web/src/components/viz/FactorBars.tsx`
- Modify: `apps/web/src/components/viz/LatencyBoxes.tsx`

**Interfaces:**
- Consumes: tokens from Task 2 (`var(--…)` works inside inline SVG).
- Produces: nothing new — same component props; `SEQ_RAMP` still 7 light→dark steps (the helpers tests reference it symbolically, so they stay green).

- [ ] **Step 1: Swap the ramp constants**

In `apps/web/src/lib/scale.ts` replace the `SEQ_RAMP` array (keep the comment style, update the wording):

```ts
/**
 * Sequential marker→ink ramp: highlighter yellow deepening to ink,
 * one hue family, lightness-monotonic. Lightest step = smallest value.
 */
export const SEQ_RAMP: readonly string[] = [
  "#faf3cf",
  "#f3e08c",
  "#e2c452",
  "#bb9c33",
  "#8a7327",
  "#59491e",
  "#2b2517",
];
```

Nothing else in the file changes.

- [ ] **Step 2: Run tests to confirm the ramp swap is invisible to them**

Run: `pnpm --filter web test`
Expected: 20 tests PASS (heatColor tests compare against `SEQ_RAMP` entries, not hex literals).

- [ ] **Step 3: Theme the Heatmap**

In `apps/web/src/components/viz/Heatmap.tsx`:

Edit A — cell-label contrast for the new ramp (replace the `inkFor` helper and its comment):

```tsx
  // dark ramp steps (index ≥ 4) need light value labels
  const inkFor = (color: string) =>
    SEQ_RAMP.indexOf(color) >= 4 ? "#fffdf6" : "#1f2630";
```

Edit B — axis label fills become tokens, and all axis labels go mono (spec §4):

- `fill="#8b9099"` (size headers) → `fill="var(--ink-faint)"`
- `fill="#5a6270"` (strategy labels) → `fill="var(--ink-soft)"`, and add `className="mono"` to that `<text>` element

- [ ] **Step 4: Theme the FactorBars**

In `apps/web/src/components/viz/FactorBars.tsx`:

- Bar `fill="#2a78d6"` → `fill="var(--chart-blue)"`
- All three whisker `stroke="#232b36"` → `stroke="var(--ink)"`
- Label `fill="#5a6270"` → `fill="var(--ink-soft)"`, and add `className="mono"` to that `<text>` element
- Value text `fill="#232b36"` → `fill="var(--ink)"`

- [ ] **Step 5: Theme the LatencyBoxes**

In `apps/web/src/components/viz/LatencyBoxes.tsx`:

- `MODEL_COLOR` becomes:

```tsx
const MODEL_COLOR: Record<string, string> = {
  llama: "var(--chart-blue)",
  opus: "var(--chart-aqua)",
};
```

- Stage header `fill="#8b9099"` → `fill="var(--ink-faint)"` (already `className="mono"`)
- Model label `fill="#5a6270"` → `fill="var(--ink-soft)"`, and add `className="mono"` to that `<text>` element
- All four whisker `stroke="#c3c2b7"` → `stroke="var(--chart-axis)"`
- Median tick `stroke="#ffffff"` → `stroke="var(--card)"`
- Median value text `fill="#232b36"` → `fill="var(--ink)"`

- [ ] **Step 6: Verify tests and build**

Run: `pnpm --filter web test && pnpm --filter web build`
Expected: 20 tests PASS; build succeeds.

- [ ] **Step 7: Visual sanity check**

Run: `pnpm --filter web dev`, open `#/results`. Verify in BOTH themes: heatmap runs pale yellow → deep ink with readable cell labels on every step; bar/box charts and win pills recolor with the theme; axis labels stay legible in dark mode. Stop the dev server.

- [ ] **Step 8: Checkpoint (no commit)**

Report changed files. Do NOT commit.

---

### Task 8: Responsive + reduced-motion + final verification

**Files:**
- Modify: `apps/web/src/styles.css` — replace the `/* ————— responsive ————— */` section through end of file

**Interfaces:**
- Consumes: every class defined in Tasks 2–7.
- Produces: the finished stylesheet; a full manual acceptance pass.

- [ ] **Step 1: Replace the responsive + motion section (through end of file)**

```css
/* ————— responsive ————— */
@media (max-width: 920px) {
  .ask-layout {
    grid-template-columns: 1fr;
  }
  .viz-row {
    grid-template-columns: 1fr;
  }
  .topbar nav {
    margin-left: 0;
  }
  .exchange {
    padding: 16px 14px 18px 16px;
  }
}

@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }
  .answer .marked {
    animation: none;
    background-size: 100% 100%;
  }
  .clause-card {
    animation: none;
  }
  .loading-row .dot {
    animation: none;
    background:
      linear-gradient(90deg, var(--marker) 0 38%, transparent 38%) left / 100%
        100% no-repeat,
      var(--rule-soft);
  }
  .nav-link::after {
    transition: none;
  }
}
```

- [ ] **Step 2: Full test suite and build**

Run: `pnpm -r test && pnpm --filter web build`
Expected: core 46 + backend 6 + web 20 = 72 tests PASS; build succeeds.

- [ ] **Step 3: Manual acceptance pass (both themes)**

Run: `pnpm --filter web dev` and walk the spec's acceptance list:

1. Ask flow: suggestion → answer with sweep highlight → citation click scrolls + flashes the right evidence card.
2. Doc folder tabs switch and show the active yellow top bar.
3. Abstention stamp box renders (inspect styles if no abstaining answer is reachable).
4. Dashboard: stamp band, §-numbered sections, marker-marked best cells, themed charts.
5. Toggle theme on both pages; reload — choice persists.
6. Narrow the window below 920px: evidence rail stacks under the answer; viz cards stack.
7. Enable OS reduce-motion (macOS: System Settings → Accessibility → Display → Reduce motion) and confirm sweep/rise/scan/underline animations are gone.
8. Keyboard-only pass: tab through topbar, tabs, form, citations, evidence — focus rings visible everywhere.

- [ ] **Step 4: Checkpoint (no commit)**

Report the full diff summary to the user. Do NOT commit — the user decides when to commit.
