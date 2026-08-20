// The one place the project's "no rate limiting" decision is overridden: the ceiling
// here is SHARED and external. The Groq key allows 8,000 tokens/minute, so ~25 calls
// exhaust the AI feature for every user of that key, not just the one making them.
//
// In-memory and per-process, so a restart resets it and two instances would each
// permit the full rate. Fine at one instance, which is what this deploys.

// Six per user per rolling minute: at ~320 tokens a call, four concurrent users still
// sit inside the 8,000-token budget.
const MAX_CALLS = 6;
const WINDOW_MS = 60_000;

// Sliding, not fixed: a fixed window permits twelve calls in two seconds across the
// boundary.
const callsByUser = new Map<string, number[]>();

export type RateLimitResult =
  | { allowed: true }
  // Seconds until the oldest call leaves the window, so it is a truthful Retry-After.
  | { allowed: false; retryAfterSeconds: number };

// Records as well as checks - a separate check()/record() pair would be forgotten.
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
