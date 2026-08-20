// The only file in this project that talks to the LeetCode wrapper, and the
// isolation matters more here than it does for Codeforces: this is unofficial twice
// over. The community wrapper can change, and the internal GraphQL schema it wraps
// can change underneath it, without notice to anybody.

// Configurable so self-hosting the wrapper (it ships a Docker image) is a config
// change rather than a code change. Unlike JWT_SECRET this does NOT fail fast: there
// is no security consequence to a default, and a missing value must not stop the
// server booting for users who never touch LeetCode.
const LEETCODE_API_URL = (
  process.env.LEETCODE_API_URL || "https://alfa-leetcode-api.onrender.com"
).replace(/\/+$/, ""); // trailing slash would produce "host//problems"

// 45 s, and the number is not arbitrary. Warm latency is 0.36-0.92 s, so this is a
// hang detector - but the wrapper runs on a free tier that SPINS DOWN when idle and
// cold-starts in 30-60 s. Our first request is what triggers the boot; even if we
// abort at 45 s the instance keeps booting, so the retry 5 s later lands on one that
// is warm. The timeout and the retry together ARE the cold-start strategy.
const REQUEST_TIMEOUT_MS = 45_000;

// THE RATE LIMIT IS AN HOURLY QUOTA, NOT A PER-SECOND RATE: 120 requests/hour/IP
// (ratelimit-policy: 120;w=3600). Sleeping between requests does NOT buy budget back
// - 41 requests cost 41 of the 120 whether sent over 90 seconds or 90 minutes. So
// this interval exists only to avoid bursting at a free-tier instance, not to
// respect the quota, which it cannot influence.
//
// The budget: a full catalog run is ~41 requests, a user sync is 2 (+1 per gap
// lookup, capped at 10). Two catalog runs in an hour is fine; three is not.
const MIN_REQUEST_INTERVAL_MS = 1_500;

// The quota, mirrored here only so the log can say how much is left.
const HOURLY_QUOTA = 120;

// One bounded retry. Against a spent quota the server answers retry-after: ~1400
// SECONDS, so no backoff worth writing outlasts it - the retry is correctly useless
// there, surfacing a clean RATE_LIMITED instead of spinning.
const MAX_RETRIES = 1;
const RETRY_BACKOFF_MS = 5_000;

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

// A narrowed union, not a string: both difficulty columns are NOT NULL and there is
// no sensible default for an unrecognised grade, so the compiler forces the check to
// happen here, once, rather than trusting every downstream caller to remember.
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

// `total` is used only for progress logging - the pagination loop terminates on a
// short page, never on this number.
export type LcProblemsPage = {
  items: LcCatalogProblem[];
  malformed: number;
  total: number;
};

export type LcListResult<T> = {
  items: T[];
  malformed: number;
};

// One promise chain serialises every outbound request, so the catalog crawl's 41
// pages inherit the spacing for free and no caller can forget it.

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

  // Without this .catch the queue tail would be the rejecting promise itself, and one
  // bad username would reject every request scheduled after it until restart.
  requestQueue = result.catch(() => undefined);

  return result;
}

// THE TRAP, AND IT IS THE EXACT INVERSE OF CODEFORCES'. Codeforces returns a good
// body with a bad status; this wrapper returns a BAD BODY WITH A GOOD STATUS:
//
//   GET /zzznotarealuser99xq  ->  HTTP 200
//   {"errors":[{"message":"That user does not exist."}],"data":{"matchedUser":null}}
//
// So `if (response.ok)` cheerfully "imports" a user who does not exist. The status
// code carries NO information. Every response is inspected on its own terms: is it
// JSON at all, is there a GraphQL errors array, do the fields we read exist.

async function callOnce(path: string): Promise<unknown> {
  const url = `${LEETCODE_API_URL}${path}`;

  // AbortController is the only way to bound fetch; without it a hung upstream holds
  // our request open AND holds the SYNCING lock.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    // Answered by the signal, not by the error message.
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
    // A leaked timer keeps the event loop alive and hangs shutdown for up to 45 s.
    clearTimeout(timer);
  }

  // The quota is visible only in headers, so it is read before anything else can throw.
  recordQuota(response);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not JSON. Two real cases that must not be conflated: a 429 body is PLAIN TEXT
    // ("Too many request from this IP, try again in 1 hour"), so a handler looking only
    // for a JSON envelope would mislabel quota exhaustion as a dead server. Anything
    // else is an HTML error page from the host.
    if (response.status === 429) {
      throw new LeetcodeError("RATE_LIMITED", rateLimitMessage(response, path));
    }
    throw new LeetcodeError(
      "UNAVAILABLE",
      `LeetCode ${path} returned non-JSON (HTTP ${response.status}) — the API instance is probably down`
    );
  }

  // A GraphQL error envelope, REGARDLESS of the HTTP status.
  const record = asRecord(body);
  if (record && Array.isArray(record.errors) && record.errors.length > 0) {
    const first = asRecord(record.errors[0]);
    const message =
      first && typeof first.message === "string"
        ? first.message
        : "no reason given";

    // Matched loosely and defaulting to UNAVAILABLE: misreporting a real outage as a
    // 404 would be worse than the reverse.
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

// The hourly budget is reported only in response headers, so without this a caller
// has no way to tell "39 requests left" from "plenty".

// Thresholds, not every request: 41 lines of "remaining=87" trains you to ignore
// the one line that matters. Each threshold fires at most once per process.
const QUOTA_WARN_AT = [30, 15, 5];
const warnedAt = new Set<number>();

function parseRemaining(response: Response): number | null {
  // Express-rate-limit emits a combined header: "limit=120, remaining=0, reset=1407"
  const combined = response.headers.get("ratelimit");
  if (combined) {
    const match = /remaining=(\d+)/.exec(combined);
    if (match) return Number(match[1]);
  }
  // Alternate spelling, kept because this is an unofficial service and the header
  // format is not a contract.
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
  // retry-after is in SECONDS and can be ~1400 of them. Reporting it is the difference
  // between retrying uselessly for twenty minutes and knowing to come back later.
  const retryAfter = response.headers.get("retry-after");
  const seconds = Number(retryAfter);
  const suffix =
    Number.isFinite(seconds) && seconds > 0
      ? ` — retry in ${Math.ceil(seconds / 60)} min`
      : "";
  return `LeetCode ${path} hit the rate limit (${HOURLY_QUOTA}/hour)${suffix}`;
}

// NOT_FOUND and MALFORMED are deterministic, so retrying them only doubles the
// latency of a guaranteed failure.
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

// Only the slug is read - the mapping table is keyed on it, and `name` carries
// non-ASCII we would gain nothing by handling. Validating a field we never read is
// busywork that breaks the import when something irrelevant changes upstream.
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

// THE ONLY ENDPOINT THAT CAN VALIDATE A USERNAME. /:username/acSubmission for a
// nonexistent user returns 200 {"count":0,"submission":[]}, byte-identical to a real
// user who has solved nothing - so a bad username can never be caught during a sync.
// Returns the wrapper's own spelling, since LeetCode matches case-insensitively.
export async function getProfile(username: string): Promise<LcProfile> {
  const body = await call(`/${encodeURIComponent(username)}`);

  const record = asRecord(body);
  if (!record || typeof record.username !== "string" || record.username === "") {
    // A nonexistent user already threw NOT_FOUND in callOnce; reaching here means the
    // shape itself is wrong.
    throw new LeetcodeError(
      "MALFORMED",
      "LeetCode profile response contained no usable username"
    );
  }

  return { username: record.username };
}

// MEASURED CONSTRAINTS, none of them documented:
//   limit is HARD-CAPPED AT 100 (limit=500/1000/5000 all return exactly 100), so the
//   catalog is 41 pages where Codeforces was one call.
//   skip PAST THE END CLAMPS instead of emptying: with 4019 problems skip=4000 gives
//   19 rows and skip=4019 gives THE SAME 19 ROWS AGAIN. Only skip=4100 returns [].
//   The caller therefore terminates on a SHORT page, never an empty one, which never
//   enters the clamped region at all.
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

  // A malformed TOP-LEVEL shape throws - we have misunderstood the endpoint entirely,
  // and a partial import is worse than a failure. A malformed ELEMENT is skipped.
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

    // Every field below lands in a NOT NULL column. Note `title` here - /select calls
    // the same thing `questionTitle`.
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

    // Absent is treated as free rather than rejected: it is a flag we filter on, not a
    // value we store. Present-but-not-a-boolean IS rejected - that means it changed
    // meaning.
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

// THE DEFINING LIMITATION OF THIS MODULE, measured not assumed: limit is HARD-CAPPED
// AT 20. The test account has 502 solved problems and this endpoint will surrender
// 20 of them. There is no paging and no `since` parameter - the other 482 are simply
// unreachable, which is why LeetCode mastery rests on a ~4% sample.
//
// Accepted-only by construction, which is what lets the importer write SOLVED
// unconditionally.
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

    // Timestamp is a STRING of Unix epoch SECONDS ("1786583999") - not a number, not
    // milliseconds, not ISO-8601. Accepting a number too covers the wrapper "fixing" it.
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

// Closes the acSubmission gap: that endpoint gives a titleSlug but no difficulty and
// no tags, and both difficulty columns are NOT NULL.
//
// Returns null rather than throwing for "no such problem", because an unknown slug
// returns HTTP 200 with a body of exactly {} - no error envelope, no 404. That is a
// legitimate answer to "does this exist", so the caller skips the solve rather than
// aborting the sync.
//
// NOTE THE FIELD NAME: this endpoint calls the title `questionTitle` where /problems
// calls it `title`. Reading `title` here yields undefined and drives it into a NOT
// NULL column.
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

  // We prefer the slug we ASKED for over the one echoed back: it is the key we store
  // under and the key the caller's lookup map is holding.
  return {
    titleSlug,
    title,
    difficulty,
    isPaidOnly: record.isPaidOnly === true,
    tagSlugs,
  };
}
