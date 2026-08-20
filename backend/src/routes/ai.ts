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

// NOTE THE IMPORT AT THE BOTTOM OF THE LIST: this file imports the engine and the
// engine imports nothing from here. That direction is not a convention, it is THE
// ENFORCEMENT - reversing it would be an import cycle, which is visible in a way a
// comment saying "the AI must not decide" is not.

const router = Router();

// Branching on the typed `kind` rather than message text, so an upstream rewording
// can never silently convert a 503 into a 500.
function statusForGroqError(error: GroqError): number {
  switch (error.kind) {
    case "NOT_CONFIGURED":
      return 503;
    case "RATE_LIMITED":
      // 429 rather than 502: the distinction is actionable, because the client's correct
      // behaviour differs.
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
      // Vague to the client and specific in the log: the real text may contain the prompt.
      return "The AI service returned an unusable response";
    default:
      return "The AI service is unavailable";
  }
}

// Anything that is NOT a GroqError is re-thrown - an unexpected exception must not be
// dressed up as a tidy 502.
function respondToGroqError(res: Response, error: unknown) {
  if (!(error instanceof GroqError)) throw error;

  // The real error goes to the server log only; the client never sees internal text.
  console.error(`[groq] ${error.kind}: ${error.message}`);

  if (error.kind === "RATE_LIMITED" && error.retryAfterSeconds) {
    res.set("Retry-After", String(error.retryAfterSeconds));
  }

  return res
    .status(statusForGroqError(error))
    .json({ error: messageForGroqError(error) });
}

// GUARD ORDER IS A CONTRACT, not a preference:
//   1. not configured -> 503, BEFORE body validation. frontend/lib/ai-context.tsx
//      POSTs an empty body and reads 503-vs-400 to decide whether to show the AI
//      affordances at all. Reorder these and it silently reads "available".
//   2. body validation -> 400.
//   3. rate limit -> 429, BEFORE the database work, or limiting would protect the
//      token budget while leaving the far more expensive pipeline exposed.
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

// THE REASON IS SERVER-DERIVED, and that is the whole security story of this module.
//
// The obvious API is { problemId, reason } - the client sends back the reason it was
// given. That would let any authenticated caller put arbitrary text into the prompt's
// reason slot and have the model confidently explain a recommendation the engine
// never made, while looking exactly like it was explaining the engine's output.
//
// So we re-run the real pipeline for this user and read the reason off the matching
// recommendation. If the problem is not in their current recommendations there is
// nothing to explain -> 404, which is also the ownership boundary.
//
// Cost: buildRecommendations is ~15 sequential Neon round trips, so this endpoint's
// database work dominates its AI work by roughly ten to one.
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

    // Every field comes from the engine's own output. Nothing from the request body
    // reaches the prompt except problemId, which is used only to look up a row.
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

// Problem is SHARED reference data, not user-owned, so any authenticated user may
// legitimately ask about any problem. There is NO IDOR here and deliberately no
// ownership branch - inventing one would imply a per-user relationship that does not
// exist.
//
// We store no problem statements, so a hint is generated from title + topics +
// difficulty alone and is necessarily approach-level. Fetching LeetCode's statement
// live was rejected: it would spend the wrapper's 120-per-hour quota on a cosmetic
// feature, and it would work for LeetCode and not for Codeforces.
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
      // Sorted so two identical requests differ only by the model's non-determinism.
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
