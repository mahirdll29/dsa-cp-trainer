// ---------------------------------------------------------------------------
// THE ONLY FILE IN THIS PROJECT THAT TALKS TO codeforces.com.
//
// That is CLAUDE.md's external-API rule, and the reason for it is blunt: when a
// provider changes a field name, renames a tag or starts rate-limiting harder,
// the blast radius has to be one file you can open and read top to bottom.
// Nothing below this line leaks a URL, a header or a response shape into the
// rest of the codebase — callers get plain typed objects or a typed error.
//
// Codeforces has an OFFICIAL, DOCUMENTED public API (https://codeforces.com/api/),
// which is why this module comes before LeetCode. We still treat every byte it
// returns as untrusted input. "Documented" describes intent, not a guarantee:
// the docs can be stale, a field can be added or dropped without notice, and a
// proxy or captive portal can hand us HTML where we expected JSON. The cost of
// checking is a few lines; the cost of not checking is a malformed row in the
// database that the recommendation engine later trips over.
// ---------------------------------------------------------------------------

const CODEFORCES_API = "https://codeforces.com/api";

// Observed worst case across the accounts profiled while planning this module:
// 2.7 s for tourist's full 5,467-submission history (3.1 MB). 30 s is therefore
// a HANG DETECTOR, not a tuning knob — if we are anywhere near it, something is
// wrong upstream and we want to fail rather than hold a request open.
const REQUEST_TIMEOUT_MS = 30_000;

// Codeforces documents roughly one request per two seconds. 2.1 s buys a little
// headroom against clock jitter without meaningfully slowing a sync (which
// makes two calls).
const MIN_REQUEST_INTERVAL_MS = 2_100;

// ONE bounded retry. Anything more elaborate — exponential backoff over many
// attempts, a dead-letter queue, scheduled resumption — is a job queue, which
// is an explicit v1 non-goal. One retry covers the common transient case (a
// single 403 from bunching, a blip 502) and stops there.
const MAX_RETRIES = 1;
const RETRY_BACKOFF_MS = 5_000;

// ---------------------------------------------------------------------------
// ERRORS — a typed `kind`, so callers never string-match on a message.
//
// The route layer has to turn a failure into an HTTP status. If it did that by
// inspecting error text ("does the message contain 'not found'?") then any
// upstream rewording silently converts a 404 into a 500. The `kind` is our own
// vocabulary and cannot drift underneath us.
// ---------------------------------------------------------------------------

export type CodeforcesErrorKind =
  | "NOT_FOUND" // the handle does not exist -> the route returns 404
  | "RATE_LIMITED" // 403 even after the retry
  | "TIMEOUT" // AbortController fired
  | "UNAVAILABLE" // 5xx, DNS failure, connection reset
  | "MALFORMED"; // the envelope said OK but the shape was not what we read

export class CodeforcesError extends Error {
  constructor(
    public readonly kind: CodeforcesErrorKind,
    message: string
  ) {
    super(message);
    this.name = "CodeforcesError";
  }
}

// ---------------------------------------------------------------------------
// SHAPES WE READ.
//
// These describe only the fields this project actually uses. Codeforces returns
// far more (points, memory consumed, author details, avatars); modelling all of
// it would be work with no consumer, and every extra field is another thing to
// validate and another thing that can change.
//
// Optionality here is not defensiveness — each `?` is a case observed in real
// responses while planning:
//   - contestId is ABSENT on ACMSGURU problems, which carry problemsetName instead
//   - rating is ABSENT on unrated problems (305 of 11,356 in the problemset)
//   - verdict is ABSENT while a submission is still being judged
// ---------------------------------------------------------------------------

export type CfProblem = {
  contestId?: number;
  problemsetName?: string;
  index: string;
  name: string;
  rating?: number;
  tags: string[];
};

export type CfSubmission = {
  problem: CfProblem;
  verdict?: string;
  creationTimeSeconds: number;
};

export type CfRatingChange = {
  contestId: number;
  contestName: string;
  rank: number;
  ratingUpdateTimeSeconds: number;
  oldRating: number;
  newRating: number;
};

export type CfUserInfo = {
  handle: string;
};

// A list result carries the count of elements we threw away for failing
// validation. The caller reports it rather than us swallowing it silently — a
// sync that quietly discarded 400 rows should not look identical to a clean one.
export type CfListResult<T> = {
  items: T[];
  malformed: number;
};

// ---------------------------------------------------------------------------
// THE RATE-LIMIT GATE.
//
// Every outbound request goes through one promise chain, so requests are
// SERIALIZED and spaced regardless of who calls what. Putting the delay here
// rather than at the call sites is the point: a caller cannot forget to space,
// and adding a fifth endpoint later inherits the spacing for free.
//
// THE COST, STATED: this gate is per-process. Two Node instances each keep
// their own and could collectively exceed the documented limit. That is correct
// for the single Railway dyno we deploy and would need rethinking behind a load
// balancer — at which point the honest answer is a shared limiter, not a bigger
// delay here.
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

  // THE `.catch` IS LOAD-BEARING, and its absence is a genuinely nasty bug: if
  // the queue tail were the rejecting promise itself, every request scheduled
  // after a single failure would reject too, and one bad handle would take down
  // syncing for everybody until the process restarted. We chain on a neutered
  // copy so failures do not propagate down the queue — the real rejection still
  // reaches the caller through `result`.
  requestQueue = result.catch(() => undefined);

  return result;
}

// ---------------------------------------------------------------------------
// ONE HTTP CALL, with the timeout and the envelope check.
// ---------------------------------------------------------------------------

type Envelope = {
  status?: unknown;
  result?: unknown;
  comment?: unknown;
};

async function callOnce(
  method: string,
  params: Record<string, string>
): Promise<unknown> {
  const query = new URLSearchParams(params).toString();
  const url = `${CODEFORCES_API}/${method}?${query}`;

  // AbortController is the ONLY way to bound fetch: fetch has no timeout option
  // and will otherwise wait as long as the socket stays open. Without this a
  // hung upstream holds our HTTP request open until the client gives up, and
  // during a sync it would hold the SYNCING lock too.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    // An aborted fetch rejects, so "did we time out?" is answered by the
    // signal, not by the error.
    if (controller.signal.aborted) {
      throw new CodeforcesError(
        "TIMEOUT",
        `Codeforces ${method} timed out after ${REQUEST_TIMEOUT_MS} ms`
      );
    }
    throw new CodeforcesError(
      "UNAVAILABLE",
      `Codeforces ${method} could not be reached: ${(error as Error).message}`
    );
  } finally {
    // Always clear it. A pending timer keeps the event loop alive, so leaking
    // one per request makes the process hang on shutdown for up to 30 s.
    clearTimeout(timer);
  }

  // THE TRAP, VERIFIED AGAINST THE LIVE API: an unknown handle comes back as
  // HTTP 400 with a perfectly good JSON body:
  //
  //   {"status":"FAILED","comment":"handles: User with handle xyz not found"}
  //
  // The obvious `if (!response.ok) throw` would discard that body and report a
  // generic upstream failure — turning what should be a 404 into a 502. So we
  // parse the body FIRST and only fall back to the status code when the body
  // tells us nothing.
  let body: Envelope | null = null;
  try {
    body = (await response.json()) as Envelope;
  } catch {
    body = null; // not JSON at all — an HTML error page from a proxy, say
  }

  if (body && body.status === "FAILED") {
    const comment =
      typeof body.comment === "string" ? body.comment : "no reason given";

    // Codeforces reports "handle not found" and "rate limit exceeded" through
    // the same FAILED envelope, so the comment is the only thing separating a
    // client mistake from a throttle.
    if (comment.includes("not found")) {
      throw new CodeforcesError("NOT_FOUND", comment);
    }
    if (response.status === 403 || comment.includes("limit")) {
      throw new CodeforcesError("RATE_LIMITED", comment);
    }
    throw new CodeforcesError("UNAVAILABLE", `Codeforces ${method}: ${comment}`);
  }

  if (!response.ok) {
    const kind: CodeforcesErrorKind =
      response.status === 403 ? "RATE_LIMITED" : "UNAVAILABLE";
    throw new CodeforcesError(
      kind,
      `Codeforces ${method} returned HTTP ${response.status}`
    );
  }

  if (!body || body.status !== "OK") {
    throw new CodeforcesError(
      "MALFORMED",
      `Codeforces ${method} returned an unrecognised envelope`
    );
  }

  return body.result;
}

// The retry wrapper. Only RATE_LIMITED, TIMEOUT and UNAVAILABLE are worth
// retrying: they are conditions that might differ a moment later. NOT_FOUND and
// MALFORMED are deterministic — the handle will still not exist in five
// seconds, and the shape will still be wrong — so retrying them just doubles
// the latency of a guaranteed failure.
const RETRYABLE: ReadonlySet<CodeforcesErrorKind> = new Set([
  "RATE_LIMITED",
  "TIMEOUT",
  "UNAVAILABLE",
]);

async function call(
  method: string,
  params: Record<string, string>
): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await serialized(() => callOnce(method, params));
    } catch (error) {
      lastError = error;

      const retryable =
        error instanceof CodeforcesError && RETRYABLE.has(error.kind);
      if (!retryable || attempt === MAX_RETRIES) throw error;

      console.warn(
        `[codeforces] ${method} failed (${(error as CodeforcesError).kind}), ` +
          `retrying once in ${RETRY_BACKOFF_MS} ms`
      );
      await sleep(RETRY_BACKOFF_MS);
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// VALIDATION — hand-written, no Zod (CLAUDE.md).
//
// The rule applied throughout: check every field we ACTUALLY READ, and check
// nothing else. Validating fields we ignore is busywork that breaks the import
// when Codeforces changes something irrelevant to us.
//
// A malformed ELEMENT is skipped and counted, never written. A malformed
// TOP-LEVEL shape (result is not an array) throws, because that means we have
// misunderstood the endpoint entirely and importing a partial result would be
// worse than failing.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, method: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new CodeforcesError(
      "MALFORMED",
      `Codeforces ${method} did not return an array`
    );
  }
  return value;
}

// Shared by problemset.problems and the `problem` embedded in every submission,
// which is deliberate: it is the same object in the Codeforces data model, so
// one validator means the two import paths can never disagree about what a
// valid problem is.
function parseProblem(raw: unknown): CfProblem | null {
  const record = asRecord(raw);
  if (!record) return null;

  if (typeof record.index !== "string" || record.index === "") return null;
  if (typeof record.name !== "string" || record.name === "") return null;

  // Absent is fine (ACMSGURU); present-but-not-a-number is malformed.
  if (record.contestId !== undefined && typeof record.contestId !== "number") {
    return null;
  }
  if (record.rating !== undefined && typeof record.rating !== "number") {
    return null;
  }

  // Tags may be absent entirely (180 problems in the live problemset have no
  // tags). That is a problem with no topics, not a broken problem — it still
  // gets imported, it just contributes to no topic's mastery.
  let tags: string[] = [];
  if (record.tags !== undefined) {
    if (!Array.isArray(record.tags)) return null;
    if (!record.tags.every((tag) => typeof tag === "string")) return null;
    tags = record.tags as string[];
  }

  return {
    contestId: record.contestId as number | undefined,
    problemsetName: (typeof record.problemsetName === "string"
      ? record.problemsetName
      : undefined) as string | undefined,
    index: record.index,
    name: record.name,
    rating: record.rating as number | undefined,
    tags,
  };
}

// ---------------------------------------------------------------------------
// THE FOUR CALLS
// ---------------------------------------------------------------------------

// Used by POST /link to prove a handle exists before we create anything. One
// cheap call: a typo fails here instead of after a full import attempt.
//
// Returns the CANONICAL handle from the response rather than echoing the
// caller's input. Codeforces looks handles up case-insensitively, so a user
// typing "MAHIRDLL" would otherwise be stored differently from "mahirdll" and
// the two would look like different accounts in our own data.
export async function getUserInfo(handle: string): Promise<CfUserInfo> {
  const result = await call("user.info", { handles: handle });
  const list = requireArray(result, "user.info");

  const first = asRecord(list[0]);
  if (!first || typeof first.handle !== "string") {
    throw new CodeforcesError(
      "MALFORMED",
      "Codeforces user.info returned no usable handle"
    );
  }

  return { handle: first.handle };
}

// The whole submission history in ONE call.
//
// `from`/`count` exist, and the brief anticipated needing them. Measured
// instead: tourist's entire 5,467-submission history came back in a single
// 2.7 s / 3.1 MB response with neither parameter set. Pagination would have
// bought nothing and cost 2.1 s of rate-limit spacing per extra page plus
// partial-page edge cases.
//
// THE CONSEQUENCE IS A FEATURE: because we always re-read everything, every
// sync is a FULL re-sync. The rejudge blind spot that an incremental,
// newest-first, stop-at-lastSyncedAt design would have — where a rejudged old
// verdict is never revisited — simply does not exist here.
export async function getUserSubmissions(
  handle: string
): Promise<CfListResult<CfSubmission>> {
  const result = await call("user.status", { handle });
  const list = requireArray(result, "user.status");

  const items: CfSubmission[] = [];
  let malformed = 0;

  for (const raw of list) {
    const record = asRecord(raw);
    if (!record || typeof record.creationTimeSeconds !== "number") {
      malformed++;
      continue;
    }

    const problem = parseProblem(record.problem);
    if (!problem) {
      malformed++;
      continue;
    }

    // Absent while a submission is still queued. It counts as an attempt but
    // can never count as a solve, which parseVerdict downstream relies on.
    if (record.verdict !== undefined && typeof record.verdict !== "string") {
      malformed++;
      continue;
    }

    items.push({
      problem,
      verdict: record.verdict as string | undefined,
      creationTimeSeconds: record.creationTimeSeconds,
    });
  }

  return { items, malformed };
}

// Contest history. Field names verified against a live response rather than
// taken from the docs — note `ratingUpdateTimeSeconds`, which is easy to guess
// wrong as `ratedAt` or `updateTimeSeconds`.
export async function getUserRatingChanges(
  handle: string
): Promise<CfListResult<CfRatingChange>> {
  const result = await call("user.rating", { handle });
  const list = requireArray(result, "user.rating");

  const items: CfRatingChange[] = [];
  let malformed = 0;

  for (const raw of list) {
    const record = asRecord(raw);
    if (!record) {
      malformed++;
      continue;
    }

    // Every one of these lands in a NOT NULL column, so all six are required.
    if (
      typeof record.contestId !== "number" ||
      typeof record.contestName !== "string" ||
      typeof record.rank !== "number" ||
      typeof record.ratingUpdateTimeSeconds !== "number" ||
      typeof record.oldRating !== "number" ||
      typeof record.newRating !== "number"
    ) {
      malformed++;
      continue;
    }

    items.push({
      contestId: record.contestId,
      contestName: record.contestName,
      rank: record.rank,
      ratingUpdateTimeSeconds: record.ratingUpdateTimeSeconds,
      oldRating: record.oldRating,
      newRating: record.newRating,
    });
  }

  return { items, malformed };
}

// THE CANDIDATE POOL. Global reference data, identical for every user and tied
// to no LinkedAccount — see sync.ts for why that distinction is load-bearing.
//
// Deliberately called with NO problemsetName parameter. Passing
// `problemsetName=acmsguru` returns a separate 453-problem archive whose
// entries have no contestId at all; the default call returns none of them, and
// all 453 are unrated so §2.6's drop rule would discard them anyway.
export async function getProblemsetProblems(): Promise<
  CfListResult<CfProblem>
> {
  const result = await call("problemset.problems", {});

  const record = asRecord(result);
  if (!record) {
    throw new CodeforcesError(
      "MALFORMED",
      "Codeforces problemset.problems did not return an object"
    );
  }

  // Note the shape difference from the other three endpoints: this one returns
  // an OBJECT containing `problems` and `problemStatistics`, not a bare array.
  // We ignore the statistics (solve counts) — no feature in scope uses them.
  const list = requireArray(record.problems, "problemset.problems");

  const items: CfProblem[] = [];
  let malformed = 0;

  for (const raw of list) {
    const problem = parseProblem(raw);
    if (!problem) {
      malformed++;
      continue;
    }
    items.push(problem);
  }

  return { items, malformed };
}
