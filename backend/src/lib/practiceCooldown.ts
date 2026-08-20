// The hint gate: arithmetic on two timestamps, and no model call anywhere in the
// decision. See architecture.md 11.

// Tuned from felt experience. NOT scaled by difficultyBand - that column is
// normalized across two providers with different scales, so a UX rule keyed to it
// would inherit the noise.
const START_TO_L1_MS = 10 * 60_000;
const L1_TO_L2_MS = 10 * 60_000;
const L2_TO_L3_MS = 15 * 60_000;

export const MAX_HINT_LEVEL = 3;

// Indexed by level - 1, matching SESSION_HINT_SYSTEM_PROMPTS.
const COOLDOWN_MS = [START_TO_L1_MS, L1_TO_L2_MS, L2_TO_L3_MS];

// No elapsed time interpolated: the client already renders the countdown, and the
// same number in prose is a second clock that can disagree with it.
const COOLDOWN_MESSAGE = [
  "Before the first hint, write down what the constraints rule out.",
  "Read the first hint again. Name the property it points at before asking for another.",
  "You have the technique. Try to build it wrong once before asking for the shape.",
];

export const EXHAUSTED_MESSAGE = "All three hints are out. What is left is the work.";

export const UNAVAILABLE_MESSAGE =
  "Hints are unavailable right now. Your clock is untouched.";

export type HintGate =
  | { state: "READY"; level: number }
  | { state: "COOLDOWN"; level: number; secondsRemaining: number; message: string }
  | { state: "EXHAUSTED"; message: string };

// `now` is injectable so the schedule can be walked end to end without editing the
// constants above and shipping the tuned-down values by accident.
export function evaluateHintGate(
  startedAt: Date,
  issuedAt: Date[],
  now: Date = new Date()
): HintGate {
  // Levels are contiguous 1..n: the route issues issuedAt.length + 1 and the unique
  // on (sessionId, level) rejects a duplicate, so there is never a gap to step over.
  const level = issuedAt.length + 1;

  if (level > MAX_HINT_LEVEL) {
    return { state: "EXHAUSTED", message: EXHAUSTED_MESSAGE };
  }

  // Level 1 measures from the session start, every later level from the previous
  // reveal - so the clock restarts on each hint instead of running down unread.
  const anchor = issuedAt[issuedAt.length - 1] ?? startedAt;
  const remainingMs = anchor.getTime() + COOLDOWN_MS[level - 1] - now.getTime();

  if (remainingMs > 0) {
    return {
      state: "COOLDOWN",
      level,
      secondsRemaining: Math.ceil(remainingMs / 1000),
      message: COOLDOWN_MESSAGE[level - 1],
    };
  }

  return { state: "READY", level };
}
