---
name: trainer-design
description: The Calibrated Absence design system for the DSA/CP Trainer frontend. Use whenever building, restyling, or reviewing any UI in frontend/ — new pages, new components, or changes to existing ones. Carries the palette, type scale, spacing, motion rules, component conventions and the banned-pattern list.
---

# Calibrated Absence — the Trainer design system

The visual system for `frontend/`. Everything here is implemented; nothing is aspirational.
Source of truth for tokens: `frontend/app/globals.css`. Philosophy: `docs/calibrated-absence.md`.

**Read this before styling anything.** A new page built without it will not match, because the
rules below are unusual on purpose.

---

## The three laws

### 1. Colour is reserved for data semantics

There are eight colours. **Five are achromatic and three carry meaning.** The three appear *only*
where they encode a quantity or a state, and the entire rest of the interface — chrome, type,
borders, buttons, nav, focus rings — is grey.

This is the rule most likely to be broken by accident. If you are about to colour something
because it would look nice, stop: that spends the one budget the data needs. There is no brand
colour in this app, and `--primary` deliberately resolves to plain ink.

The three hues encode **one axis** — *how hard is this for you* — which is why difficulty and
mastery share them:

| Token | Means |
|---|---|
| `--deficit` | weak topic · HARD problem · >7d overdue · FAILED sync |
| `--median` | MEDIUM problem · 1–7d overdue |
| `--surplus` | strong topic · EASY problem · COMPLETED sync |

**Colour is never the only signal.** Every difficulty chip also prints its `difficultyRaw` text,
every mastery bar also has a *direction*, every status pill also prints its word, every urgency
also prints its label. The one place colour is mapped is `bandColorClass()` /
`urgencyColorClass()` in `lib/format.ts` — add a fourth meaning there or nowhere.

### 2. Weak is not unknown, and the UI must not be able to confuse them

`GET /api/mastery` returns three arrays. `unknown` topics carry **no score field at all** — this
is enforced in the type system (`UnknownTopicView` in `lib/types.ts` has no `masteryScore`), so
rendering one at zero is a compile error rather than a judgement call.

A topic with no data gets, in `components/spread.tsx`, **four independent differences**:

1. a separate `<table>` with its own `<caption>` (so the distinction reaches screen readers)
2. a labelled break above it — `NO DATA YET · n TOPICS · NOT SCORED`
3. a dotted graticule across the full track, **never a short bar** (a short mark reads as a small
   quantity; a graticule reads as a place a measurement could go)
4. `—` (`NO_DATA` in `lib/format.ts`) in every numeric column — never `0`, never `0.0000`, never
   blank

Never render an unmeasured thing as zero, anywhere, for any reason.

### 3. Every numeral is tabular monospace

`.t-data-lg` / `.t-data` / `.t-data-xs`, all IBM Plex Mono with `tabular-nums` and the slashed
zero (`font-feature-settings: "zero" 1`). Scores, ratings, counts, intervals, dates, elapsed
seconds, row numbers. It is a signature *and* it is functionally correct — proportional figures
make a column jitter, and a jittering column cannot be scanned.

---

## Tokens

Declared in `frontend/app/globals.css`. Light is the design of record; dark is its inversion.
`@theme inline` maps them to Tailwind utilities (`bg-paper`, `text-ink`, `border-rule`,
`text-deficit`, …), so **no component ever names a colour twice** and one media query is the only
place dark mode is expressed. There is no `dark:` variant anywhere in this codebase — do not add
one.

| Role | Light | Dark | Contrast on `--paper` (light / dark) |
|---|---|---|---|
| `--paper` | `#EDEFF2` | `#14181D` | ground |
| `--surface` | `#F7F8FA` | `#1B2027` | panels — a fill, never a shadow |
| `--rule` | `#D2D8DF` | `#2C333C` | hairlines, separators |
| `--ink` | `#14181D` | `#E4E8ED` | **15.47 / 14.48** |
| `--quiet` | `#616B78` | `#8C97A3` | **4.70 / 6.00** |
| `--deficit` | `#A63A2B` | `#E0715F` | **5.59 / 5.68** |
| `--median` | `#7E6014` | `#D6A93F` | **5.11 / 8.15** |
| `--surplus` | `#1B6B63` | `#4FB3A6` | **5.47 / 7.07** |

Contrast measured in the browser against the live tokens, not estimated. All clear 4.5:1 in both
registers. **Two of these were corrected during the build** — `--quiet` was `#6A7480` (4.12, fail)
and `--median` was `#8A6A16` (4.39, fail). If you introduce a hue, measure it the same way; do not
eyeball it.

`--quiet` does double duty: ordinary labels *and* the entire "no data" register. That is
deliberate — absence of evidence gets absence of ink.

**Radius** 2px on chips/inputs/buttons, 4px on panels (`--radius`). Small but never zero: zero
radius plus hairlines is the broadsheet cliché. **No shadows anywhere**; raised surfaces are a
`--surface` fill plus a `--rule` border (`.panel`).

---

## Type

Two families, three roles. Loaded in `app/layout.tsx` via `next/font/google`.

| Role | Face | Notes |
|---|---|---|
| Display | **Archivo**, `font-stretch: 125%`, w600–700 | `axes: ["wdth"]` is **required** — without it next/font ships only the weight axis and `font-stretch` silently does nothing |
| Body | **Archivo**, `font-stretch: 100%`, w400–600 | the *same face*, separated from display only by its width axis |
| Data | **IBM Plex Mono**, w400/500/600 | not variable — the three weights must be listed |

Using one family's width axis to separate display from body is the typographic analogue of the
colour law: one system, varied only where the variation means something.

**Never use Inter** (the look being escaped), **Geist Mono** (ships with `create-next-app`, reads
as an untouched default) or **JetBrains Mono** (the default of this genre).

The scale — classes in `globals.css`, use them rather than ad-hoc `text-*` utilities:

```
.t-display-lg  34px/0.98  wdth125 w700  -0.02em  UPPERCASE
.t-display     22px/1.10  wdth125 w600  -0.01em
.t-eyebrow     11px/1.2   wdth100 w600  +0.14em  UPPERCASE  --quiet
 (body)      14px/1.50  wdth100 w400   — the <body> default, no class needed
.t-body-sm   12.5px/1.45 wdth100 w400
.t-data-lg     17px/1.2   mono w500  tabular
.t-data        13px/1.3   mono w400  tabular
.t-data-xs     11px/1.2   mono w500  tabular  +0.02em
```

**Spacing** 4px base: `4 8 12 16 24 32 48 64`. Dense table rows are `py-[3px]`; list rows `py-4`.
Density over whitespace — this user reads standings tables for fun. Do not pad to a marketing
layout.

---

## Motion

`motion@13` — `import { motion } from "motion/react"`. Shared transitions live in `lib/motion.ts`
(`DRAW`, `REORDER`, `TAP`, `ROW_STAGGER`, `INSTANT`); use them rather than inline durations.

**Motion communicates a state change. It never decorates. Nothing moves while the page is idle.**

Exactly four things move, and each is tied to something that actually changed:

1. **The Spread's entrance** — bars grow *out of the axis*, weakest first, 18ms stagger. The
   direction of growth is what teaches the reader where the centre line is. Fires **once per
   session** (a module-level flag in `spread.tsx`), not per navigation.
2. **Queue / revision reorder** — `layout` on rows, only when the data genuinely produced a
   different list.
3. **The sync elapsed counter** — the only honest progress signal for an operation whose duration
   we cannot predict.
4. **Press feedback** on controls.

Never add: route transitions, parallax, scroll-triggered reveals, ambient/looping animation,
stagger on every list on every navigation.

**Reduced motion is read in JS, not only in CSS.** `useReducedMotion()` in `lib/motion.ts` uses
`useSyncExternalStore` over `matchMedia`. The CSS block in `globals.css` cannot stop a
JS-driven inline transform, so every animated component must branch:
`transition={reduced ? INSTANT : DRAW}` and `initial={animate && !reduced ? {...} : false}`.

---

## Component conventions

- **shadcn/ui is a substrate, not a look.** Only `button`, `input`, `label` are vendored. Its
  vocabulary (`--primary`, `--border`, `--ring`, …) is **remapped** onto the eight tokens in the
  `@theme inline` block rather than edited in the components, so a future `shadcn add` still comes
  out in this palette. Do not edit files in `components/ui/` — remap instead.
- **Real semantic HTML.** The Spread is a `<table>` with `<caption>`, `<thead class="sr-only">`
  and `<th scope="row">`. The Queue is an `<ol>`. Nav is a `<nav>` with `aria-current="page"`.
- **Focus is `--ink`, 2px, 2px offset, `:focus-visible`.** Never an accent colour — that would be
  the one piece of decorative colour in the app.
- **Errors state what happened and how to fix it**, in the interface's voice, carrying the
  *backend's own message* wherever there is one. Never "Something went wrong".
- **Empty screens invite an action** and name the one thing that changes them.
- **Skeletons are the shape of the real thing** at the real row count and pitch, so nothing
  reflows when data lands. Never a spinner where a shape is possible.
- **Wide content scrolls in its own container.** The page body never scrolls sideways.

## Copy

Plain verbs, sentence case, no filler. Name things by what the user controls. **An action keeps
the same verb through the whole flow**: `Sync now` → `Syncing…` → `Synced`. `Mark reviewed` →
`Saving…`. `Link account` → `Linking…` → the account appears.

Never use emoji in headings or buttons. Never write "AI-powered".

---

## Banned — these are the tells, and they are rejected on sight

- purple→blue or any multi-stop gradient as a brand device
- glassmorphism, glow, neon accents on near-black
- bento grids with glowing borders
- emoji in headings or buttons; "✨ AI-powered" copy
- untouched shadcn defaults: Inter, the slate palette, `--radius: 0.625rem` everywhere
- three-column feature cards with lucide icons in rounded squares
- animated mesh/blob backgrounds, floating orbs
- **left-anchored progress bars for the mastery score** — see below
- the three current AI-design clichés: (a) cream `#F4F1EA` + high-contrast serif + terracotta
  `~#D97757`; (b) near-black + a single acid-green or vermilion accent; (c) broadsheet layout,
  hairline rules, zero radius, newspaper columns

### Why the left-anchored bar is banned specifically

`engine/mastery.ts` computes `mastery = 0.5 + (successRate − 0.5) × confidence`. The score is
**centred on 0.5 by construction** and is a confidence-weighted *belief*, not a fraction of
anything completed. A bar growing from zero silently asserts "x% of the way through this topic",
which is a claim the number does not make, and it renders thin evidence as *small* when thin
evidence actually means *near neutral*.

So bars diverge from a central axis: left is deficit, right is surplus, length is distance from
neutral. Two calibration marks are drawn and **both are real engine constants** — `0.50` (the
prior) and `0.60` (`WEAK_THRESHOLD`). If you draw a new chart of this number, use the same
geometry.

---

## The signature elements

- **The Spread** (`components/spread.tsx`) — all 32 topics at once, weakest first, diverging from
  the neutral axis, unmeasured topics in a different register below a labelled break. It is the
  product thesis made literal and the only loud thing in the app. Everything else stays quiet so
  it can be.
- **Plate I** (`components/plate.tsx`) — the static sibling on `/login` and `/register`, a
  hand-written SVG rendering a **real measured profile** (543 submissions, 19 measured topics, 13
  unmeasured). Not a mock-up. Exported to `docs/plate-i-the-spread.{svg,png,pdf}`.

Spend the boldness in one place. If a new screen wants to be loud, it is probably wrong.
