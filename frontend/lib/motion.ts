"use client";

import { useSyncExternalStore } from "react";
import type { Transition } from "motion/react";

// Motion is used to show a STATE CHANGE, never for decoration. Every value below is
// short enough to read as feedback rather than as an effect.

// prefers-reduced-motion, read with useSyncExternalStore rather than state-plus-
// effect: that is the API built for subscribing to an external store, and it avoids
// the synchronous setState in an effect body that React 19's compiler rules flag.
//
// The server snapshot returns false, so SSR renders the animated variant and the
// client corrects on hydration.
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToMotionPreference(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getMotionPreference() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function getServerMotionPreference() {
  return false;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToMotionPreference,
    getMotionPreference,
    getServerMotionPreference
  );
}

// Bars growing out of the axis.
export const DRAW: Transition = {
  duration: 0.42,
  ease: [0.22, 1, 0.36, 1],
};

// Rows changing position after a recompute.
export const REORDER: Transition = {
  duration: 0.34,
  ease: [0.4, 0, 0.2, 1],
};

// Press and hover feedback.
export const TAP: Transition = {
  duration: 0.09,
  ease: "easeOut",
};

// Stagger between Spread rows: 18ms x 32 rows is ~0.6s for the whole block.
export const ROW_STAGGER = 0.018;

// Collapse any transition to nothing. Used instead of branching at each call site.
export const INSTANT: Transition = { duration: 0 };
