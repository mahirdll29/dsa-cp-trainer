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
