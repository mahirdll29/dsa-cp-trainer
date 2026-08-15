// ---------------------------------------------------------------------------
// Formatting helpers. Every one of these exists because the same value is
// rendered in more than one place and MUST look identical in all of them — a
// mastery score shown as "0.3667" on the dashboard and "0.37" in a tooltip
// would read as two different numbers.
//
// Nothing here computes anything. The backend owns all arithmetic; this file
// only decides how an already-computed value is spelled.
// ---------------------------------------------------------------------------

import type { DifficultyBand } from "./types";

// FOUR DECIMAL PLACES, ALWAYS, INCLUDING TRAILING ZEROES.
//
// The engine rounds to 4dp when it stores the score, so 4 is the true precision
// and showing fewer would discard real information. Padding to a fixed width is
// what lets a column of scores line up under tabular figures: "0.6000" and
// "0.3667" occupy the same space, "0.6" and "0.3667" do not.
export function formatScore(score: number): string {
  return score.toFixed(4);
}

// The evidence behind a score, which is the thing that stops "weak" being
// misread. A topic at 0.5333 with 2/2 solved is not someone who failed — it is
// someone the engine has barely any evidence about. Showing solved-over-total
// next to the score is what makes that legible without a paragraph.
export function formatEvidence(solvedCount: number, attemptedCount: number): string {
  return `${solvedCount}/${solvedCount + attemptedCount}`;
}

// THE NO-DATA GLYPH. An em dash, used everywhere a number would otherwise go
// for an unmeasured topic. Never "0", never "0.0000", never an empty string —
// each of those reads as a value, and the entire point is that there is no
// value. One constant so every column agrees.
export const NO_DATA = "—";

// ---------------------------------------------------------------------------
// TIME
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Relative age, for `lastSyncedAt`. Deliberately coarse: the user needs to know
// whether their numbers are minutes or weeks old, and a precise "2h 14m ago"
// implies a freshness guarantee an on-demand import does not have.
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "never";

  const elapsed = now - then;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  return `${Math.floor(elapsed / DAY)}d ago`;
}

// The absolute timestamp, shown ALONGSIDE the relative one rather than instead
// of it. "2h ago" answers "should I resync"; the exact time answers "is this the
// run I just did". Both questions get asked, so both are printed.
//
// The explicit locale and options matter: left to the browser's default this
// renders differently for every visitor, and a date column that changes shape
// between machines cannot be aligned.
export function absoluteTime(iso: string | null): string {
  if (!iso) return NO_DATA;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NO_DATA;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

// ---------------------------------------------------------------------------
// REVISION URGENCY
//
// A due item is not just due or not due — how LATE it is changes what it means.
// The spacing effect says a review works best just before you would have
// forgotten; twelve days past that window is a different situation from today,
// and the interface should say so. Three buckets, because three is what the
// palette can encode honestly.
// ---------------------------------------------------------------------------

export type Urgency = "today" | "soon" | "late";

export function overdueBucket(dueAt: string, now: number = Date.now()): Urgency {
  const due = new Date(dueAt).getTime();
  const daysLate = Math.floor((now - due) / DAY);
  if (daysLate <= 0) return "today";
  if (daysLate <= 7) return "soon";
  return "late";
}

export function overdueLabel(dueAt: string, now: number = Date.now()): string {
  const due = new Date(dueAt).getTime();
  const daysLate = Math.floor((now - due) / DAY);
  if (daysLate <= 0) return "today";
  return `${daysLate}d overdue`;
}

// ---------------------------------------------------------------------------
// COLOUR MAPPING — the only place a data value becomes a colour.
//
// THE LAW: colour is reserved for data semantics, and the three hues encode ONE
// axis — "how hard is this for you". That is why difficulty and mastery share
// them: HARD and weak are the same red, EASY and strong the same teal. If a
// fourth meaning ever wants a colour, it has to justify itself against this
// function, which is the point of the colour living in one place.
//
// COLOUR IS NEVER THE ONLY SIGNAL. Every difficulty chip also prints its
// `difficultyRaw` text, every mastery bar also has a DIRECTION (left of the
// axis or right of it), and every urgency also prints its label. Someone who
// cannot separate red from teal loses nothing.
// ---------------------------------------------------------------------------

export function bandColorClass(band: DifficultyBand): string {
  switch (band) {
    case "EASY":
      return "text-surplus";
    case "MEDIUM":
      return "text-median";
    case "HARD":
      return "text-deficit";
  }
}

export function urgencyColorClass(urgency: Urgency): string {
  switch (urgency) {
    case "today":
      return "text-ink";
    case "soon":
      return "text-median";
    case "late":
      return "text-deficit";
  }
}

// Two-letter provider tags. Codeforces and LeetCode are "CF" and "LC" to
// everyone who uses them, and the abbreviation is what fits in a dense row.
export function providerTag(provider: "CODEFORCES" | "LEETCODE"): string {
  return provider === "CODEFORCES" ? "CF" : "LC";
}

export function providerName(provider: "CODEFORCES" | "LEETCODE"): string {
  return provider === "CODEFORCES" ? "Codeforces" : "LeetCode";
}
