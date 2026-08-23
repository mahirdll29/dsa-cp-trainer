import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import prisma from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import {
  buildDayKeys,
  buildSeries,
  classify,
  computeStreak,
  detectBreakthroughs,
  weeklyDelta,
} from "../engine/analytics";

const router = Router();

const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;

// India, where the only user is. A default of 0 would file every late-night solve under the
// previous day for them, which is worse than having no default at all.
const DEFAULT_TZ_OFFSET = 330;
const MIN_TZ_OFFSET = -720;
const MAX_TZ_OFFSET = 840;

// Below this a chart is a rumour, not a trend.
const MIN_HISTORY_DAYS = 7;

function parseDays(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_DAYS;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return days >= 1 && days <= MAX_DAYS ? days : null;
}

function parseTzOffset(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_TZ_OFFSET;
  if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) return null;
  const offset = Number(raw);
  return offset >= MIN_TZ_OFFSET && offset <= MAX_TZ_OFFSET ? offset : null;
}

// Both endpoints need the same bucketed series - one renders it, the other derives
// breakthroughs and the weekly delta from it - so the load happens in one place.
async function loadSeries(
  userId: string,
  days: number,
  tzOffsetMinutes: number
) {
  const [logs, masteries] = await Promise.all([
    // Every row for the user, not just the window: a row older than the window still sets
    // the value the line opens on. One query for all topics, grouped in JavaScript - the
    // per-topic alternative is 32 round trips against a database that does not
    // parallelize them.
    prisma.masteryLog.findMany({
      where: { userId },
      select: {
        topicId: true,
        masteryScore: true,
        capturedAt: true,
        topic: { select: { name: true, slug: true } },
      },
      orderBy: [{ topicId: "asc" }, { capturedAt: "asc" }],
    }),
    prisma.topicMastery.findMany({
      where: { userId },
      select: {
        topicId: true,
        solvedCount: true,
        attemptedCount: true,
        masteryScore: true,
        topic: { select: { name: true, slug: true } },
      },
    }),
  ]);

  const dayKeys = buildDayKeys(days, tzOffsetMinutes, new Date());
  const currentByTopicId = new Map(masteries.map((m) => [m.topicId, m]));

  const { series, historyDays } = buildSeries(
    logs,
    new Set(currentByTopicId.keys()),
    dayKeys,
    tzOffsetMinutes
  );

  // A topic reaches the response through either query, so its name comes from whichever
  // one saw it. A topic that has never had data appears in neither and is omitted.
  const named = new Map<string, { name: string; slug: string }>();
  for (const log of logs) named.set(log.topicId, log.topic);
  for (const mastery of masteries) named.set(mastery.topicId, mastery.topic);

  return { dayKeys, series, historyDays, currentByTopicId, named };
}

function byName(
  named: Map<string, { name: string; slug: string }>,
  a: string,
  b: string
) {
  const left = named.get(a);
  const right = named.get(b);
  if (!left || !right) return a.localeCompare(b);
  return left.name.localeCompare(right.name) || a.localeCompare(b);
}

router.get(
  "/trajectory",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const days = parseDays(req.query.days);
    if (days === null) {
      return res
        .status(400)
        .json({ error: `Days must be between 1 and ${MAX_DAYS}` });
    }

    const tzOffsetMinutes = parseTzOffset(req.query.tzOffsetMinutes);
    if (tzOffsetMinutes === null) {
      return res.status(400).json({
        error: `Timezone offset must be between ${MIN_TZ_OFFSET} and ${MAX_TZ_OFFSET} minutes`,
      });
    }

    const { dayKeys, series, historyDays, currentByTopicId, named } =
      await loadSeries(req.userId, days, tzOffsetMinutes);

    const topics = [...series.keys()]
      .sort((a, b) => byName(named, a, b))
      .map((topicId) => {
        const current = currentByTopicId.get(topicId) ?? null;
        return {
          topicId,
          name: named.get(topicId)?.name ?? topicId,
          slug: named.get(topicId)?.slug ?? topicId,
          // Aligned to buckets, with null AT the bucket rather than a missing entry, so
          // the client draws a break instead of inferring one from a short array.
          series: series.get(topicId) ?? [],
          current: current && {
            masteryScore: current.masteryScore,
            solvedCount: current.solvedCount,
            attemptedCount: current.attemptedCount,
          },
          state: classify(current ? current.masteryScore : null),
        };
      });

    return res.json({
      days,
      tzOffsetMinutes,
      buckets: dayKeys,
      historyDays,
      sufficient: historyDays >= MIN_HISTORY_DAYS,
      topics,
    });
  })
);

router.get(
  "/summary",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const days = parseDays(req.query.days);
    if (days === null) {
      return res
        .status(400)
        .json({ error: `Days must be between 1 and ${MAX_DAYS}` });
    }

    const tzOffsetMinutes = parseTzOffset(req.query.tzOffsetMinutes);
    if (tzOffsetMinutes === null) {
      return res.status(400).json({
        error: `Timezone offset must be between ${MIN_TZ_OFFSET} and ${MAX_TZ_OFFSET} minutes`,
      });
    }

    const [{ dayKeys, series, historyDays, named }, solves, accounts] =
      await Promise.all([
        loadSeries(req.userId, days, tzOffsetMinutes),
        prisma.userProblem.findMany({
          where: { userId: req.userId, solvedAt: { not: null } },
          select: { solvedAt: true },
        }),
        prisma.linkedAccount.findMany({
          where: { userId: req.userId },
          select: { lastSyncedAt: true },
        }),
      ]);

    const sufficient = historyDays >= MIN_HISTORY_DAYS;
    const thin = `Needs ${MIN_HISTORY_DAYS} days of history, have ${historyDays}`;

    const { confirmed, pending } = sufficient
      ? detectBreakthroughs(series, dayKeys)
      : { confirmed: [], pending: [] };

    const movers = sufficient ? weeklyDelta(series) : [];

    const label = (topicId: string) => ({
      name: named.get(topicId)?.name ?? topicId,
      slug: named.get(topicId)?.slug ?? topicId,
    });

    const syncedAt = accounts
      .map((account) => account.lastSyncedAt)
      .filter((at): at is Date => at !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    const solvedAt = solves
      .map((solve) => solve.solvedAt)
      .filter((at): at is Date => at !== null);

    return res.json({
      days,
      tzOffsetMinutes,
      historyDays,
      sufficient,
      breakthroughs: confirmed.map((b) => ({ ...b, ...label(b.topicId) })),
      pendingBreakthroughs: pending.map((b) => ({ ...b, ...label(b.topicId) })),
      weeklyDelta: movers.map((m) => ({ ...m, ...label(m.topicId) })),
      streak: syncedAt
        ? computeStreak(solvedAt, syncedAt, tzOffsetMinutes)
        : null,
      reasons: {
        breakthroughs: sufficient ? undefined : thin,
        weeklyDelta: sufficient ? undefined : thin,
        streak: syncedAt ? undefined : "No account has completed a sync",
      },
    });
  })
);

export default router;
