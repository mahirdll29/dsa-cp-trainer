// Formatting only. Every helper exists because the same value is rendered in more
// than one place and must look identical in all of them. Nothing here computes
// anything - the backend owns all arithmetic.

import type { DifficultyBand } from "./types";

// Four decimal places always, including trailing zeroes: 4dp is the true stored
// precision, and a fixed width is what lets a column of scores line up.
export function formatScore(score: number): string {
  return score.toFixed(4);
}

// The evidence behind a score, which is what stops "weak" being misread: 0.5333 with
// 2/2 solved is not someone who failed, it is someone we have barely any data on.
export function formatEvidence(solvedCount: number, attemptedCount: number): string {
  return `${solvedCount}/${solvedCount + attemptedCount}`;
}

// The no-data glyph. Never "0", never "0.0000", never empty - each of those reads as
// a value, and the whole point is that there is no value.
export const NO_DATA = "—";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Deliberately coarse: a precise "2h 14m ago" implies a freshness guarantee that an
// on-demand import does not have.
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

// Shown alongside the relative age rather than instead of it: "2h ago" answers
// "should I resync", the exact time answers "is this the run I just did". The
// explicit locale matters - the browser default renders differently per visitor and
// a date column that changes shape cannot be aligned.
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

// How LATE an item is changes what it means: twelve days past the window is a
// different situation from today. Three buckets, because three is what the palette
// can encode honestly.

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

// The only place a data value becomes a colour. Colour is reserved for data
// semantics, and the three hues encode ONE axis - "how hard is this for you" - which
// is why difficulty and mastery share them.
//
// Colour is never the only signal: every difficulty chip also prints its raw value,
// every mastery bar has a direction, every urgency prints its label.

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

export function providerTag(provider: "CODEFORCES" | "LEETCODE"): string {
  return provider === "CODEFORCES" ? "CF" : "LC";
}


// The session clock and the hint countdown, both tabular so neither jitters as the
// digits change. Hours appear only once there are hours, so a normal session reads
// as mm:ss rather than 00:14:32.
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  const mmss = `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

// Sessions are minutes to hours long, so relativeTime's day-scale buckets are the
// wrong instrument for one.
export function formatDuration(startIso: string, endIso: string): string {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return NO_DATA;
  return formatClock((end - start) / 1000);
}

// A "YYYY-MM-DD" bucket key, not an instant: parsed as UTC so the label cannot slide a
// day in the reader's own timezone, which is the whole point of the server having
// bucketed it already.
export function formatDay(day: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));
}
