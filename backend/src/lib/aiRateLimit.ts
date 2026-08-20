// The one place the project's "no rate limiting" decision is overridden, because the
// cost here is different and measured. Elsewhere the cost of no limiting is our own
// CPU; here it is a SHARED EXTERNAL CEILING - this Groq key allows 8,000 tokens per
// minute, and at ~320 tokens a call about 25 calls in a minute exhausts the AI
// feature for every user of that key, not just the one making them.
//
// In-memory and per-process: it does not survive a restart, and two instances would
// each permit the full rate. Fine at one instance, which is what this deploys.

// Six per user per rolling minute: at ~320 tokens a call, four concurrent users still
// sit inside the 8,000-token budget.
const MAX_CALLS = 6;
const WINDOW_MS = 60_000;

// A sliding window, not a fixed one. A fixed window permits a double burst across the
// boundary - six calls at 11:59:59 and six more at 12:00:01 is twelve in two seconds,
// all legal.
const callsByUser = new Map<string, number[]>();

export type RateLimitResult =
  | { allowed: true }
  // Seconds until the oldest call leaves the window, so it is a truthful Retry-After.
  | { allowed: false; retryAfterSeconds: number };

// Records the call as well as checking it. A separate check()/record() pair would
// invite a caller to do one and forget the other, and the failure would be silent.
export function consumeAiRateLimit(
  userId: string,
  now: number = Date.now()
): RateLimitResult {
  const cutoff = now - WINDOW_MS;

  // Pruned on read, so the map cannot grow one entry per user forever.
  const recent = (callsByUser.get(userId) ?? []).filter(
    (timestamp) => timestamp > cutoff
  );

  if (recent.length >= MAX_CALLS) {
    // Not stored back: a rejected call must not extend the window, or a user hammering
    // the endpoint would push their own reset further out with every attempt and could
    // never recover.
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
