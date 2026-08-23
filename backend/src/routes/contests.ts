import { Router } from "express";
import { ContestStatus, Prisma, SessionStatus } from "@prisma/client";
import { asyncHandler } from "../lib/asyncHandler";
import prisma from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import {
  ContestSelectionError,
  DURATION_MINUTES,
  SIZES,
  SPREAD,
  selectContestProblems,
} from "../engine/contestSelect";

const router = Router();

const HISTORY_LIMIT = 50;

const CONTEST_SELECT = {
  id: true,
  startedAt: true,
  durationMinutes: true,
  endsAt: true,
  status: true,
  finalizedAt: true,
  reconciledAt: true,
  problems: {
    orderBy: { position: "asc" },
    select: {
      position: true,
      claimedSolvedAt: true,
      confirmedSolvedAt: true,
      problem: {
        select: {
          id: true,
          title: true,
          url: true,
          provider: true,
          difficultyRaw: true,
          difficultyBand: true,
          problemTopics: { select: { topic: { select: { name: true } } } },
        },
      },
    },
  },
} satisfies Prisma.ContestSessionSelect;

type ContestRow = Prisma.ContestSessionGetPayload<{
  select: typeof CONTEST_SELECT;
}>;

// The client counts down from this integer and never from endsAt, the same rule the
// practice session follows: a clock read in the browser is not the one the server
// enforces against.
function presentContest(contest: ContestRow) {
  return {
    ...contest,
    remainingSeconds: Math.max(
      0,
      Math.ceil((contest.endsAt.getTime() - Date.now()) / 1000)
    ),
  };
}

// An ACTIVE contest past endsAt is finalized by the next read of it. No scheduler and
// no server timer: the request that needs the answer is the one that settles it.
//
// COMPLETED, not ABANDONED - running out of time is how a contest normally ends.
async function expireIfOver(
  userId: string,
  contest: ContestRow
): Promise<ContestRow> {
  if (contest.status !== ContestStatus.ACTIVE) return contest;
  if (contest.endsAt > new Date()) return contest;

  const finalizedAt = new Date();

  // The condition is in the WHERE clause so the DATABASE decides, because this races a
  // user clicking finish at the same moment.
  const expired = await prisma.contestSession.updateMany({
    where: { id: contest.id, userId, status: ContestStatus.ACTIVE },
    data: { status: ContestStatus.COMPLETED, finalizedAt },
  });

  if (expired.count === 1) {
    return { ...contest, status: ContestStatus.COMPLETED, finalizedAt };
  }

  // Lost the race, so the values written by whoever won are the real ones.
  const fresh = await prisma.contestSession.findFirst({
    where: { id: contest.id, userId },
    select: CONTEST_SELECT,
  });

  return fresh ?? contest;
}

async function loadContest(
  userId: string,
  id: string
): Promise<ContestRow | null> {
  const contest = await prisma.contestSession.findFirst({
    where: { id, userId },
    select: CONTEST_SELECT,
  });

  return contest ? expireIfOver(userId, contest) : null;
}

async function activeContest(userId: string): Promise<ContestRow | null> {
  const contest = await prisma.contestSession.findFirst({
    where: { userId, status: ContestStatus.ACTIVE },
    select: CONTEST_SELECT,
  });

  if (!contest) return null;

  const settled = await expireIfOver(userId, contest);
  return settled.status === ContestStatus.ACTIVE ? settled : null;
}

router.get(
  "/options",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // The spread table is served rather than duplicated on the client, so the setup
    // screen cannot promise a shape the selector does not build.
    return res.json({
      durationMinutes: DURATION_MINUTES,
      sizes: SIZES,
      spread: SPREAD,
    });
  })
);

router.get(
  "/active",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const contest = await activeContest(req.userId);
    return res.json({ contest: contest ? presentContest(contest) : null });
  })
);

router.get(
  "/history",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const contests = await prisma.contestSession.findMany({
      where: { userId: req.userId, status: { not: ContestStatus.ACTIVE } },
      orderBy: { startedAt: "desc" },
      take: HISTORY_LIMIT,
      select: {
        id: true,
        startedAt: true,
        durationMinutes: true,
        status: true,
        finalizedAt: true,
        reconciledAt: true,
        problems: {
          select: { claimedSolvedAt: true, confirmedSolvedAt: true },
        },
      },
    });

    return res.json({
      contests: contests.map((contest) => ({
        id: contest.id,
        startedAt: contest.startedAt,
        durationMinutes: contest.durationMinutes,
        status: contest.status,
        finalizedAt: contest.finalizedAt,
        reconciledAt: contest.reconciledAt,
        size: contest.problems.length,
        claimed: contest.problems.filter((p) => p.claimedSolvedAt !== null).length,
        confirmed: contest.problems.filter((p) => p.confirmedSolvedAt !== null)
          .length,
      })),
    });
  })
);

router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { durationMinutes, size } = req.body ?? {};

    // Members of the allowed sets, never clamped: silently running a 90-minute contest
    // for someone who asked for 75 is worse than refusing.
    if (
      typeof durationMinutes !== "number" ||
      !DURATION_MINUTES.includes(durationMinutes)
    ) {
      return res.status(400).json({
        error: `Duration must be one of ${DURATION_MINUTES.join(", ")} minutes`,
      });
    }

    if (typeof size !== "number" || !SIZES.includes(size)) {
      return res
        .status(400)
        .json({ error: `Size must be one of ${SIZES.join(", ")}` });
    }

    const running = await activeContest(req.userId);
    if (running) {
      return res.status(409).json({
        error: "A contest is already running",
        contest: presentContest(running),
      });
    }

    // A contest and a practice session are two modes of the same activity, so they are
    // mutually exclusive. The reverse check lives in routes/sessions.ts.
    const session = await prisma.practiceSession.findFirst({
      where: { userId: req.userId, status: SessionStatus.ACTIVE },
      select: { id: true },
    });

    if (session) {
      return res.status(409).json({
        error: "Finish your practice session before starting a contest",
      });
    }

    let selected;
    try {
      selected = await selectContestProblems(req.userId, size);
    } catch (error) {
      // The catalog could not fill the requested spread. Naming the band and the counts
      // is the whole value of the message.
      if (error instanceof ContestSelectionError) {
        return res.status(422).json({ error: error.message });
      }
      throw error;
    }

    const startedAt = new Date();
    const endsAt = new Date(startedAt.getTime() + durationMinutes * 60_000);

    // Nested create, so the contest and its problems are one statement and one round
    // trip, and the response needs no read-back.
    const contest = await prisma.contestSession.create({
      data: {
        userId: req.userId,
        startedAt,
        durationMinutes,
        endsAt,
        problems: { create: selected },
      },
      select: CONTEST_SELECT,
    });

    return res.status(201).json({ contest: presentContest(contest) });
  })
);

router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // userId is IN the where clause, so the 404 covers both "not yours" and "does not
    // exist" and an id cannot be used to probe anyone else's contests.
    const contest = await loadContest(req.userId, req.params.id.trim());
    if (!contest) {
      return res.status(404).json({ error: "Contest not found" });
    }

    return res.json({ contest: presentContest(contest) });
  })
);

router.post(
  "/:id/problems/:pid/claim",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { solved } = req.body ?? {};
    if (typeof solved !== "boolean") {
      return res.status(400).json({ error: "Solved must be true or false" });
    }

    const contest = await loadContest(req.userId, req.params.id.trim());
    if (!contest) {
      return res.status(404).json({ error: "Contest not found" });
    }

    // loadContest has already expired an over-run contest, so this one check covers
    // both "past endsAt" and "already finalized".
    if (contest.status !== ContestStatus.ACTIVE) {
      return res.status(409).json({ error: "Contest is no longer running" });
    }

    const problemId = req.params.pid.trim();
    if (!contest.problems.some((entry) => entry.problem.id === problemId)) {
      return res.status(404).json({ error: "Problem is not in this contest" });
    }

    // The clock is the server's. Because the status check above passed, now is inside
    // startedAt..endsAt by construction rather than by a second comparison.
    const claimedSolvedAt = solved ? new Date() : null;

    await prisma.contestProblem.update({
      where: {
        contestSessionId_problemId: {
          contestSessionId: contest.id,
          problemId,
        },
      },
      data: { claimedSolvedAt },
    });

    return res.json({ problemId, claimedSolvedAt });
  })
);

router.post(
  "/:id/finalize",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { status } = req.body ?? {};
    if (
      status !== ContestStatus.COMPLETED &&
      status !== ContestStatus.ABANDONED
    ) {
      return res
        .status(400)
        .json({ error: "Status must be COMPLETED or ABANDONED" });
    }

    const contest = await loadContest(req.userId, req.params.id.trim());
    if (!contest) {
      return res.status(404).json({ error: "Contest not found" });
    }

    // Idempotent. A contest the clock already finalized comes back from loadContest as
    // COMPLETED, and a second click gets that same answer rather than a second write
    // moving finalizedAt.
    if (contest.status !== ContestStatus.ACTIVE) {
      return res.json({ contest: presentContest(contest) });
    }

    const finalizedAt = new Date();

    const finalized = await prisma.contestSession.updateMany({
      where: {
        id: contest.id,
        userId: req.userId,
        status: ContestStatus.ACTIVE,
      },
      data: { status, finalizedAt },
    });

    if (finalized.count === 0) {
      const fresh = await loadContest(req.userId, contest.id);
      return fresh
        ? res.json({ contest: presentContest(fresh) })
        : res.status(404).json({ error: "Contest not found" });
    }

    // No sync here. POST /sync holds its connection 13-28 s, and nothing is allowed to
    // make finishing a contest wait on a provider. reconciledAt stays null and
    // POST /:id/reconcile is the explicit next step.
    return res.json({
      contest: presentContest({ ...contest, status, finalizedAt }),
    });
  })
);

export default router;
