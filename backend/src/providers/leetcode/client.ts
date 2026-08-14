// ---------------------------------------------------------------------------
// THE ONLY FILE IN THIS PROJECT THAT TALKS TO THE LEETCODE WRAPPER.
//
// Same rule as providers/codeforces/client.ts, and here it matters MORE.
//
// LeetCode has NO official public API. Everything below goes through
// alfa-leetcode-api, a community-maintained wrapper around LeetCode's internal
// GraphQL endpoint. It is unofficial twice over — the wrapper can change, and
// the GraphQL schema it wraps can change underneath IT, without notice to
// anybody. Codeforces was the stable one. This is not.
//
// So the isolation rule is the whole defence: when a field gets renamed or an
// endpoint starts returning something else, the blast radius is this one file.
// Nothing below leaks a URL, a header or a raw response shape to the rest of
// the codebase — callers get plain typed objects or a typed error.
// ---------------------------------------------------------------------------

// CONFIGURABLE BASE URL — the practical consequence of "unofficial".
//
// The public instance can go down, get rate limited, or be abandoned. Putting
// the host in an env var means self-hosting the wrapper (it ships a Docker
// image) is a CONFIG CHANGE, not a code change. That option is why this is an
// env var and not a constant.
//
// UNLIKE JWT_SECRET (architecture.md 4.8) this does NOT use requireEnv and
// fail fast. There is no security consequence to a default, and a missing value
// must not stop the whole server booting for users who never touch LeetCode.
// The default IS the documented public instance.
//
// Read at module scope, which is safe because both entry points (server.ts and
// prisma/sync-lc-problems.ts) import "dotenv/config" before importing anything
// that reaches this file — see session-handoff trap 3.
const LEETCODE_API_URL = (
  process.env.LEETCODE_API_URL || "https://alfa-leetcode-api.onrender.com"
).replace(/\/+$/, ""); // trailing slash would produce "host//problems"

// 45 SECONDS, AND THE NUMBER IS NOT ARBITRARY.
//
// Measured warm latency against the public instance: 0.36-0.92 s. So this is a
// HANG DETECTOR, not a tuning knob — nothing healthy comes anywhere near it.
//
// But the instance runs on Render's free tier, which SPINS DOWN after idle. A
// cold start takes 30-60 s, so Module 4's 30 s would fail every first request
// of the day, and the 10 s a reasonable person would guess fails always.
//
// THE SUBTLE PART: 45 s plus the retry is deliberately better than a bare 60 s.
// Our first request is what TRIGGERS the boot. Even if we abort at 45 s, Render
// keeps booting; the retry 5 s later lands on an instance that is warm or
// nearly so. The timeout and the retry together ARE the cold-start strategy.
const REQUEST_TIMEOUT_MS = 45_000;

// THE REAL RATE LIMIT, discovered the hard way during verification. The
// wrapper's README says a limit exists without publishing the number, and 60
// consecutive requests during planning produced no 429 at all — which led to
// the wrong conclusion. The actual response headers say:
//
//     ratelimit-policy: 120;w=3600
//     ratelimit: limit=120, remaining=0, reset=1407
//     retry-after: 1407
//     Too many request from this IP, try again in 1 hour
//
// IT IS AN HOURLY QUOTA, NOT A PER-SECOND RATE: 120 requests per hour per IP.
// That distinction changes what spacing is even for. Sleeping between requests
// does NOT buy budget back — 41 requests cost 41 of the 120 whether they are
// sent over 90 seconds or 90 minutes. The only thing that protects the quota is
// not running the catalog repeatedly.
//
// So this interval stays modest: it exists to avoid BURSTING at the instance
// (which is free-tier hosting and deserves the courtesy), not to respect the
// quota, which it cannot influence. Pacing at the quota rate would mean 30 s
// between requests and a 20-minute catalog run, for no benefit.
//
// THE BUDGET, STATED PLAINLY, because it is the real operational constraint:
//   full catalog run   41 requests   (about a third of the hourly quota)
//   one user sync      2 requests    (+1 per gap lookup, capped at 10)
// Three catalog runs in one hour will exhaust the quota. Two will not.
const MIN_REQUEST_INTERVAL_MS = 1_500;

// The quota, mirrored here only so the log can say how much is left.
const HOURLY_QUOTA = 120;

// ONE bounded retry, exactly as Module 4. A retry loop against free-tier
// hosting is a self-inflicted outage: the instance is slow because it is
// struggling, and hammering it is how a blip becomes an outage.
//
// VERIFICATION CONFIRMED THE BOUND IS RIGHT, from the opposite direction than
// expected. Against a spent hourly quota the server says retry-after: 1407
// SECONDS. No backoff worth writing will outlast that, so the retry is
// correctly useless there — it tries once, gives up, and surfaces a clean
// RATE_LIMITED instead of spinning. A more elaborate backoff would have burned
// more of a quota that was already gone.
const MAX_RETRIES = 1;
const RETRY_BACKOFF_MS = 5_000;

// ---------------------------------------------------------------------------
// ERRORS — a typed `kind`, so callers never string-match on a message.
// Same vocabulary as CodeforcesError, so routes/leetcode.ts reads like
// routes/codeforces.ts.
// ---------------------------------------------------------------------------

export type LeetcodeErrorKind =
  | "NOT_FOUND" // the username does not exist -> the route returns 404
  | "RATE_LIMITED" // 429, or 403 after the retry
  | "TIMEOUT" // AbortController fired
  | "UNAVAILABLE" // 5xx, DNS failure, connection reset, HTML error page
  | "MALFORMED"; // we got JSON but not a shape we recognise

export class LeetcodeError extends Error {
  constructor(
    public readonly kind: LeetcodeErrorKind,
    message: string
  ) {
    super(message);
    this.name = "LeetcodeError";
  }
}

// ---------------------------------------------------------------------------
// SHAPES WE READ. Only the fields this project actually uses — the wrapper
// returns far more (acRate, freqBar, likes, companyTagStats, the full HTML
// problem statement) and modelling all of it would be work with no consumer
// plus more surface to break.
// ---------------------------------------------------------------------------

// Difficulty is a NARROWED UNION, not a string, and that is deliberate.
// Problem.difficultyRaw and Problem.difficultyBand are both NOT NULL, and there
// is no sensible default for an unrecognised grade. Making the type only
// admit the three real values means the compiler forces the check to happen
// HERE, once, rather than trusting every downstream caller to remember.
// Same trick as Module 4's classifyProblem returning a narrowed type.
export type LcDifficulty = "Easy" | "Medium" | "Hard";

const DIFFICULTIES: ReadonlySet<string> = new Set(["Easy", "Medium", "Hard"]);

export type LcCatalogProblem = {
  titleSlug: string;
  title: string;
  difficulty: LcDifficulty;
  isPaidOnly: boolean;
  tagSlugs: string[];
};

export type LcSubmission = {
  titleSlug: string;
  title: string;
  submittedAt: Date;
};

export type LcProfile = {
  username: string;
};

// A page of the catalog. `total` is the wrapper's own totalQuestions, used only
// for progress logging — the pagination loop terminates on a SHORT PAGE, never
// on this number (see getProblemsPage).
export type LcProblemsPage = {
  items: LcCatalogProblem[];
  malformed: number;
  total: number;
};

export type LcListResult<T> = {
  items: T[];
  malformed: number;
};

// ---------------------------------------------------------------------------
// THE RATE-LIMIT GATE — identical mechanism to Module 4.
//
// Every outbound request goes through one promise chain, so requests are
// SERIALIZED and spaced regardless of who calls what. The spacing lives here
// rather than at the call sites so a caller cannot forget it, and so the
// catalog crawl's 41 pages inherit it for free.
// ---------------------------------------------------------------------------

let requestQueue: Promise<unknown> = Promise.resolve();
let lastRequestStartedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(async () => {
    const waitFor = lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS - Date.now();
    if (waitFor > 0) await sleep(waitFor);
    lastRequestStartedAt = Date.now();
    return task();
  });

  // THE `.catch` IS LOAD-BEARING (session-handoff trap 13). If the queue tail
  // were the rejecting promise itself, one failure would reject every request
  // scheduled after it, and a single bad username would take down syncing for
  // everybody until the process restarted. We chain on a neutered copy; the
  // real rejection still reaches the caller through `result`.
  requestQueue = result.catch(() => undefined);

  return result;
}

// ---------------------------------------------------------------------------
// ONE HTTP CALL.
//
// THE TRAP, AND IT IS THE EXACT INVERSE OF CODEFORCES'.
//
// Module 4 found that Codeforces returns a GOOD BODY WITH A BAD STATUS: an
// unknown handle is HTTP 400 carrying valid JSON, so `if (!response.ok) throw`
// discards the reason and turns a 404 into a 502.
//
// This wrapper does the opposite: a BAD BODY WITH A GOOD STATUS. Verified
// against the live API:
//
//   GET /zzznotarealuser99xq
//   -> HTTP 200
//      {"errors":[{"message":"That user does not exist.", ...}],
//       "data":{"matchedUser":null, ...}}
//
// So `if (response.ok) { /* success */ }` cheerfully "imports" a user who does
// not exist. The status code carries NO information about whether the request
// worked. Every response has to be inspected on its own terms:
//
//   1. Is it JSON at all? Render serves an HTML error page when the instance
//      is down, and JSON.parse on "<!DOCTYPE html>" throws.
//   2. Is there a GraphQL `errors` array? If so it failed, whatever the status.
//   3. Do the specific fields we read exist, with the right types?
//
// Hand-written, no Zod (CLAUDE.md).
// ---------------------------------------------------------------------------

async function callOnce(path: string): Promise<unknown> {
  const url = `${LEETCODE_API_URL}${path}`;

  // AbortController is the ONLY way to bound fetch — it has no timeout option
  // and will otherwise wait as long as the socket stays open. Without this a
  // hung upstream holds our HTTP request open AND holds the SYNCING lock.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    // An aborted fetch rejects, so "did we time out?" is answered by the
    // signal, not by inspecting the error message.
    if (controller.signal.aborted) {
      throw new LeetcodeError(
        "TIMEOUT",
        `LeetCode ${path} timed out after ${REQUEST_TIMEOUT_MS} ms`
      );
    }
    throw new LeetcodeError(
      "UNAVAILABLE",
      `LeetCode ${path} could not be reached: ${(error as Error).message}`
    );
  } finally {
    // Always clear it. A pending timer keeps the event loop alive, so leaking
    // one per request makes the process hang on shutdown for up to 45 s.
    clearTimeout(timer);
  }

  // THE QUOTA IS ONLY VISIBLE IN HEADERS, so it is read before anything else.
  // A caller that makes 41 requests has a real interest in knowing it has 79
  // left, and there is nowhere else to learn it.
  recordQuota(response);

  // Step 1: is it JSON at all?
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not JSON. TWO REAL CASES, and they must not be conflated:
    //
    //   429 -> the rate-limit body is PLAIN TEXT ("Too many request from this
    //          IP, try again in 1 hour"), not JSON. Verified live. A handler
    //          that only looked for a JSON error envelope would mislabel a
    //          quota exhaustion as a dead server.
    //   else -> an HTML error page from Render, or a proxy interstitial.
    if (response.status === 429) {
      throw new LeetcodeError("RATE_LIMITED", rateLimitMessage(response, path));
    }
    throw new LeetcodeError(
      "UNAVAILABLE",
      `LeetCode ${path} returned non-JSON (HTTP ${response.status}) — the API instance is probably down`
    );
  }

  // Step 2: a GraphQL error envelope, REGARDLESS of the HTTP status.
  const record = asRecord(body);
  if (record && Array.isArray(record.errors) && record.errors.length > 0) {
    const first = asRecord(record.errors[0]);
    const message =
      first && typeof first.message === "string"
        ? first.message
        : "no reason given";

    // The wrapper passes LeetCode's own wording straight through. This is the
    // only signal separating "you asked for something that isn't there" from
    // "something broke", so it is matched loosely and defaults to UNAVAILABLE
    // — misreporting a real outage as a 404 would be worse than the reverse.
    if (/does not exist|not found/i.test(message)) {
      throw new LeetcodeError("NOT_FOUND", message);
    }
    throw new LeetcodeError("UNAVAILABLE", `LeetCode ${path}: ${message}`);
  }

  // Only now is the status code worth consulting, as a fallback.
  if (!response.ok) {
    if (response.status === 429 || response.status === 403) {
      throw new LeetcodeError("RATE_LIMITED", rateLimitMessage(response, path));
    }
    throw new LeetcodeError(
      "UNAVAILABLE",
      `LeetCode ${path} returned HTTP ${response.status}`
    );
  }

  return body;
}

// ---------------------------------------------------------------------------
// QUOTA VISIBILITY
//
// The hourly budget is reported ONLY in response headers, so without this the
// catalog script would have no way to tell "39 requests left" from "plenty".
// Logged at thresholds rather than every request — 41 lines of "remaining=87"
// is noise, but crossing below a quarter of the quota is worth knowing before
// the next run rather than after it fails.
// ---------------------------------------------------------------------------

// Thresholds, not every request: a catalog run makes 41 calls and 41 lines of
// "remaining=87" is noise that trains you to ignore the one line that matters.
// Each threshold fires at most once per process.
const QUOTA_WARN_AT = [30, 15, 5];
const warnedAt = new Set<number>();

function parseRemaining(response: Response): number | null {
  // Express-rate-limit emits a combined header: "limit=120, remaining=0, reset=1407"
  const combined = response.headers.get("ratelimit");
  if (combined) {
    const match = /remaining=(\d+)/.exec(combined);
    if (match) return Number(match[1]);
  }
  // Older/alternate spelling, kept because this is an unofficial service and
  // the header format is not a contract.
  const legacy = response.headers.get("ratelimit-remaining");
  if (legacy !== null && legacy !== "" && Number.isFinite(Number(legacy))) {
    return Number(legacy);
  }
  return null;
}

function recordQuota(response: Response): void {
  const remaining = parseRemaining(response);
  if (remaining === null) return;

  for (const threshold of QUOTA_WARN_AT) {
    if (remaining <= threshold && !warnedAt.has(threshold)) {
      warnedAt.add(threshold);
      console.warn(
        `[leetcode] rate-limit budget low: ${remaining}/${HOURLY_QUOTA} requests left this hour`
      );
      break;
    }
  }
}

function rateLimitMessage(response: Response, path: string): string {
  // retry-after is in SECONDS and can be ~1400 of them. Reporting it is the
  // difference between a user retrying uselessly for twenty minutes and one
  // who knows to come back later.
  const retryAfter = response.headers.get("retry-after");
  const seconds = Number(retryAfter);
  const suffix =
    Number.isFinite(seconds) && seconds > 0
      ? ` — retry in ${Math.ceil(seconds / 60)} min`
      : "";
  return `LeetCode ${path} hit the rate limit (${HOURLY_QUOTA}/hour)${suffix}`;
}

// Only conditions that might genuinely differ a moment later are retried.
// NOT_FOUND and MALFORMED are deterministic — the user will still not exist in
// five seconds, and the shape will still be wrong — so retrying them only
// doubles the latency of a guaranteed failure.
const RETRYABLE: ReadonlySet<LeetcodeErrorKind> = new Set([
  "RATE_LIMITED",
  "TIMEOUT",
  "UNAVAILABLE",
]);

async function call(path: string): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await serialized(() => callOnce(path));
    } catch (error) {
      lastError = error;

      const retryable =
        error instanceof LeetcodeError && RETRYABLE.has(error.kind);
      if (!retryable || attempt === MAX_RETRIES) throw error;

      console.warn(
        `[leetcode] ${path} failed (${(error as LeetcodeError).kind}), ` +
          `retrying once in ${RETRY_BACKOFF_MS} ms`
      );
      await sleep(RETRY_BACKOFF_MS);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// VALIDATION HELPERS
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

// topicTags is `[{ name, id, slug }]`. We read ONLY the slug — the mapping
// table in tags.ts is keyed on it, and `name` carries non-ASCII characters
// ("Knuth–Morris–Pratt" uses an en-dash) that we would gain nothing by
// handling. Validating a field we never read is busywork that breaks the
// import when something irrelevant changes upstream.
function parseTagSlugs(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return []; // untagged is legal
  if (!Array.isArray(raw)) return null;

  const slugs: string[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record || typeof record.slug !== "string" || record.slug === "") {
      return null; // a malformed tag list means we misunderstand the shape
    }
    slugs.push(record.slug);
  }
  return slugs;
}

function parseDifficulty(raw: unknown): LcDifficulty | null {
  if (typeof raw !== "string" || !DIFFICULTIES.has(raw)) return null;
  return raw as LcDifficulty;
}

// ---------------------------------------------------------------------------
// THE FOUR CALLS
// ---------------------------------------------------------------------------

// HANDLE VALIDATION — and this endpoint is the ONLY one that can do it.
//
// Verified against the live API: /:username/acSubmission for a nonexistent user
// returns HTTP 200 with {"count":0,"submission":[]}, which is BYTE-IDENTICAL to
// a real user who has solved nothing. So a bad username can never be detected
// during a sync; it has to be caught at link time, here, or not at all.
//
// Returns the wrapper's own spelling of the username rather than echoing the
// caller's input, for the same reason Module 4 returns Codeforces' canonical
// handle: LeetCode matches usernames case-insensitively, so storing "MahirDLL"
// when the account is "mahirdll" leaves our data disagreeing with every link we
// render.
export async function getProfile(username: string): Promise<LcProfile> {
  const body = await call(`/${encodeURIComponent(username)}`);

  const record = asRecord(body);
  if (!record || typeof record.username !== "string" || record.username === "") {
    // A user that does not exist already threw NOT_FOUND from the `errors`
    // check in callOnce. Reaching here means the shape itself is wrong.
    throw new LeetcodeError(
      "MALFORMED",
      "LeetCode profile response contained no usable username"
    );
  }

  return { username: record.username };
}

// ONE PAGE OF THE CATALOG — the candidate pool the engine draws from.
//
// MEASURED CONSTRAINTS, none of which are documented:
//
//   limit is HARD-CAPPED AT 100. limit=500/1000/2000/5000 all return exactly
//   100 rows (byte-identical bodies). It IS honoured downward (limit=5 -> 5).
//   So the catalog is 41 pages, not one call — the opposite of Codeforces,
//   where the entire problemset arrives in a single response.
//
//   skip PAST THE END CLAMPS instead of emptying: with 4019 problems,
//   skip=4000 returns 19 rows and skip=4019 returns THE SAME 19 ROWS AGAIN.
//   Only skip=4100 returns []. A loop that terminated on an empty page would
//   therefore re-import a page before stopping. The caller terminates on a
//   SHORT page instead, which never enters the clamped region at all — the
//   trap is designed out rather than guarded against.
export async function getProblemsPage(
  limit: number,
  skip: number
): Promise<LcProblemsPage> {
  const body = await call(`/problems?limit=${limit}&skip=${skip}`);

  const record = asRecord(body);
  if (!record) {
    throw new LeetcodeError(
      "MALFORMED",
      "LeetCode /problems did not return an object"
    );
  }

  // A malformed TOP-LEVEL shape throws: it means we have misunderstood the
  // endpoint entirely, and importing a partial result would be worse than
  // failing. A malformed ELEMENT is skipped and counted (below).
  if (!Array.isArray(record.problemsetQuestionList)) {
    throw new LeetcodeError(
      "MALFORMED",
      "LeetCode /problems returned no problemsetQuestionList array"
    );
  }

  const items: LcCatalogProblem[] = [];
  let malformed = 0;

  for (const raw of record.problemsetQuestionList) {
    const problem = asRecord(raw);
    if (!problem) {
      malformed++;
      continue;
    }

    // Every field below lands in a NOT NULL column, so every one is required.
    // Note `title` here — /select calls the same thing `questionTitle`.
    const { titleSlug, title } = problem;
    if (typeof titleSlug !== "string" || titleSlug === "") {
      malformed++;
      continue;
    }
    if (typeof title !== "string" || title === "") {
      malformed++;
      continue;
    }

    const difficulty = parseDifficulty(problem.difficulty);
    if (!difficulty) {
      malformed++;
      continue;
    }

    const tagSlugs = parseTagSlugs(problem.topicTags);
    if (!tagSlugs) {
      malformed++;
      continue;
    }

    // Absent is treated as free rather than rejected: it is a boolean flag we
    // use for filtering, not a value we store, and defaulting to "free" cannot
    // corrupt a row. Present-but-not-a-boolean IS rejected, because that means
    // the field changed meaning.
    if (
      problem.isPaidOnly !== undefined &&
      typeof problem.isPaidOnly !== "boolean"
    ) {
      malformed++;
      continue;
    }

    items.push({
      titleSlug,
      title,
      difficulty,
      isPaidOnly: problem.isPaidOnly === true,
      tagSlugs,
    });
  }

  return {
    items,
    malformed,
    total:
      typeof record.totalQuestions === "number" ? record.totalQuestions : 0,
  };
}

// THE USER'S RECENT ACCEPTED SUBMISSIONS.
//
// THE DEFINING LIMITATION OF THIS WHOLE MODULE, measured not assumed:
// limit is HARD-CAPPED AT 20. limit=50/100/500/1000 all return exactly 20.
// The test account has 502 solved problems (per /:username/solved) and this
// endpoint will surrender 20 of them. There is no paging parameter and no
// "since" parameter — the other 482 are simply not reachable.
//
// That is why architecture.md records LeetCode mastery as being built on a ~4%
// sample, and it is not something a later version can tune.
//
// Accepted-only by construction: every statusDisplay observed was "Accepted",
// which is what lets the importer write status = SOLVED unconditionally.
export async function getAcceptedSubmissions(
  username: string,
  limit: number
): Promise<LcListResult<LcSubmission>> {
  const body = await call(
    `/${encodeURIComponent(username)}/acSubmission?limit=${limit}`
  );

  const record = asRecord(body);
  if (!record || !Array.isArray(record.submission)) {
    throw new LeetcodeError(
      "MALFORMED",
      "LeetCode /acSubmission returned no submission array"
    );
  }

  const items: LcSubmission[] = [];
  let malformed = 0;

  for (const raw of record.submission) {
    const submission = asRecord(raw);
    if (!submission) {
      malformed++;
      continue;
    }

    const { titleSlug, title } = submission;
    if (typeof titleSlug !== "string" || titleSlug === "") {
      malformed++;
      continue;
    }
    if (typeof title !== "string" || title === "") {
      malformed++;
      continue;
    }

    // TIMESTAMP IS A STRING OF UNIX EPOCH SECONDS: "1786583999". Not a number,
    // not milliseconds, not ISO-8601. Accepting a number too costs one line
    // and covers the wrapper deciding to "fix" the type later.
    const rawTs = submission.timestamp;
    const seconds =
      typeof rawTs === "string"
        ? Number(rawTs)
        : typeof rawTs === "number"
          ? rawTs
          : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      malformed++;
      continue;
    }

    items.push({
      titleSlug,
      title,
      submittedAt: new Date(seconds * 1000),
    });
  }

  return { items, malformed };
}

// ONE PROBLEM'S DETAIL — used only to close the acSubmission gap.
//
// acSubmission gives a titleSlug but NO difficulty and NO tags, and both
// difficulty columns are NOT NULL. So a solved problem missing from our catalog
// cannot be created from submission data alone; this is where the missing
// fields come from. See sync.ts for the cap and the reasoning.
//
// RETURNS null FOR "NO SUCH PROBLEM" rather than throwing, because verified
// against the live API an unknown slug returns HTTP 200 with a body of exactly
// `{}` — no error envelope, no 404. An empty object is a legitimate answer to
// "does this exist", not a failure, and the caller treats it as "skip this
// solve" rather than "abort the sync".
//
// NOTE THE FIELD NAME: this endpoint calls the title `questionTitle`, where
// /problems calls it `title`. Same concept, two names, two endpoints. Reading
// `title` here yields undefined and drives it straight into a NOT NULL column.
export async function getProblemDetail(
  titleSlug: string
): Promise<LcCatalogProblem | null> {
  const body = await call(`/select?titleSlug=${encodeURIComponent(titleSlug)}`);

  const record = asRecord(body);
  if (!record) return null;

  // `{}` — the wrapper's way of saying "no such problem".
  if (Object.keys(record).length === 0) return null;

  const title = record.questionTitle;
  if (typeof title !== "string" || title === "") return null;

  const difficulty = parseDifficulty(record.difficulty);
  if (!difficulty) return null;

  const tagSlugs = parseTagSlugs(record.topicTags);
  if (!tagSlugs) return null;

  // The response echoes titleSlug, but we prefer the one we ASKED for: it is
  // the key we will store under and the key the caller is holding, and letting
  // the response rename it would break the caller's lookup map.
  return {
    titleSlug,
    title,
    difficulty,
    isPaidOnly: record.isPaidOnly === true,
    tagSlugs,
  };
}
