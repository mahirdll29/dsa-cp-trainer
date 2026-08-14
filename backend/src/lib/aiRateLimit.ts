// ---------------------------------------------------------------------------
// PER-USER RATE LIMIT ON THE AI ROUTES.
//
// architecture.md 2.7 decision 6 records "no rate limiting" as a project-wide
// known gap, and this module deliberately breaks that. The reason is not that
// rate limiting is generally good — it is that the COST IS DIFFERENT HERE, and
// measurably so.
//
// In Module 2 the cost of no limiting was CPU: bcrypt burns ~100 ms per login
// attempt, so a flood degrades the attacker's own experience and ours. Here the
// cost is a SHARED, EXTERNAL CEILING. Measured on this project's Groq key:
//
//     x-ratelimit-limit-tokens: 8000        (per minute)
//     x-ratelimit-limit-requests: 1000
//
// One /api/ai/explain call costs roughly 320 tokens. So about 25 calls in a
// minute exhausts the token budget FOR EVERY USER OF THAT KEY, not just for the
// one making them. A single user in a refresh loop can switch the AI feature off
// for everybody, and nothing else in the system would report why.
//
// That is a different class of problem from a user burning their own CPU quota,
// and roughly fifteen lines is a proportionate answer to it.
//
// THE HONEST COSTS, both real:
//   - The state is IN MEMORY. It does not survive a restart, so a process
//     bounce hands everyone a fresh allowance.
//   - It is PER PROCESS. Two instances behind a load balancer would each permit
//     the full rate, so the effective limit doubles.
// Both are fine at one instance, which is what this project deploys. The upgrade
// path is Redis or a table keyed on (userId, window) — and it is an upgrade,
// not a rewrite, because the call site below would not change.
// ---------------------------------------------------------------------------

// Six calls per rolling minute. Sized against the shared ceiling above rather
// than picked for feel: at ~320 tokens a call, six per user per minute means
// four concurrent active users still sit inside the 8,000-token budget. It is
// also comfortably more than a human clicking "explain" on a twelve-item list
// would ever need in one sitting.
const MAX_CALLS = 6;
const WINDOW_MS = 60_000;

// userId -> the timestamps of that user's recent calls, oldest first.
//
// A SLIDING WINDOW, not a fixed one. A fixed window (a counter reset every
// minute on the clock) permits a double burst across the boundary: six calls at
// 11:59:59 and six more at 12:00:01 is twelve calls in two seconds, all legal.
// Keeping the timestamps costs a handful of numbers per user and removes that
// edge entirely.
const callsByUser = new Map<string, number[]>();

export type RateLimitResult =
  | { allowed: true }
  // Seconds until the oldest call leaves the window — which is exactly when a
  // slot frees up, so it is a truthful Retry-After rather than a guess.
  | { allowed: false; retryAfterSeconds: number };

// Records the call as well as checking it, which is why the name is an
// imperative. A separate check() and record() pair would invite a caller to do
// one and forget the other, and the failure would be silent.
export function consumeAiRateLimit(
  userId: string,
  now: number = Date.now()
): RateLimitResult {
  const cutoff = now - WINDOW_MS;

  // Prune on read. Without this the map grows one entry per user forever and
  // never shrinks — a slow leak that only shows up in a long-running process,
  // which is the worst kind to diagnose. Doing it here means the work is
  // proportional to actual usage and needs no timer or sweep.
  const recent = (callsByUser.get(userId) ?? []).filter(
    (timestamp) => timestamp > cutoff
  );

  if (recent.length >= MAX_CALLS) {
    // Not stored back: a rejected call must not extend the window, or a user
    // hammering the endpoint would push their own reset further out with every
    // attempt and could never recover. (Module 5 hit the real version of this
    // against the LeetCode wrapper — trap 24, where polling to check whether
    // you are still rate limited extends the rate limit.)
    callsByUser.set(userId, recent);

    const oldest = recent[0];
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + WINDOW_MS - now) / 1000)
    );
    return { allowed: false, retryAfterSeconds };
  }

  recent.push(now);
  callsByUser.set(userId, recent);
  return { allowed: true };
}
