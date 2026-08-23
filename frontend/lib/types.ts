// Hand-written mirrors of what the backend actually returns, not generated from
// Prisma and not imported from the engine: these describe the JSON on the wire, which
// is the only thing the browser can see. Cost, stated: they can drift silently, so
// each block names the route file it was copied from.

export type Provider = "CODEFORCES" | "LEETCODE";
export type SyncStatus = "PENDING" | "SYNCING" | "COMPLETED" | "FAILED";
export type DifficultyBand = "EASY" | "MEDIUM" | "HARD";

// src/routes/auth.ts - PUBLIC_USER_FIELDS.
export type User = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
};

// src/engine/mastery.ts - getMasteryOverview.
//
// TopicMasteryView has a masteryScore; UnknownTopicView DOES NOT, and there is no
// optional field to fill. A topic with no data is not a topic scored zero, and
// because the property simply does not exist a component cannot render one by
// accident - it is a compile error, not a runtime undefined that formats as "0.0000".
export type TopicMasteryView = {
  topicId: string;
  name: string;
  slug: string;
  solvedCount: number;
  attemptedCount: number;
  masteryScore: number;
  targetBand: DifficultyBand;
};

export type UnknownTopicView = {
  topicId: string;
  name: string;
  slug: string;
};

export type MasteryOverview = {
  weak: TopicMasteryView[];
  strong: TopicMasteryView[];
  unknown: UnknownTopicView[];
};

// src/engine/recommend.ts - type Recommendation.
export type Recommendation = {
  problemId: string;
  title: string;
  url: string;
  provider: Provider;
  // difficultyRaw is the ONLY one this app displays; difficultyBand picks a colour.
  difficultyRaw: string;
  difficultyBand: DifficultyBand;
  topics: string[];
  // One of six fixed shapes, always shown - auditability is the engine's whole pitch.
  reason: string;
};

// src/engine/revision.ts - getDueRevisions, with `problem` included.
export type RevisionProblem = {
  id: string;
  title: string;
  url: string;
  provider: Provider;
  difficultyRaw: string;
  difficultyBand: DifficultyBand;
  problemTopics: { topic: { name: string } }[];
};

export type RevisionItem = {
  id: string;
  userId: string;
  problemId: string;
  dueAt: string;
  intervalDays: number;
  repetitionCount: number;
  lastReviewedAt: string | null;
  problem: RevisionProblem;
};

// src/routes/{codeforces,leetcode}.ts - both providers expose the same four shapes.
export type IntegrationStatus = {
  handle: string;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
};

export type LinkedAccount = {
  id: string;
  provider: Provider;
  handle: string;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  createdAt: string;
};

// The two providers report DIFFERENT counts, so the fields this app actually shows
// are named and the rest are left as an index signature. Nothing here is invented.
export type SyncResult = {
  handle: string;
  solved?: number;
  userProblemsCreated?: number;
  userProblemsUpdated?: number;
  topicsUpdated?: number;
  revisionItemsCreated?: number;
  problemsCreated?: number;
  durationMs?: number;
  [key: string]: unknown;
};

// src/routes/sessions.ts - the practice session (Module 9).
export type SessionStatus = "ACTIVE" | "SOLVED" | "ABANDONED";

// Structurally the same shape as RevisionProblem because the backend selects the
// same fields, but named for where it comes from rather than aliased to a sibling
// feature's type.
export type SessionProblem = {
  id: string;
  title: string;
  url: string;
  provider: Provider;
  difficultyRaw: string;
  difficultyBand: DifficultyBand;
  problemTopics: { topic: { name: string } }[];
};

export type SessionHint = {
  level: number;
  content: string;
  issuedAt: string;
};

// A locked gate HAS NO content field, the same way UnknownTopicView has no score.
// Rendering hint text where none has been issued is a compile error, not a runtime
// undefined that formats as "undefined".
export type HintGate =
  | { state: "READY"; level: number }
  | { state: "COOLDOWN"; level: number; secondsRemaining: number; message: string }
  | { state: "EXHAUSTED"; message: string };

// elapsedSeconds and gate are computed by the server. The countdown below is seeded
// from them and never from a client-side start timestamp.
export type ActiveSession = {
  id: string;
  problemId: string;
  startedAt: string;
  elapsedSeconds: number;
  problem: SessionProblem;
  hints: SessionHint[];
  gate: HintGate;
};

// Every branch is a 200. Being early is a product state, not an error, so none of
// these arrive as a thrown ApiError.
export type HintResult =
  | { granted: true; level: number; content: string; issuedAt: string }
  | {
      granted: false;
      reason: "COOLDOWN";
      nextLevel: number;
      secondsRemaining: number;
      message: string;
    }
  | { granted: false; reason: "EXHAUSTED"; message: string }
  | { granted: false; reason: "UNAVAILABLE"; message: string };

export type SessionSummary = {
  id: string;
  startedAt: string;
  resolvedAt: string;
  status: "SOLVED" | "ABANDONED";
  problem: SessionProblem;
  hintCount: number;
};

// src/routes/problems.ts - the similar problem finder (Module 10).
//
// `score` arrives in [0,1], already rounded to 4dp, and `results` arrives in the
// order it renders. The client computes no score, sorts nothing and filters nothing.
export type SimilarProblem = {
  problemId: string;
  title: string;
  url: string;
  provider: Provider;
  difficultyRaw: string;
  difficultyBand: DifficultyBand;
  topics: string[];
};

// An intersection rather than a rewritten shape: these two come from the SAME route
// and the result genuinely is the source plus three fields, so letting them drift
// would be a bug rather than a rename.
export type SimilarResult = SimilarProblem & {
  score: number;
  sharedTopics: string[];
  solved: boolean;
};

export type SimilarResponse = {
  source: SimilarProblem;
  // Echoed back so the page can say what it actually filtered on, which is not the
  // same as what was asked for when nothing was asked for.
  bands: DifficultyBand[];
  results: SimilarResult[];
};

// src/routes/analytics.ts - progress analytics (Module 11).
//
// `series` is aligned to `buckets` index for index, and a null IS the value at that
// bucket rather than a missing entry: the topic had no data then, and nothing may be
// drawn across it. Omitting the entry instead would make a gap indistinguishable from
// a short array, which is exactly the ambiguity the endpoint exists to remove.
export type TopicState = "weak" | "strong" | "unknown";

export type TrajectoryTopic = {
  topicId: string;
  name: string;
  slug: string;
  series: (number | null)[];
  // Null exactly when state is "unknown", for the same reason UnknownTopicView carries
  // no score: a topic with no data must not be renderable as one scored zero.
  current: {
    masteryScore: number;
    solvedCount: number;
    attemptedCount: number;
  } | null;
  state: TopicState;
};

export type TrajectoryResponse = {
  days: number;
  tzOffsetMinutes: number;
  buckets: string[];
  // historyDays counts buckets holding a real logged row, so "nothing happened" and
  // "not enough data to say" are distinguishable without counting array elements.
  historyDays: number;
  sufficient: boolean;
  topics: TrajectoryTopic[];
};

export type Breakthrough = {
  topicId: string;
  name: string;
  slug: string;
  date: string;
  scoreBefore: number;
  scoreAfter: number;
};

export type WeeklyMove = {
  topicId: string;
  name: string;
  slug: string;
  from: number;
  to: number;
  delta: number;
};

// `days` is the trailing run either way; `current` says whether it is still alive as of
// the last sync. A broken run reports its real length rather than collapsing to zero.
export type Streak = {
  days: number;
  current: boolean;
  lastSolveDay: string | null;
  asOf: string;
};

export type SummaryResponse = {
  days: number;
  tzOffsetMinutes: number;
  historyDays: number;
  sufficient: boolean;
  breakthroughs: Breakthrough[];
  // A crossing in the most recent bucket has no hold bucket yet, so it is reported
  // separately rather than counted as confirmed.
  pendingBreakthroughs: Breakthrough[];
  weeklyDelta: WeeklyMove[];
  streak: Streak | null;
  reasons: {
    breakthroughs?: string;
    weeklyDelta?: string;
    streak?: string;
  };
};
