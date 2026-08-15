# Calibrated Absence

A near-monochrome instrument theme where colour is reserved entirely for data semantics. Drawn for
measurement interfaces: dense, tabular, deviation-from-neutral. Its governing constraint — five
achromatic roles and only three coloured ones — falls out of the data model rather than out of a
mood board, which is why it does not look like a generic dashboard.

## Color Palette

| Role | Light | Dark | Carries |
|---|---|---|---|
| **Paper** | `#EDEFF2` | `#14181D` | ground — cool graph-paper / near-black with a blue cast |
| **Surface** | `#F7F8FA` | `#1B2027` | raised panels, as a fill and never a shadow |
| **Rule** | `#D2D8DF` | `#2C333C` | hairlines, table separators |
| **Ink** | `#14181D` | `#E4E8ED` | all type, all chrome, the focus ring |
| **Quiet** | `#616B78` | `#8C97A3` | labels, eyebrows, **and the entire "no data" register** |
| **Deficit** | `#A63A2B` | `#E0715F` | weak · hard · badly overdue · failed |
| **Median** | `#7E6014` | `#D6A93F` | medium · due soon |
| **Surplus** | `#1B6B63` | `#4FB3A6` | strong · easy · completed |

All eight measured at ≥4.5:1 against their own ground in both registers. Surplus is **teal rather
than green** on purpose: red/green is the common colourblind collision, and this palette's
audience skews toward it. Colour is always redundant with position or a printed label.

## Typography

- **Display**: Archivo Variable, `wdth 125`, weight 600–700, uppercase, `-0.02em`
- **Body**: Archivo Variable, `wdth 100`, weight 400–600 — the same face, separated from display
  only by its width axis
- **Data**: IBM Plex Mono, weight 400–600, `tabular-nums`, slashed zero — every numeral

## Best Used For

Measurement dashboards, analytics instruments, scientific-plate layouts, standings and ranking
tables, and anything where a reader must never confuse *no data* with *a low value*.

## Not Suited To

Marketing pages, anything wanting a brand colour, or any layout that leans on generous
whitespace — this theme is built for density.
