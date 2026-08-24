import { Router } from "express";
import { DifficultyBand, Prisma, Provider, SolveStatus } from "@prisma/client";
import { asyncHandler } from "../lib/asyncHandler";
import prisma from "../lib/prisma";
import { parseProblemUrl } from "../lib/problemUrl";
import { requireAuth } from "../middleware/requireAuth";

// Topic overlap weighted by how rare each shared topic is. No model call takes part in
// the ranking: a similarity this cannot state as arithmetic is one it does not report.

const router = Router();

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const SOURCE_SELECT = {
  id: true,
  title: true,
  url: true,
  provider: true,
  difficultyRaw: true,
  difficultyBand: true,
  problemTopics: { select: { topic: { select: { id: true, name: true } } } },
} satisfies Prisma.ProblemSelect;

const RESULT_SELECT = {
  id: true,
  title: true,
  url: true,
  provider: true,
  difficultyRaw: true,
  difficultyBand: true,
  problemTopics: { select: { topic: { select: { name: true } } } },
} satisfies Prisma.ProblemSelect;

// Rare topics carry the ranking - a shared "segment tree" says far more than a shared
// "math". THE 1 + IS LOAD-BEARING: under plain ln(N/df) a topic on every problem weighs
// zero, and a source whose topics are all universal divides zero by zero into NaN.
export function topicWeight(documentFrequency: number, catalogSize: number): number {
  return Math.log(1 + catalogSize / documentFrequency);
}

// The one place difficultyRaw is read as a number rather than displayed. Codeforces
// keeps its rating there as text and LeetCode keeps a word, so this decides a tie
// between two rated problems and is never a filter - the two scales do not map onto
// each other, and inventing a mapping is the thing this module refuses to do.
export function ratingOf(provider: Provider, difficultyRaw: string): number | null {
  return provider === Provider.CODEFORCES ? Number(difficultyRaw) : null;
}

export function ratingDistance(source: number | null, candidate: number | null): number {
  if (source === null || candidate === null) return Number.POSITIVE_INFINITY;
  return Math.abs(source - candidate);
}

// Rounded BEFORE the sort. Two scores differing in the fifteenth decimal are the same
// score, and letting float noise order them would undo the determinism the id below
// exists to guarantee.
export function roundScore(score: number): number {
  return Math.round(score * 10_000) / 10_000;
}

type ScoredCandidate = {
  problemId: string;
  score: number;
  sharedTopicIds: string[];
  ratingDistance: number;
};

// Total by construction: problemId is unique, so the last term always decides. Two
// unrated candidates subtract Infinity from Infinity, and NaN is falsy, so they fall
// through to the id exactly as an equal distance does.
export const byRelevance = (a: ScoredCandidate, b: ScoredCandidate) =>
  b.score - a.score ||
  a.ratingDistance - b.ratingDistance ||
  a.problemId.localeCompare(b.problemId);

const ALL_BANDS = Object.values(DifficultyBand);

function parseLimit(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

function parseBands(raw: unknown): DifficultyBand[] | null {
  if (typeof raw !== "string") return null;

  const bands: DifficultyBand[] = [];
  for (const part of raw.split(",")) {
    const band = ALL_BANDS.find((candidate) => candidate === part.trim());
    if (!band) return null;
    if (!bands.includes(band)) bands.push(band);
  }
  return bands;
}

router.get(
  "/similar",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { url, bands: bandsParam, limit: limitParam } = req.query;

    if (typeof url !== "string" || url.trim() === "") {
      return res.status(400).json({ error: "Problem URL is required" });
    }

    const limit = parseLimit(limitParam);
    if (limit === null) {
      return res
        .status(400)
        .json({ error: `Limit must be between 1 and ${MAX_LIMIT}` });
    }

    const requestedBands = bandsParam === undefined ? null : parseBands(bandsParam);
    if (bandsParam !== undefined && requestedBands === null) {
      return res.status(400).json({ error: "Unknown difficulty band" });
    }

    const parsed = parseProblemUrl(url);
    if (!parsed.ok) {
      return res.status(400).json({
        error:
          parsed.failure === "ACMSGURU"
            ? "acmsguru problems are not imported"
            : "Unrecognized problem URL",
      });
    }

    const source = await prisma.problem.findUnique({
      where: { provider_externalId: parsed.parsed },
      select: SOURCE_SELECT,
    });

    // Echoed on both misses below, because "this app cannot read that link" and "that
    // problem is not imported" are different answers and the id tells them apart.
    const identifier = `${parsed.parsed.provider} ${parsed.parsed.externalId}`;

    if (!source) {
      return res.status(404).json({ error: `Not in the catalog: ${identifier}` });
    }

    if (source.problemTopics.length === 0) {
      return res.status(422).json({ error: `No topics recorded: ${identifier}` });
    }

    const bands = requestedBands ?? [source.difficultyBand];
    const sourceTopicIds = source.problemTopics.map((link) => link.topic.id);

    const [topicCounts, catalogSize, candidates] = await Promise.all([
      prisma.problemTopic.groupBy({ by: ["topicId"], _count: { problemId: true } }),
      prisma.problem.count({ where: { problemTopics: { some: {} } } }),
      // Candidates come from the join, so a problem carrying no topics is never one and
      // needs no filter of its own. Band and the shared-topic condition are both decided
      // by Postgres - nothing is pulled into memory to be filtered here.
      prisma.problem.findMany({
        where: {
          id: { not: source.id },
          difficultyBand: { in: bands },
          problemTopics: { some: { topicId: { in: sourceTopicIds } } },
        },
        select: {
          id: true,
          provider: true,
          difficultyRaw: true,
          problemTopics: { select: { topicId: true } },
        },
      }),
    ]);

    const weightByTopicId: Record<string, number> = {};
    for (const count of topicCounts) {
      weightByTopicId[count.topicId] = topicWeight(count._count.problemId, catalogSize);
    }

    const sourceTopicSet = new Set(sourceTopicIds);
    let sourceWeight = 0;
    for (const topicId of sourceTopicIds) sourceWeight += weightByTopicId[topicId];

    const sourceRating = ratingOf(source.provider, source.difficultyRaw);

    const scored = candidates.map((candidate): ScoredCandidate => {
      const sharedTopicIds: string[] = [];
      let candidateWeight = 0;
      let sharedWeight = 0;

      for (const link of candidate.problemTopics) {
        const weight = weightByTopicId[link.topicId];
        candidateWeight += weight;
        if (sourceTopicSet.has(link.topicId)) {
          sharedTopicIds.push(link.topicId);
          sharedWeight += weight;
        }
      }

      return {
        problemId: candidate.id,
        score: roundScore(
          sharedWeight / (sourceWeight + candidateWeight - sharedWeight)
        ),
        sharedTopicIds,
        ratingDistance: ratingDistance(
          sourceRating,
          ratingOf(candidate.provider, candidate.difficultyRaw)
        ),
      };
    });

    const ranked = scored.sort(byRelevance).slice(0, limit);

    // Full rows are fetched only for what survived the ranking, never for the thousands
    // that were scored.
    const problems = await prisma.problem.findMany({
      where: { id: { in: ranked.map((entry) => entry.problemId) } },
      select: {
        ...RESULT_SELECT,
        // userId is inside the WHERE clause rather than checked after the read, the same
        // rule every other user-scoped query in this project follows.
        userProblems: { where: { userId: req.userId }, select: { status: true } },
      },
    });

    const problemById: Record<string, (typeof problems)[number]> = {};
    for (const problem of problems) problemById[problem.id] = problem;

    const topicNameById: Record<string, string> = {};
    for (const link of source.problemTopics) {
      topicNameById[link.topic.id] = link.topic.name;
    }

    return res.json({
      source: {
        problemId: source.id,
        title: source.title,
        url: source.url,
        provider: source.provider,
        difficultyRaw: source.difficultyRaw,
        difficultyBand: source.difficultyBand,
        topics: source.problemTopics.map((link) => link.topic.name).sort(),
      },
      bands,
      // Built from `ranked`, which holds the order, rather than from the query above,
      // which returns rows in whatever order Postgres found them.
      results: ranked.map((entry) => {
        const problem = problemById[entry.problemId];
        return {
          problemId: problem.id,
          title: problem.title,
          url: problem.url,
          provider: problem.provider,
          difficultyRaw: problem.difficultyRaw,
          difficultyBand: problem.difficultyBand,
          topics: problem.problemTopics.map((link) => link.topic.name).sort(),
          score: entry.score,
          sharedTopics: entry.sharedTopicIds
            .map((topicId) => topicNameById[topicId])
            .sort(),
          solved: problem.userProblems[0]?.status === SolveStatus.SOLVED,
        };
      }),
    });
  })
);

export default router;
