import { Router } from "express";
import { ContestStatus, Prisma, SessionStatus } from "@prisma/client";
import { asyncHandler } from "../lib/asyncHandler";
import { consumeAiRateLimit } from "../lib/aiRateLimit";
import prisma from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { evaluateHintGate, UNAVAILABLE_MESSAGE } from "../lib/practiceCooldown";
import {
  completeJsonField,
  GroqError,
  isAiConfigured,
} from "../providers/groq/client";
import {
  buildSessionHintUserMessage,
  PromptProblem,
  PromptTopicMastery,
  SESSION_HINT_SYSTEM_PROMPTS,
} from "../providers/groq/prompts";
import { getMasteryOverview } from "../engine/mastery";

// Same import direction as routes/ai.ts: this file reads the engine, and the engine
// reads nothing from here.

const router = Router();

// Bounded deliberately. The hardening pass removed the last unbounded findMany, and
// a client-supplied limit would be untrusted input bought for nothing.
const HISTORY_LIMIT = 50;

// Mirrors getDueRevisions' include, so the frontend renders a session's problem with
// the same code it already uses for a revision item.
const PROBLEM_SELECT = {
  id: true,
  title: true,
  url: true,
  provider: true,
  difficultyRaw: true,
  difficultyBand: true,
  problemTopics: { select: { topic: { select: { name: true } } } },
} satisfies Prisma.ProblemSelect;

const SESSION_SELECT = {
  id: true,
  problemId: true,
  startedAt: true,
  status: true,
  problem: { select: PROBLEM_SELECT },
  hints: {
    select: { level: true, content: true, issuedAt: true },
    orderBy: { level: "asc" },
  },
} satisfies Prisma.PracticeSessionSelect;

type SessionRow = Prisma.PracticeSessionGetPayload<{
  select: typeof SESSION_SELECT;
}>;

// elapsedSeconds and gate are computed HERE and never in the browser. The rule that
// a client clock must not unlock a hint early only holds if the client is never
// asked to do the arithmetic in the first place.
function presentSession(session: SessionRow, now: Date = new Date()) {
  return {
    id: session.id,
    problemId: session.problemId,
    startedAt: session.startedAt,
    elapsedSeconds: Math.floor(
      (now.getTime() - session.startedAt.getTime()) / 1000
    ),
    problem: session.problem,
    hints: session.hints,
    gate: evaluateHintGate(
      session.startedAt,
      session.hints.map((hint) => hint.issuedAt),
      now
    ),
  };
}

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { problemId } = req.body ?? {};
    if (typeof problemId !== "string" || problemId.trim() === "") {
      return res.status(400).json({ error: "Problem id is required" });
    }

    const id = problemId.trim();

    const problem = await prisma.problem.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!problem) {
      return res.status(404).json({ error: "Problem not found" });
    }

    // A contest and a practice session are two modes of the same activity, so one
    // blocks the other. The mirror of this check lives in routes/contests.ts.
    //
    // endsAt is compared here rather than routing through the contest module's lazy
    // expiry: a contest whose clock has run out must not block anything, and whether
    // its row has been finalized yet is the contest page's business, not this one's.
    const contest = await prisma.contestSession.findFirst({
      where: {
        userId: req.userId,
        status: ContestStatus.ACTIVE,
        endsAt: { gt: new Date() },
      },
      select: { id: true },
    });

    if (contest) {
      return res.status(409).json({
        error: "Finish your contest before starting a practice session",
        contestId: contest.id,
      });
    }

    // Read-then-write, and the window is real: two concurrent starts can both see
    // nothing active. Postgres cannot express "one ACTIVE row per user" as a Prisma
    // constraint, and losing the race costs one spare row, not correctness.
    const active = await prisma.practiceSession.findFirst({
      where: { userId: req.userId, status: SessionStatus.ACTIVE },
      select: SESSION_SELECT,
    });

    if (active) {
      // A refresh or a double submit gets back the session it already has, never a
      // second row on the same problem.
      if (active.problemId === id) {
        return res.json({ session: presentSession(active) });
      }

      // Never auto-abandoned. Which session to give up is the user's call.
      return res.status(409).json({
        error: "A session is already active",
        session: presentSession(active),
      });
    }

    const session = await prisma.practiceSession.create({
      data: { userId: req.userId, problemId: id },
      select: SESSION_SELECT,
    });

    return res.status(201).json({ session: presentSession(session) });
  })
);

router.get(
  "/active",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const session = await prisma.practiceSession.findFirst({
      where: { userId: req.userId, status: SessionStatus.ACTIVE },
      select: SESSION_SELECT,
    });

    // Null rather than 404: the practice page asks this on every load, and "nothing
    // active" is the ordinary answer rather than a failure.
    return res.json({ session: session ? presentSession(session) : null });
  })
);

router.get(
  "/history",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const sessions = await prisma.practiceSession.findMany({
      where: { userId: req.userId, status: { not: SessionStatus.ACTIVE } },
      select: {
        id: true,
        startedAt: true,
        resolvedAt: true,
        status: true,
        problem: { select: PROBLEM_SELECT },
        // Counted on read. There is no hintsUsed column for this to drift from.
        _count: { select: { hints: true } },
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: HISTORY_LIMIT,
    });

    return res.json({
      sessions: sessions.map((session) => ({
        id: session.id,
        startedAt: session.startedAt,
        resolvedAt: session.resolvedAt,
        status: session.status,
        problem: session.problem,
        hintCount: session._count.hints,
      })),
    });
  })
);

// NO REQUEST BODY, which is load-bearing twice: the client cannot choose which level
// it gets, and there is no client string that could reach the prompt.
router.post(
  "/:id/hint",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const id = req.params.id.trim();
    if (id === "") {
      return res.status(400).json({ error: "Session id is required" });
    }

    // userId is IN the where clause. The 404 below covers both "not yours" and "does
    // not exist", deliberately indistinguishable, so an id cannot be used to probe
    // what anyone else is practising.
    const session = await prisma.practiceSession.findFirst({
      where: { id, userId: req.userId },
      select: SESSION_SELECT,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (session.status !== SessionStatus.ACTIVE) {
      return res.status(409).json({ error: "Session is already resolved" });
    }

    // GUARD ORDER IS A CONTRACT, and it inverts routes/ai.ts on purpose. The free
    // checks run first, so tapping the button during a cooldown cannot spend one of
    // the six per-minute AI slots on a call that was never going to be made.
    const gate = evaluateHintGate(
      session.startedAt,
      session.hints.map((hint) => hint.issuedAt)
    );

    if (gate.state === "EXHAUSTED") {
      return res.json({
        granted: false,
        reason: "EXHAUSTED",
        message: gate.message,
      });
    }

    // Being early is a product state, not an error, so this is a 200 like the rest.
    if (gate.state === "COOLDOWN") {
      return res.json({
        granted: false,
        reason: "COOLDOWN",
        nextLevel: gate.level,
        secondsRemaining: gate.secondsRemaining,
        message: gate.message,
      });
    }

    // THE COOLDOWN IS CONSUMED ONLY BY A SUCCESSFUL GENERATION. issuedAt is written
    // by the insert at the bottom of this handler, so every failure between here and
    // there leaves the anchor exactly where it was.
    if (!isAiConfigured()) {
      return res.json({
        granted: false,
        reason: "UNAVAILABLE",
        message: UNAVAILABLE_MESSAGE,
      });
    }

    if (!consumeAiRateLimit(req.userId).allowed) {
      return res.json({
        granted: false,
        reason: "UNAVAILABLE",
        message: UNAVAILABLE_MESSAGE,
      });
    }

    // Sorted so two identical requests differ only by the model's non-determinism.
    const topics = session.problem.problemTopics
      .map((link) => link.topic.name)
      .sort();

    const overview = await getMasteryOverview(req.userId);

    // The standing comes from the engine's own bucketing rather than from a score
    // compared here, so WEAK_THRESHOLD stays defined in exactly one place.
    const standingByTopic = new Map<string, "weak" | "strong">();
    for (const topic of overview.weak) standingByTopic.set(topic.name, "weak");
    for (const topic of overview.strong) standingByTopic.set(topic.name, "strong");

    const mastery: PromptTopicMastery[] = topics.map((name) => ({
      name,
      standing: standingByTopic.get(name) ?? "unknown",
    }));

    const problem: PromptProblem = {
      title: session.problem.title,
      provider: session.problem.provider,
      difficultyRaw: session.problem.difficultyRaw,
      difficultyBand: session.problem.difficultyBand,
      topics,
    };

    let content: string;
    try {
      content = await completeJsonField(
        SESSION_HINT_SYSTEM_PROMPTS[gate.level - 1],
        // The earlier levels go in so this one builds rather than restates.
        buildSessionHintUserMessage(
          problem,
          mastery,
          session.hints.map((hint) => hint.content)
        ),
        "hint"
      );
    } catch (error) {
      if (!(error instanceof GroqError)) throw error;
      console.error(`[sessionHint] ${error.kind}: ${error.message}`);
      return res.json({
        granted: false,
        reason: "UNAVAILABLE",
        message: UNAVAILABLE_MESSAGE,
      });
    }

    try {
      const hint = await prisma.sessionHint.create({
        data: { sessionId: session.id, level: gate.level, content },
        select: { level: true, content: true, issuedAt: true },
      });

      return res.json({ granted: true, ...hint });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        // Two requests raced the first hint and both generated one. The constraint
        // picked a winner; return its row, because the user asked for a hint at this
        // level and there is one. The loser's generation is discarded, which is the
        // price of not reserving the row before the model returns.
        const winner = await prisma.sessionHint.findUnique({
          where: {
            sessionId_level: { sessionId: session.id, level: gate.level },
          },
          select: { level: true, content: true, issuedAt: true },
        });

        if (winner) {
          return res.json({ granted: true, ...winner });
        }
      }

      throw error;
    }
  })
);

router.post(
  "/:id/resolve",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const id = req.params.id.trim();
    if (id === "") {
      return res.status(400).json({ error: "Session id is required" });
    }

    const { status } = req.body ?? {};
    if (status !== SessionStatus.SOLVED && status !== SessionStatus.ABANDONED) {
      return res.status(400).json({ error: "Status must be SOLVED or ABANDONED" });
    }

    const resolvedAt = new Date();

    // The condition is in the WHERE clause so the DATABASE decides who wins, the way
    // acquireSyncLock does. A read-then-write here would let a double submit resolve
    // the same session twice and move resolvedAt on the second pass.
    const resolved = await prisma.practiceSession.updateMany({
      where: { id, userId: req.userId, status: SessionStatus.ACTIVE },
      data: { status, resolvedAt },
    });

    if (resolved.count === 0) {
      // Only on the failure path, and only to tell "already resolved" from "not
      // yours" - which the success path never needs to know.
      const exists = await prisma.practiceSession.findFirst({
        where: { id, userId: req.userId },
        select: { id: true },
      });

      return exists
        ? res.status(409).json({ error: "Session is already resolved" })
        : res.status(404).json({ error: "Session not found" });
    }

    // Returned from what we just wrote rather than read back: a second round trip to
    // Neon would tell us only what we already know.
    return res.json({ session: { id, status, resolvedAt } });
  })
);

export default router;
