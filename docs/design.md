# Design

The visual specification for the `tos-rag` demo. `docs/PRD.md` defines what the
experiment measures; this defines how it is presented. Where the two disagree
about a number, the PRD wins.

It replaced the previous "annotated brief" direction (warm paper, highlighter
yellow, editor's red, Zilla Slab) and is implemented — see
[Implementation](#implementation) for where each piece lives and what is still
unverified.

---

## 1. The brief

**Subject.** A controlled experiment on RAG pipeline design over Terms of
Service documents — 15 chunking configurations, two generators, 360 runs.

**Audience.** Examiners and reviewers. They arrive to judge whether the method
is sound and the numbers are traceable, not to be sold anything.

**The page's job.** Make the shape of the result legible in one screen, then let
someone drill into any cell of it. `#/results` is the front door; `#/ask` is the
supporting proof that the pipeline is real.

**Register.** An instrument, not a product. Nothing on screen should suggest a
claim the database can't back.

---

## 2. Direction

### The one idea

The experiment is about **where you cut a document**. Every chunk is a character
span `[charStart, charEnd)` into a canonical text; the offset invariant
(`chunk.text === canonical.slice(charStart, charEnd)`) is the codebase's load-
bearing constraint. The whole study asks which cuts produce answers you can
trust.

So the **cut mark** is the signature element: a navy hairline terminated by short
perpendicular ticks, like the trim marks on a printer's sheet, carrying an offset
number in mono where a number is known.

It is the only decorative device in the system, and it earns its place by
encoding something true:

- **Section dividers** on the dashboard are cut marks — the report is itself cut
  into spans.
- **Evidence cards** in the ask view render their real span as a cut mark with
  the actual offsets under it.
- Nothing else gets a decorative rule. Plain `1px` `--rule` borders elsewhere.

If a cut mark appears somewhere that isn't a boundary, remove it.

### The risk

**Inverted weight contrast.** Display type is set *light* — Cause at 200 — and
small utility labels are set *heavy* — Cause at 700, uppercase, wide-tracked.
The usual move is the reverse. At 44px a 200-weight sans reads as drawn rather
than shouted, which suits an instrument; and it makes the small structural labels
(`§2 · PHASE 1 — CHUNKING`) the load-bearing typographic element, which is
correct for a document someone is scanning to assess.

This only works if the light weight is genuinely large. **Never set Cause 200
below 28px** — it goes anaemic and fails contrast in practice.

### What this is not

Navy and white is the default palette of institutional seriousness, and it would
be easy to land on a generic university-report or fintech-dashboard look. The
things keeping this specific to `tos-rag`: navy is the *text* colour as well as
the brand colour (one hue does both jobs, so there is no "brand blue" applied on
top of black text); the sequential ramp is that same navy fading to white, so the
heatmap is literally made of the text colour; and the only structural ornament is
tied to the character-offset model. No gradients. No shadows except the two
listed in §7.

---

## 3. Colour

Light only. There is no dark theme.

**So no `dark:` variant may appear in any component.** Tailwind v4 resolves
`dark:` through `prefers-color-scheme` unless a `@custom-variant` says otherwise,
and `styles.css` defines no dark token block — so on a machine set to dark mode
those utilities fire against the light palette and win. shadcn ships several
(`dark:bg-input/30` on `Input` and `Button variant="outline"`,
`dark:aria-invalid:ring-*` nearly everywhere); left in place they greyed the ask
input and the outline pills while the rest of the page stayed light. They were
stripped from the primitive source, same rule as shadows (§7): strip on paste,
not per call site. `grep -rn "dark:" packages/ui/src apps/frontend/src` must
return nothing.

Adding a dark theme later is not a matter of deleting that rule — it needs
`@custom-variant dark (&:where(.dark, .dark *))` in `styles.css` so the variant
is class-gated, plus a full dark token block. Media-gated is wrong here either
way.

Two naming vocabularies live in `:root` on purpose. shadcn's primitives are
hard-wired to a fixed set of semantic names, so those keep shadcn's meanings and
carry our values. Anything shadcn has no concept of keeps our own name.

### shadcn's contract, our values

| Token | Hex | Role |
|---|---|---|
| `--background` | `#FFFFFF` | Page background. Pure white, nothing tinted behind body text. |
| `--foreground` | `#0B1F3A` | Navy. Body text, headings, the dark end of the ramp. |
| `--card` | `#F5F7FA` | Cards, table fill, inset panels. Cool — never warm grey under navy. |
| `--primary` | `#0B1F3A` | Navy again: primary buttons, selected chips, the Llama series. |
| `--primary-foreground` | `#FFFFFF` | Text on navy fills. |
| `--muted-foreground` | `#5F6E84` | Captions, offsets, table headers. Lightest text permitted. |
| `--accent` | `#ECF1F7` | **shadcn's meaning: a hover surface**, not a brand colour. |
| `--destructive` | `#A5342B` | Errors and abstention only. Never decorative. |
| `--border` | `#DDE3EA` | Borders, dividers, chart gridlines. |
| `--input` | `#7B8B9F` | Form-control borders. Darker than `--border` because a field's boundary is what identifies it (WCAG 1.4.11). |
| `--ring` | `#1B6DD9` | Focus ring. Deliberately distinct from `--primary` so it reads as a state. |

**The `--accent` trap.** In shadcn, `--accent` is the subtle background behind a
hovered menu item or ghost button. It is not a brand accent. Setting it to amber
would tint every hover surface in the app. Our amber lives under a different
name, below.

### Ours

| Token | Hex | Role |
|---|---|---|
| `--ink-soft` | `#4A5B72` | Secondary text, descriptions, axis labels. Sits between `--foreground` and `--muted-foreground`; shadcn has no step there. |
| `--rule-strong` | `#B9C4D1` | Cut-mark ticks and hairlines. Decorative only. |
| `--compare` | `#9C580F` | The counterpart in any two-way comparison; winner marks. |
| `--compare-wash` | `#FBF1E3` | Winner row fill, citation chips. |

**`--compare` is used sparingly and only where navy needs an opposite.** Navy vs
amber is the standard colour-vision-safe pair, which matters because the Phase 2
win-pill encodes Llama / tie / Opus by colour alone. Amber never appears as a
background for large areas.

Every token above is re-exported as a Tailwind utility through `@theme inline`,
so `bg-compare`, `text-ink-soft`, `border-rule-strong` and `bg-seq-4` all exist
as classes. Nothing in a component should reach for a raw hex.

### Sequential ramp

For the heatmap and any single-variable magnitude encoding. One hue, lightness-
monotonic, white → `--ink`. Lightest step is the smallest value.

```
--seq-0  #EEF3F9
--seq-1  #D3E0EE
--seq-2  #AFC6DE
--seq-3  #85A5C9
--seq-4  #4A73A3   ← darker than an even interpolation
--seq-5  #33588A
--seq-6  #0B1F3A
```

Value labels sit on top of these cells: `--foreground` on steps 0–3,
`--background` on steps 4–6. The threshold is `SEQ_DARK_FROM` in
`packages/shared/src/scale.ts` and must move with the ramp.

**Why `--seq-4` is off the even curve.** The midpoint of a white→navy ramp is a
contrast dead zone: an evenly interpolated `#5A80AE` reaches only 4.04:1 against
`--foreground` and 4.09:1 against `--background`, so *neither* label colour
passes AA — and every heatmap cell prints its value. Darkening the step to
`#4A73A3` puts white labels at 4.92:1. Any future edit to the ramp has to
re-check this step first.

### Rules

- Components reference tokens (as Tailwind utilities), never raw hex. The only
  file with literal colour values is the token block in `styles.css`, plus
  `SEQ_RAMP` in `packages/shared/src/scale.ts`.
- Colour is never the sole carrier of meaning. The winner row is amber-filled
  **and** labelled; best-in-column cells are tinted **and** bold; the win-pill has
  a `title` and a legend.
- Every text/background pair in the system has been checked against WCAG AA
  (4.5:1 text, 3:1 UI boundaries) and passes. The tightest pairs, and the ones
  to re-check after any palette edit:

  | Pair | Ratio |
  |---|---|
  | `--muted-foreground` on `--card` | 4.83 |
  | `--muted-foreground` on `--compare-wash` | 4.64 |
  | `--compare` on `--compare-wash` | 4.92 |
  | `--background` on `--seq-4` | 4.92 |
  | `--input` on `--card` | 3.24 |

---

## 4. Typography

Two families. Cause carries the voice; the mono carries anything a reader might
need to compare digit by digit.

Both families are **self-hosted** through Fontsource and imported in
`apps/frontend/src/main.tsx`, ahead of `styles.css`:

```ts
import "@fontsource-variable/cause/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
```

Self-hosting rather than linking Google Fonts: no third-party round trip, no
render-blocking external stylesheet, no dependency on a CDN staying up, and Vite
fingerprints the `woff2` files so they cache immutably. Both are variable fonts,
so each ships one file per unicode subset regardless of how many weights the
design uses — which is what makes the 200/400/500/600/700 spread below free.

Never add an `@import` for a font inside `styles.css`: it serialises the request
behind the CSS and delays first paint.

```css
--font-display: "Cause", system-ui, sans-serif;
--font-body:    "Cause", system-ui, sans-serif;
--font-mono:    "JetBrains Mono", ui-monospace, "SF Mono", monospace;
```

**Cause** (variable, 100–900) does display and body. **JetBrains Mono** is the
utility face — it has a slashed zero, which is not a stylistic preference here:
the app prints character offsets like `[1024, 1536)` beside strategy names, and
`0`/`O` confusion in a research artefact is a real defect.

### Scale

| Role | Family | Size | Weight | Tracking | Notes |
|---|---|---|---|---|---|
| Page title | Cause | `clamp(34px, 5vw, 52px)` | 200 | `-0.02em` | Line height 1.05. The light weight only appears here. |
| Section heading | Cause | 26px | 600 | `-0.01em` | |
| Subheading | Cause | 17px | 600 | `0` | Viz titles, question text. |
| Body | Cause | 16px | 400 | `0` | Line height 1.6. |
| Answer | Cause | 18px | 400 | `0` | Line height 1.7. Max 68ch. |
| Secondary | Cause | 14.5px | 400 | `0` | Colour `--ink-soft`. |
| Eyebrow / label | Cause | 11.5px | 700 | `0.12em` | Uppercase. The structural voice. |
| Data | JetBrains Mono | 12.5px | 400 | `0` | `font-variant-numeric: tabular-nums`. |
| Table header | JetBrains Mono | 11px | 500 | `0.06em` | Uppercase. |
| Offsets / meta | JetBrains Mono | 11.5px | 400 | `0` | Colour `--ink-faint`. |

Everything numeric is mono with tabular figures, so metric columns align on the
decimal down the whole table. Verbatim ToS excerpts are also mono — they are
source text being quoted, and the shift in face is what tells a reader that the
words are the document's and not ours.

Set `font-variant-numeric: tabular-nums` on `table.results td`, every SVG `text`
carrying a number, and the answer meta line.

---

## 5. Layout

`--w-max: 1140px`, `24px` gutters, `8px` spacing base. Section rhythm: `56px`
between dashboard sections, `24px` from a heading to its content.

### Dashboard (`#/results`) — the front door

An examiner scans for structure first. A sticky section index gives them the
whole argument before they read any of it.

```
┌────────────────────────────────────────────────────────────┐
│ tos-rag   An empirical study of RAG pipeline design        │  topbar
│                              Ask the corpus · Results      │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  RESULTS                                                   │  eyebrow, 700
│  What the experiment                                       │  Cause 200
│  measured.                                                 │
│                                                            │
│  ┌────────────────────┐  15 configurations, two            │  contact sheet:
│  │ ▪ ▪ ▪              │  generators, 360 runs. Every       │  the 5×3 grid at
│  │ ▪ ▪ ▪              │  number traces back to a stored    │  ~14px/cell, the
│  │ ▪ ▪ ▪  ◆           │  run in Postgres.                  │  winner ringed
│  │ ▪ ▪ ▪              │                                    │  in --accent
│  │ ▪ ▪ ▪              │  BEST CONFIG  sentence × 256 tok   │
│  └────────────────────┘                                    │
│                                                            │
│  ├───────────────────────────────────────────────────────┤ │  cut mark
│  ┌──────────┐                                              │
│  │ §1 Table │  §1 · PHASE 1 — CHUNKING                    │
│  │ §2 Grid  │  All 15 configurations                      │
│  │ §3 Factor│  Mean per metric with bootstrap 95% CIs…    │
│  │ §4 Models│  ┌────────────────────────────────────────┐ │
│  │ §5 Latency│ │ CONFIG      TRUTH   FAITH   CHAR R@8 … │ │
│  │ §6 Cost  │  │ fixed×128    0.61    0.72     0.44   … │ │
│  └──────────┘  └────────────────────────────────────────┘ │
│   sticky, 132px                                            │
└────────────────────────────────────────────────────────────┘
```

The hero is the **contact sheet**: the 5×3 grid rendered at thumbnail scale, in
the sequential ramp, with the winning cell ringed. It states the thesis in the
subject's own form — this was a sweep, and here is the shape of what came back —
without a headline number floating free of its evidence. It reuses `Heatmap`'s
data at a smaller cell size rather than being a second component.

Section numbering (`§1`…`§6`) is legitimate here because the dashboard *is* a
sequence: Phase 1 → Phase 2 → operational, in the order the PRD runs them. It
would not be legitimate on the ask view, and it does not appear there.

### Ask (`#/ask`)

Keeps the existing asymmetric split — question and answer lead, retrieved
evidence sits to the right where it can be checked against the answer without
scrolling.

```
┌──────────────────────────────────────┬──────────────────────┐
│  Ask the corpus                      │  RETRIEVED  k=5      │
│  ───────────                         │                      │
│  ┌────────────────────────────────┐  │  ┌────────────────┐  │
│  │ What happens to my content…  → │  │  │ 1  1024–1536   │  │
│  │ ─────────────────────────────  │  │  │ ├──────────┤   │  │  cut mark with
│  │ GitHub · Netflix   settings ⌄  │  │  │ "You retain…"  │  │  real offsets
│  └────────────────────────────────┘  │  └────────────────┘  │
│                                      │  ┌────────────────┐  │
│  Q. What happens to my content…      │  │ 2  2048–2560   │  │
│  A. You retain ownership of any      │  └────────────────┘  │
│     content you post¹, but grant…²   │                      │
│     ─────────────────────────────    │                      │
│     retrieval 84ms · generation 1.2s │                      │
└──────────────────────────────────────┴──────────────────────┘
```

Collapses to one column below 920px, evidence after the answer.

### Responsive

Tailwind breakpoints: `md` (768px) collapses the dashboard's section index to an
inline row, `lg` (1024px) collapses the ask view's two columns and the paired
factor charts. Tables scroll horizontally inside shadcn `Table`'s own container —
the page body never scrolls sideways.

---

## 6. Components

Every part with a shadcn equivalent uses one. The primitives live in
`packages/ui/src/primitives/` and are themed entirely through the tokens in §3 —
no per-call-site colour overrides.

| Part | Primitive |
|---|---|
| Ask button, suggestions, bench reset | `Button` (`default`, `outline`, `link`) |
| Question field | `Input` |
| Question panel, viz panels, table shells, evidence | `Card` |
| Results, Phase 2, cost tables | `Table` + parts |
| Document filter, strategy / size / generator chips | `ToggleGroup` |
| Pipeline bench disclosure | `Collapsible` |
| Similarity meter, win-pill explanations | `Tooltip` |
| Illustrative-data banner, request errors | `Alert` |
| Evidence index, abstention stamp | `Badge` |
| Answer and dashboard loading | `Skeleton` |
| Form footer divider | `Separator` |

**No shadcn equivalent, so hand-rolled:** `CutMark`, `Heatmap`, `ContactSheet`,
`FactorBars`, `LatencyBoxes`. These carry the experiment's data and the design's
signature; a generic chart wrapper would cost the exact character-offset control
they exist for.

### Cut mark

```
      ┬────────────────────────────────────────────────────┬
      1024                                              1536
```

A `1px` `--rule-strong` line with `7px` ticks at each end, drawn with
`::before`/`::after` in the `.cut-mark-rule` component class. Offsets in mono
`11.5px` `--muted-foreground`, first left-aligned, second right-aligned. Section
dividers use the same mark without numbers.

Deliberately **not** a shadcn `Separator`: it carries data and needs the end
ticks.

### Buttons

shadcn's `Button` variants, themed. `default` is a navy fill; `outline` is the
quiet chip; `link` is the bench reset. The default size is `h-9` (36px), so the
primary Ask button uses `size="lg"` (`h-10`, 40px) to meet the touch-target
floor in §8.

Focus is shadcn's `ring-[3px] ring-ring/50` in `--ring` blue — kept as shipped,
since it satisfies the visible-focus requirement and is consistent across every
primitive.

### Tables

`Card` shell with `p-0 overflow-hidden`; shadcn `Table` inside. Header row in
mono uppercase `--muted-foreground`. Numeric columns right-aligned with
`tabular-nums`, config column left. Best-in-column: `--compare-wash` fill,
medium weight, `3px` `--compare` inset shadow on the left edge. Winner row:
`--compare-wash` fill plus a `← winner` label. Rows do not stripe — the tint has
to mean something.

### Evidence card

A shadcn `Card` with a `3px` left border in `--rule-strong`, switching to
`--compare` when the chunk is cited. Header line in mono: a `Badge` index, the
document, and cosine similarity in a `Tooltip` with a `36×4px` meter. Then the
cut mark with real offsets, then the excerpt in mono `13px`.

### Citation chip

Superscript, mono `11px`, `--accent` text on `--accent-wash`, `1px --accent`
border, `3px` radius. Clicking scrolls its evidence card into view and flashes
it. Must be a `<button>`, not a styled span.

### Status and empty states

- **Illustrative data banner** — `--alert` `1.5px` dashed border on `--paper`,
  label in mono uppercase `--alert`. It says the experiment hasn't run and these
  numbers are not findings. This never softens; it is the honesty of the whole
  artefact.
- **Abstention** — dashed `--rule` border, `ABSTAINED` label in mono `--alert`,
  followed by the verbatim reason. Not framed as an error, because it is correct
  behaviour.
- **Error** — `3px` `--alert` left border, `--surface` fill. States what failed
  and what to do. No apology, no exclamation mark.
- **Empty evidence** — "Ask a question to see the chunks it retrieved." An
  instruction, not a shrug.

---

## 7. Depth and motion

**No shadows.** Cards, tables, and viz panels are separated from the page by two
devices already: a `--card` fill against pure white, and a `1px --border`. A
shadow would be a third, redundant one. The system is flat by decision, not by
omission — if something needs to lift off the page, the answer is contrast or
spacing, not elevation.

shadcn ships `shadow-sm` on `Card` and `shadow-xs` on `Button`, `Input`, `Toggle`
and `ToggleGroup`. Those were **stripped from the primitive source**, not
overridden per call site — otherwise every new usage reintroduces them. If you
re-run the shadcn CLI, strip them again.

**One orchestrated moment.** The heatmap cells fill in on load, `20ms` stagger in
reading order, `160ms` fade — the sweep assembling itself. Nothing else on the
dashboard animates.

Everything else is interaction feedback only: shadcn's own `150ms` transitions on
hover and focus, and the flash when a citation targets its evidence card. Loading
is a `Skeleton` shaped like the content it replaces, not a novelty.

`prefers-reduced-motion: reduce` is honoured with a single global rule in
`styles.css` that collapses every animation and transition to `0.01ms`. It
applies to shadcn's Radix-driven enter/exit animations too, which is why it is
global rather than per-component.

---

## 8. Quality floor

Not features — the conditions for calling any of this done.

- **Keyboard.** Every interactive element reachable, in visual order, with a
  visible `--ring` focus ring. Skip link to `#main`. Radix handles roving focus
  inside `ToggleGroup` and the `Collapsible` disclosure; citation chips are real
  buttons.
- **Semantics.** One `<h1>` per view, headings in order. Tables use `<th scope>`.
  SVG charts carry `role="img"` and a full `aria-label`; the underlying numbers
  are also in a table so the charts are never the only source.
- **Contrast.** AA on every text pair, including mono at 11px and value labels on
  ramp cells.
- **Layout stability.** Reserve height for the answer block and evidence list so
  a response doesn't shove the page. Target CLS ≈ 0.
- **Fonts.** Self-hosted variable `woff2` via Fontsource, `font-display: swap`,
  with a `system-ui` fallback close enough in metrics that the swap doesn't
  reflow.
- **Motion.** `prefers-reduced-motion` honoured everywhere.
- **Touch targets.** 40px minimum on anything tappable.

---

## 9. Voice

- Sentence case everywhere except eyebrows and mono labels.
- Active voice. A control names what happens: "Ask", not "Submit".
- The same word for the same thing across the whole app. A *chunk* is never a
  *passage*; a *configuration* is never a *setup*.
- Never imply a finding the database can't produce. "Illustrative data" while
  the sample fixtures are in use, on every view that shows numbers.
- No exclamation marks. No "Oops". No em-dash-joined hype.

---

## Implementation

This spec is **built**. `pnpm typecheck`, `pnpm test`, and `pnpm build` pass, and
the palette is contrast-verified (§3).

Where each piece lives:

| Concern | File |
|---|---|
| Tokens, `@theme` mapping, base + component layers | `apps/frontend/src/styles.css` |
| Font imports | `apps/frontend/src/main.tsx` |
| shadcn primitives (themed source) | `packages/ui/src/primitives/` |
| `cn` class merger | `packages/ui/src/lib/utils.ts` |
| Cut mark | `packages/ui/src/CutMark.tsx` |
| Contact sheet + heatmap | `packages/ui/src/viz/Heatmap.tsx` |
| Ramp + label threshold | `packages/shared/src/scale.ts` |
| Section index, hero | `apps/frontend/src/views/DashboardView.tsx` |

### How shadcn is wired here

shadcn is a CLI that copies source into your project, not a dependency — so the
components are ours to edit, and they have been edited (shadows stripped, §7).

The one non-standard choice: **primitives live in `packages/ui`, not the app.**
`packages/ui`'s own components (`EvidenceCard`) build on `Card`, `Badge` and
`Tooltip`, and a package cannot import from the app that consumes it. Putting
them in `packages/ui/src/primitives/` keeps the dependency direction right and
matches the boundary in `CLAUDE.md`.

The CLI cannot write there directly. To add a component:

```bash
cd apps/frontend
pnpm dlx shadcn@latest add <name>          # lands in src/components/ui/
mv src/components/ui/<name>.tsx ../../packages/ui/src/primitives/
# then repoint "@/lib/utils" → "../lib/utils", strip shadow-xs/shadow-sm,
# strip every dark: variant (§3), and export it from packages/ui/src/index.ts
```

`components.json` stays in `apps/frontend` because that is where the CSS entry
and the `@/*` alias live. Tailwind scans the package via
`@source "../../../packages/ui/src"` in `styles.css` — without that line, every
utility used inside `packages/ui` silently fails to generate.

### What was retired

The previous "annotated brief" system is fully removed — no orphaned references
remain. Gone: the warm paper palette (`--paper` was `#F7F4EC`), highlighter
yellow (`--marker*`), editor's red (`--rule-red`), Zilla Slab / Public Sans /
IBM Plex Mono, the `sweep` highlight animation, the folded corner flag on cited
cards, the `scan` loading bar, the wordmark highlight gradient, and the
`marker-stroke` underline SVG in the ask hero.

The dark theme went with it: `packages/shared/src/theme.ts` and its test are
deleted, the toggle is out of `App.tsx`, and the theme-priming script is out of
`index.html`.

The hand-written CSS system went too. `styles.css` dropped from ~900 lines of
component rules to a token block plus two small layers; everything else is
Tailwind utilities in the components.

### Deviations from the spec as first written

The spec above describes the built state. Three things changed once the code met
reality:

1. **Fonts are self-hosted, not linked.** The repo already used Fontsource for
   the old families, and both Cause and JetBrains Mono are published there —
   strictly better than the Google Fonts `<link>` originally specified.
2. **Three colours moved to pass WCAG AA.** The first values failed:
   `--muted-foreground` at 3.81:1 on `--card`, `--compare` at 3.26:1 on
   `--compare-wash`, and `--seq-4` failing against *both* candidate label
   colours. All three were re-solved; §3 carries the passing values.
3. **Token names follow shadcn's contract.** `--paper`/`--ink`/`--rule` became
   `--background`/`--foreground`/`--border`, and our amber moved from `--accent`
   to `--compare` to avoid colliding with shadcn's hover-surface meaning of
   `--accent`. Same colours, different names.

### Cost of adopting shadcn

Honest accounting, measured on `pnpm build`:

| | Before | After |
|---|---|---|
| JS (gzip) | 65.2 kB | 98.4 kB |
| CSS (gzip) | 4.5 kB | 10.9 kB |

The JS growth is Radix. What it buys: roving focus and keyboard semantics in the
toggle groups, a real disclosure widget, accessible tooltips, and one consistent
focus treatment — all of which were hand-rolled or absent before.

### Still open

- **No visual verification has been done.** There is no browser in this
  environment, so this has been checked by construction, by computed contrast
  ratios, and by confirming every custom Tailwind utility is present in the
  built CSS — not by looking at it. Run `pnpm dev` and review both views at
  1440px, 920px, and 375px, plus a keyboard-only pass.
- Cause's rendering at weight 200 in the 34–52px range is the single riskiest
  choice in the system (§2) and the first thing to judge on screen.
- shadcn's default radii (`--radius: 0.5rem`) and `h-9` control height were kept
  as shipped. If the app reads softer or chunkier than the spec's instrument
  register intends, those are the two dials to turn.
