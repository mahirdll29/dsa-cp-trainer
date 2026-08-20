// The only file in this project that talks to codeforces.com. Every response is
// treated as untrusted input: "documented" describes intent, not a guarantee.

const CODEFORCES_API = "https://codeforces.com/api";

// Observed worst case is 2.7 s (tourist's full history), so this is a hang detector
// rather than a tuning knob.
const REQUEST_TIMEOUT_MS = 30_000;

// Codeforces documents roughly one request per two seconds; 2.1 s buys headroom.
const MIN_REQUEST_INTERVAL_MS = 2_100;

// One bounded retry. Anything more elaborate is a job queue, an explicit v1 non-goal.
const MAX_RETRIES = 1;
const RETRY_BACKOFF_MS = 5_000;

// A typed `kind`, so the route layer never string-matches on a message. Rewording
// upstream would otherwise silently turn a 404 into a 500.

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

// Only the fields this project actually reads. Each `?` is a case observed live:
// contestId absent on ACMSGURU, rating absent on unrated problems, verdict absent
// while a submission is still being judged.

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

// The count of elements dropped for failing validation, reported rather than
// swallowed: a sync that discarded 400 rows must not look identical to a clean one.
export type CfListResult<T> = {
  items: T[];
  malformed: number;
};

// One promise chain serialises every outbound request, so a caller cannot forget to
// space. Per-process: two instances would each keep their own gate.

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
  // bad handle would reject every request scheduled after it until the process
  // restarted. The real rejection still reaches the caller through `result`.
  requestQueue = result.catch(() => undefined);

  return result;
}

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

  // AbortController is the only way to bound fetch; without it a hung upstream holds
  // our request open and, during a sync, holds the SYNCING lock with it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    // Answered by the signal, not by the error message.
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
    // A leaked timer keeps the event loop alive and hangs shutdown for up to 30 s.
    clearTimeout(timer);
  }

  // An unknown handle comes back as HTTP 400 with a perfectly good JSON body:
  //   {"status":"FAILED","comment":"handles: User with handle xyz not found"}
  // So the body is parsed FIRST. `if (!response.ok) throw` would discard that reason
  // and turn what should be a 404 into a 502.
  let body: Envelope | null = null;
  try {
    body = (await response.json()) as Envelope;
  } catch {
    body = null; // not JSON at all — an HTML error page from a proxy, say
  }

  if (body && body.status === "FAILED") {
    const comment =
      typeof body.comment === "string" ? body.comment : "no reason given";

    // "not found" and "rate limit" arrive through the same FAILED envelope, so the
    // comment is the only thing separating a client mistake from a throttle.
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

// Only conditions that might differ a moment later are retried. NOT_FOUND and
// MALFORMED are deterministic, so retrying them just doubles the latency of a
// guaranteed failure.
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

// Hand-written validation, no Zod. Check every field we actually read and nothing
// else. A malformed ELEMENT is skipped and counted; a malformed TOP-LEVEL shape
// throws, because a partial import is worse than a failure.

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

// Shared by problemset.problems and the `problem` embedded in each submission - the
// same object in the Codeforces model, so one validator keeps both paths agreeing.
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

  // Tags may be absent (180 live problems have none). That is a problem with no topics,
  // not a broken problem: it is still imported.
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

// Proves a handle exists before we create anything, and returns the API's CANONICAL
// casing: Codeforces matches case-insensitively, so storing "MAHIRDLL" for the
// account "mahirdll" would leave our data disagreeing with every link we render.
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

// The whole submission history in ONE call - measured, tourist's 5,467 submissions
// came back in a single 2.7 s response. Because we always re-read everything, every
// sync is a full re-sync, so the rejudge blind spot an incremental design would have
// does not exist. lastSyncedAt is a freshness display value, NOT a cursor.
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

    // Absent while still queued: counts as an attempt, never as a solve.
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

// Field names verified against a live response - note ratingUpdateTimeSeconds, easy
// to guess wrong as ratedAt.
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

// The candidate pool: global reference data tied to no user. Deliberately called
// with NO problemsetName parameter - passing acmsguru returns a separate archive
// whose entries have no contestId at all.
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

  // Note the shape difference from the other three calls: an object containing
  // `problems`, not a bare array. Statistics are ignored - nothing in scope uses them.
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
