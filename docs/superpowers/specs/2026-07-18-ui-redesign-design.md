# UI Redesign — "Annotated Brief" · Design Spec

**Date**: 2026-07-18
**Scope**: apps/web only (chat/ask view, dashboard, app shell). Pure frontend restyle; no backend, API, or core-library changes.
**Approved direction**: evolve the existing paper/ink/highlighter identity into a full "annotated legal document" aesthetic.

## Goals

- Give the demo a distinctive, coherent visual identity that reinforces the project's core story: answers grounded in exact character offsets of frozen ToS documents.
- Refine the chat/ask section and dashboard without changing any behavior except adding a theme toggle.
- Keep all 16 web tests green and hold the current accessibility bar.

## Non-goals

- Document upload (out of scope — PRD §2 stands).
- Any change to `apps/backend`, `packages/core`, API shapes, or `lib/` logic (`api.ts`, `citations.ts`, `format.ts`, `sample.ts` unchanged; `scale.ts` keeps its logic and signatures — only the `SEQ_RAMP` color constants change for the ink→marker heatmap ramp).
- New chart types or dashboard data. Restyling only.

## 1 · Design language

### Palette (CSS custom properties, both themes from one stylesheet)

Light ("paper"):

- `--paper: #f7f4ec` (warm paper), `--ink: #1f2630` (near-black)
- `--marker: #ffe14d` — highlighter yellow; the only highlight/accent for marks, active nav, cited flags, best-cell marks
- `--rule-red: #b5432e` — editor's red; thin rules, stamps, active states only. Never for large fills.
- Graphite grays for meta/secondary text (`--ink-soft`, `--ink-faint`)

Dark ("desk lamp"):

- Warm charcoal paper (~`#171a1f` family), off-white ink, marker becomes translucent amber (highlight via rgba over text, AA-checked), red shifts brighter for contrast.

Theme selection: `prefers-color-scheme` default + manual toggle in topbar, persisted to `localStorage`, applied via `data-theme` on `<html>`.

### Paper details

- Answer column sits on subtle ruled baselines (CSS `repeating-linear-gradient`, no images) with a thin `--rule-red` vertical margin rule on the left — annotated legal pad.
- Cards are paper surfaces with hairline borders; no drop-shadow-heavy "material" look.

### Typography

- Zilla Slab (display/headings), Public Sans (body), IBM Plex Mono (offsets, scores, timings, table numerals) — unchanged fonts, new scale.
- Answer text ~1.15rem / 1.7 line-height; tighter heading rhythm; mono kept small and quiet.

### Motion

- Signature: existing `.marked` sweep-in highlight stays.
- New: underline-draw on nav links, highlighter-bar loading shimmer, evidence-card flash (implemented as a static background/border highlight rather than a sweep — deliberate, calmer for a card that's being located).
- Everything gated behind `prefers-reduced-motion: reduce` (fall back to static states).

## 2 · App shell (`App.tsx`)

- **Topbar as document header**: wordmark with a highlighter swipe behind it; nav links underline in marker yellow, active page (`aria-current`) shown as a solid mark; "winning config sentence × 256" chip restyled as a rubber-stamp bordered mono chip; theme toggle button (sun/moon or "lamp") on the right — the only new interactive element in the app.
- **Footer as colophon**: single hairline rule above, same content, quieter type.
- Skip-link preserved.

## 3 · Ask view (`AskView.tsx`, `EvidenceCard.tsx`)

- **Hero**: large Zilla Slab headline with an SVG marker-stroke underline; the `chunk.text === canonical.slice(start, end)` invariant becomes a mono margin-annotation bubble with a caret (reviewer's comment).
- **Doc filter**: the three chips become file-folder tabs sitting on top of the question card (Both · GitHub ToS · Netflix ToU); `aria-pressed` semantics unchanged.
- **Question form**: paper card; input styled as a ruled writing line; Ask button is a solid ink block with marker-yellow hover.
- **Exchange**: question with a large "Q." ledger label; answer on ruled paper with sweep-in highlight. Citation chips become superscript margin markers (¹ ²) in small marker-yellow squares; click still scrolls/flashes the matching evidence card.
- **Abstention**: dashed box with a red "NO ANSWER IN CORPUS" stamp header; model's verbatim reply beneath.
- **Meta**: mono "docket line" — config · retrieval ms · generation ms · tokens.
- **Evidence rail**: each card is a clause excerpt — doc tag + `§start–end` in mono, similarity as a small inline meter bar, clause text as a left-red-ruled quotation. Cards cited in the answer get a folded marker-yellow corner flag; flashed card runs the sweep. Empty state and loading state (animated highlighter bar over a ghost line) restyled to match.
- **Responsive**: below 920px the rail stacks under the answer, cards full-width.

## 4 · Dashboard (`DashboardView.tsx`, `viz/*`)

- Reframed as a **lab report**: numbered § section headings; ruled-paper cards with red-rule headers.
- Sample-data banner becomes a prominent "ILLUSTRATIVE DATA — not experimental findings" stamp band (real text, accessible; not a watermark).
- Tables: mono numerals; best-per-column cells marked with highlighter yellow in addition to bold.
- Heatmap ramp: ink→marker scale, contrast-checked in both themes.
- Chart axes/legends (Heatmap, FactorBars, LatencyBoxes) restyled to mono; no logic or data changes.

## 5 · Implementation shape

- `styles.css`: rewritten around the token system (`:root` + `[data-theme="dark"]`), organized by shell / ask / evidence / dashboard sections.
- Markup/class edits in `App.tsx`, `AskView.tsx`, `EvidenceCard.tsx`, `DashboardView.tsx`, `viz/Heatmap.tsx`, `viz/FactorBars.tsx`, `viz/LatencyBoxes.tsx`.
- Theme toggle: small hook in `App.tsx` (`useTheme`), `localStorage` key, `data-theme` attribute.
- No dependency additions.

## Error handling

- Error note (`error-note`) restyled in editor's red; no behavior change.
- Theme toggle degrades gracefully: if `localStorage` unavailable, falls back to `prefers-color-scheme` per render.

## Testing & acceptance

1. `pnpm -r test` passes (68 tests; web's 16 test helpers, unaffected by markup).
2. `pnpm --filter web build` succeeds.
3. Manual pass in both themes: ask flow (question → answer → citation click flashes evidence), abstention display, doc tabs, dashboard sections, 920px breakpoint.
4. AA contrast for text and marker highlights in both themes; `prefers-reduced-motion` disables sweep/shimmer/draw animations; skip link, aria-pressed/aria-current, focus-visible states intact.
