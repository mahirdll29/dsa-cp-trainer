"use client";

import { useSyncExternalStore } from "react";
import type { Transition } from "motion/react";

// ---------------------------------------------------------------------------
// MOTION POLICY, IN ONE FILE.
//
// The rule this project follows: MOTION COMMUNICATES A STATE CHANGE. It does
// not decorate, and nothing moves while the page is idle. Concretely, there are
// exactly four moving things in this app and each one is tied to something that
// actually changed:
//
//   1. The Spread's entrance — bars grow OUT OF THE AXIS on first paint. This
//      one is orchestrated rather than incidental: the direction of the growth
//      teaches the reader what the axis means before they read a single label.
//      It fires once per session, not per navigation.
//   2. The Queue reordering — only when a sync or recompute genuinely produced
//      a different list. The list moves because the data moved.
//   3. The sync elapsed counter — the only honest progress signal available for
//      an operation whose duration we cannot predict.
//   4. Press feedback on controls.
//
// Everything else is static. No route transitions, no parallax, no scroll
// effects, no ambient animation.
// ---------------------------------------------------------------------------

// THE REDUCED-MOTION HOOK.
//
// globals.css already neutralises CSS animations under prefers-reduced-motion,
// but that CANNOT reach a JavaScript-driven layout animation — motion sets
// inline transforms frame by frame, and no stylesheet rule stops it. So the
// preference has to be read in JS as well, and it is read HERE, once, rather
// than in each animated component.
//
// IMPLEMENTED WITH useSyncExternalStore, WHICH IS WHAT IT IS FOR. The obvious
// version — useState(false) plus an effect that reads matchMedia and calls
// setState — works, but it deliberately renders once with the wrong answer and
// then corrects, which is a cascading render on every mount and is exactly the
// pattern React 19's compiler rules flag. A media query IS an external store,
// so subscribing to it directly is both the sanctioned API and the simpler
// code: no effect, no intermediate wrong value.
//
// The three arguments matter separately:
//   subscribe          re-reads whenever the OS setting is toggled WHILE THE
//                      APP IS OPEN — macOS and Windows both apply that live,
//                      and a session that started before the toggle should
//                      honour it after.
//   getSnapshot        the browser's current answer.
//   getServerSnapshot  `false`, because `window` does not exist while Next
//                      renders this on the server. False rather than true so
//                      the server-rendered markup matches what a default
//                      browser will paint, avoiding a hydration mismatch.
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

// ---------------------------------------------------------------------------
// THE TRANSITIONS. Three, named for what they are for.
//
// All are short. A measuring instrument that takes a second to settle does not
// feel considered, it feels slow — and every one of these animations sits
// between the user and a number they asked for.
// ---------------------------------------------------------------------------

// Bars growing out of the axis. Eased out so they arrive decisively rather than
// drifting into place.
export const DRAW: Transition = {
  duration: 0.42,
  ease: [0.22, 1, 0.36, 1],
};

// Rows changing position after a recompute. `layout` animations read best
// slightly slower than a draw, because the eye has to track an object moving
// rather than a shape resolving.
export const REORDER: Transition = {
  duration: 0.34,
  ease: [0.4, 0, 0.2, 1],
};

// Press and hover feedback. Fast enough to feel like a direct response to a
// finger rather than an animation of one.
export const TAP: Transition = {
  duration: 0.09,
  ease: "easeOut",
};

// Stagger between Spread rows. 18ms x 32 rows is ~570ms of cascade over a
// 420ms draw — the last bar starts before the first has finished, so the block
// reads as one gesture rather than as thirty-two separate ones.
export const ROW_STAGGER = 0.018;

// Collapse any transition to nothing. Used instead of branching at every call
// site, so a component reads `transition={reduced ? INSTANT : DRAW}` and the
// reduced-motion path is impossible to leave out by accident.
export const INSTANT: Transition = { duration: 0 };
