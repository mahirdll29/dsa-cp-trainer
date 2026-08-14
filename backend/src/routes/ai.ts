import { Request, Response, Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { consumeAiRateLimit } from "../lib/aiRateLimit";
import prisma from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import {
  completeJsonField,
  GroqError,
  isAiConfigured,
} from "../providers/groq/client";
import {
  buildExplainUserMessage,
  buildHintUserMessage,
  EXPLAIN_SYSTEM_PROMPT,
  HINT_SYSTEM_PROMPT,
  PromptProblem,
} from "../providers/groq/prompts";
import { buildRecommendations } from "../engine/recommend";

// ---------------------------------------------------------------------------
// THE AI LAYER — two endpoints, and the boundary they exist to respect.
//
// NOTE THE IMPORT AT THE BOTTOM OF THE LIST: this file imports the engine. The
// engine imports nothing from here. That direction is not a convention, it is
// THE ENFORCEMENT — reversing it would be an import cycle, which is visible in
// a way a comment saying "the AI must not decide" is not.
//
// GET /api/recommendations is untouched by this module and never calls Groq. It
// stays fast, deterministic and fully working with the key absent. The client
// asks for an explanation AFTERWARDS, for an item it already has.
//
// Both routes are POST, so they inherit requireSameOrigin's CSRF check from
// app.ts globally (architecture.md 3.4) — no per-route work was needed. Both
// are behind requireAuth. Both are wrapped in asyncHandler, so a rejected
// promise becomes a clean 500 instead of killing the process.
// ---------------------------------------------------------------------------

const router = Router();

// Turn a Groq failure into an HTTP status. Branching on the typed `kind` rather
// than on message text means an upstream rewording can never silently convert a
// 503 into a 500 — the same rule as statusForCodeforcesError and
// statusForLeetcodeError.
function statusForGroqError(error: GroqError): number {
  switch (error.kind) {
    case "NOT_CONFIGURED":
      return 503;
    case "RATE_LIMITED":
      // 429 rather than 502, because the distinction is actionable: 502 means
      // "something broke, tell someone", 429 means "wait and try again". The
      // client's correct behaviour differs, so the status must too.
      return 429;
    default:
      return 502; // TIMEOUT, UNAVAILABLE, MALFORMED
  }
}

function messageForGroqError(error: GroqError): string {
  switch (error.kind) {
    case "NOT_CONFIGURED":
      return "AI features are not configured";
    case "RATE_LIMITED":
      return error.retryAfterSeconds
        ? `AI is busy right now — try again in ${error.retryAfterSeconds} seconds`
        : "AI is busy right now — try again shortly";
    case "TIMEOUT":
      return "The AI service took too long to respond";
    case "MALFORMED":
      // Deliberately vague to the client and specific in the log. "The model
      // returned something we could not use" is not information a user can act
      // on, and the real text may contain the prompt.
      return "The AI service returned an unusable response";
    default:
      return "The AI service is unavailable";
  }
}

// One place that turns a thrown GroqError into a response, because both routes
// need it identically and a divergence would be silent. Anything that is NOT a
// GroqError is re-thrown to asyncHandler and becomes a generic 500 — an
// unexpected exception must not be dressed up as a tidy 502.
function respondToGroqError(res: Response, error: unknown) {
  if (!(error instanceof GroqError)) throw error;

  // The real error, with its kind, goes to the server log only. The client
  // never sees internal text (architecture.md 3).
  console.error(`[groq] ${error.kind}: ${error.message}`);

  if (error.kind === "RATE_LIMITED" && error.retryAfterSeconds) {
    res.set("Retry-After", String(error.retryAfterSeconds));
  }

  return res
    .status(statusForGroqError(error))
    .json({ error: messageForGroqError(error) });
}

// The three guards every AI route runs before doing any work, in this order and
// for a reason:
//
//   1. NOT CONFIGURED -> 503, BEFORE validating the body. If the feature is off
//      it is off; telling a caller their problemId is malformed when we were
//      never going to call Groq anyway is a misleading error.
//   2. BODY VALIDATION -> 400. Hand-written, no Zod, same shape as every other
//      route in the project.
//   3. RATE LIMIT -> 429, BEFORE the database work. Limiting after the
//      expensive part would protect the token budget and leave the ~15 Neon
//      round trips of the recommendation pipeline completely exposed, which is
//      the more expensive half.
//
// Returns the validated problemId, or null when it has already sent a response.
function guard(req: Request, res: Response, userId: string): string | null {
  if (!isAiConfigured()) {
    res.status(503).json({ error: "AI features are not configured" });
    return null;
  }

  const { problemId } = req.body ?? {};
  if (typeof problemId !== "string" || problemId.trim() === "") {
    res.status(400).json({ error: "Problem id is required" });
    return null;
  }

  const limit = consumeAiRateLimit(userId);
  if (!limit.allowed) {
    res.set("Retry-After", String(limit.retryAfterSeconds));
    res.status(429).json({
      error: `Too many AI requests — try again in ${limit.retryAfterSeconds} seconds`,
    });
    return null;
  }

  return problemId.trim();
}

// ---------------------------------------------------------------------------
// POST /api/ai/explain  { problemId } -> { explanation }
//
// THE FLAGSHIP ENDPOINT. It demonstrates the engine/AI split working: the
// engine decided, and this narrates that decision.
//
// THE DESIGN DECISION THAT MATTERS IS WHERE THE REASON COMES FROM.
//
// The obvious API is { problemId, reason } — the client sends back the reason it
// was given. That is wrong, and quietly so. It lets any authenticated caller put
// arbitrary text into the prompt's reason slot and have the model confidently
// explain a recommendation the engine never made. The AI would be explaining the
// CLIENT'S CLAIM while looking exactly like it was explaining the engine's
// output, which breaks the one boundary this module exists to enforce.
//
// So the reason is SERVER-DERIVED: we re-run the real pipeline for this user and
// read the reason off the matching recommendation. If the problem is not in
// their current recommendations, the engine is not recommending it, so there is
// nothing to explain -> 404.
//
// THE COST, STATED PLAINLY: buildRecommendations is ~15 sequential Neon round
// trips at a measured 250-450 ms each (architecture.md 5.6), so this endpoint's
// database work dominates its AI work by roughly ten to one. Rejected
// alternatives and the named upgrade path are in architecture.md 7.
//
// OWNERSHIP: this is the one AI route that touches user state, and it is scoped
// the same way as everything else in the project — req.userId goes INTO the
// pipeline, so another user's recommendation list is never built. The 404 is
// therefore the ownership boundary as well as the "not recommended" answer.
// ---------------------------------------------------------------------------
router.post(
  "/explain",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const problemId = guard(req, res, req.userId);
    if (problemId === null) return;

    const recommendations = await buildRecommendations(req.userId);
    const recommendation = recommendations.find(
      (item) => item.problemId === problemId
    );

    if (!recommendation) {
      return res
        .status(404)
        .json({ error: "That problem is not in your current recommendations" });
    }

    // Every field below comes from the engine's own output. Nothing from the
    // request body reaches the prompt except the problemId, which was used only
    // to look up a row and never appears in the text we send.
    const problem: PromptProblem = {
      title: recommendation.title,
      provider: recommendation.provider,
      difficultyRaw: recommendation.difficultyRaw,
      difficultyBand: recommendation.difficultyBand,
      topics: recommendation.topics,
    };

    try {
      const explanation = await completeJsonField(
        EXPLAIN_SYSTEM_PROMPT,
        buildExplainUserMessage(problem, recommendation.reason),
        "explanation"
      );
      return res.json({ explanation });
    } catch (error) {
      return respondToGroqError(res, error);
    }
  })
);

// ---------------------------------------------------------------------------
// POST /api/ai/hint  { problemId } -> { hint }
//
// OWNERSHIP, STATED SO NOBODY ADDS A CHECK THAT IS NOT NEEDED: Problem is
// SHARED REFERENCE DATA (architecture.md 2.2), not user-owned. Two users who
// solved the same problem point at the same row. Any authenticated user may
// legitimately ask about any problem, so there is NO IDOR here and no ownership
// branch to write. This route touches no user state at all — it reads one
// Problem row and its topics, and that is the whole query.
//
// WHAT THE HINT CAN AND CANNOT BE. We do not store problem statements
// (schema.prisma: title, url, difficultyRaw, difficultyBand, topics — no text),
// so a hint is generated from title + topics + difficulty alone and is
// necessarily APPROACH-LEVEL rather than problem-specific.
//
// Fetching LeetCode's statement live was considered and rejected: it would
// spend the wrapper's 120-requests-per-HOUR quota (session-handoff trap 23 — a
// quota, not a rate, so spacing cannot buy budget back) on a cosmetic feature,
// starving the actual data import that depends on it. It would also work for
// LeetCode and not for Codeforces, whose API returns no statement at all.
// ---------------------------------------------------------------------------
router.post(
  "/hint",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const problemId = guard(req, res, req.userId);
    if (problemId === null) return;

    const found = await prisma.problem.findUnique({
      where: { id: problemId },
      select: {
        title: true,
        provider: true,
        difficultyRaw: true,
        difficultyBand: true,
        problemTopics: { select: { topic: { select: { name: true } } } },
      },
    });

    if (!found) {
      return res.status(404).json({ error: "Problem not found" });
    }

    const problem: PromptProblem = {
      title: found.title,
      provider: found.provider,
      difficultyRaw: found.difficultyRaw,
      difficultyBand: found.difficultyBand,
      // Sorted for the same reason recommend.ts sorts them: the same problem
      // should always produce the same prompt, so two identical requests differ
      // only by the model's own non-determinism and not by ours.
      topics: found.problemTopics.map((link) => link.topic.name).sort(),
    };

    try {
      const hint = await completeJsonField(
        HINT_SYSTEM_PROMPT,
        buildHintUserMessage(problem),
        "hint"
      );
      return res.json({ hint });
    } catch (error) {
      return respondToGroqError(res, error);
    }
  })
);

export default router;
