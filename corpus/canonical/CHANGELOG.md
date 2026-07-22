# Canonical corpus changelog

## netflix-tou (2026-07-22, v1)

Source: `corpus/Netflix Terms of Use.pdf` (committed in d38684f).
Build: PDF → text extraction → hand-clean → `normalizeCanonical` → freeze.

`pdftotext`/`poppler` were unavailable, so the text was recovered directly from
the PDF's content streams: FlateDecode-inflated each page stream and mapped the
Identity-H CID glyph codes back to Unicode through each font's `/ToUnicode`
CMap. The document is a single continuous text flow (no repeated running
headers/footers), so only page-boundary joins had to be healed.

Cleaning decisions:
- Converted the numbered section structure to markdown headings: the seven
  top-level sections (bold in the source) to `##`, their `N.M.` sub-clauses to
  `###`, and the document title to a single `#` heading. Trailing periods were
  dropped from heading text; the `N.` / `N.M.` numbering is preserved.
- Removed page numbers and page-break boundaries; rejoined the eight page text
  flows into continuous paragraphs (no sentence reflow — each paragraph is a
  single unwrapped line, so line breaks are meaningful offsets).
- Fixed two `/ToUnicode` glyph mis-mappings in the subset fonts: the capital-"I"
  glyph decoded as "=" (e.g. "=nternet" → "Internet", "=D" → "ID") and the
  capital-"H" glyph decoded as ":" (e.g. ":D" → "HD", "W:ERE" → "WHERE",
  ":elp" → "Help"). Legitimate colons/semicolons (from the correctly mapped
  glyphs and the WinAnsi font) were left intact.
- Preserved verbatim two whitespace typos in the source (confirmed present in
  both a glyph-outline page render and a `pdftotext` extraction): "personal,
  non-commercial" is written with NO space after the comma
  ("personal,non-commercial"), and §2.6 has a stray space BEFORE the period
  ('"Account" page .'). These were left exactly as the source has them rather
  than silently corrected, to keep the canonical a faithful offset anchor.
- Preserved the source's own spelling/typography as-is: British "authorised"
  alongside American "authorized", curly quotes “ ” ’ where the source used
  them and straight quotes " where it used those, the em dash in §2.4, and the
  all-caps text of the §6 Class Action Waiver.
- Kept inline `(i)/(ii)/...` enumerations (§1.8, §7.7) as running prose, matching
  the source, rather than converting them to markdown lists.
- Excluded no substantive furniture beyond page numbers/breaks — the PDF carried
  no navigation, contact block, or table of contents. The closing
  "Last Updated: April 10, 2026" line was retained as document body.
