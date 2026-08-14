import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { getDueRevisions, reviewRevisionItem } from "../engine/revision";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/revision/due — only what is actually due now
// ---------------------------------------------------------------------------
router.get(
  "/due",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // "Due" means dueAt <= now. Items scheduled for the future are absent, not
    // included-and-flagged: the point of a revision planner is that it tells
    // you what to do today, and a list that shows everything is a list you stop
    // reading.
    const items = await getDueRevisions(req.userId);

    return res.json({ items });
  })
);

// ---------------------------------------------------------------------------
// POST /api/revision/:problemId/review — mark reviewed, advance the interval
// ---------------------------------------------------------------------------
router.post(
  "/:problemId/review",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { problemId } = req.params;

    // Hand-written validation, consistent with the auth routes. Express always
    // gives a string here, but an empty segment is worth rejecting explicitly
    // rather than sending "" to Prisma and getting a 404 by accident.
    if (typeof problemId !== "string" || problemId.trim() === "") {
      return res.status(400).json({ error: "Problem id is required" });
    }

    // THE ONLY ROUTE IN THIS MODULE TAKING A PATH PARAMETER, and therefore the
    // only place an ownership bug could hide. There is no ownership branch
    // below, and that is not an oversight: the engine looks the item up by the
    // compound { userId, problemId } unique, so another user's item does not
    // match and comes back null. The 404 below is that case as well as the
    // genuinely-missing case — deliberately indistinguishable, so this cannot
    // be used to probe which problems another user is revising.
    const item = await reviewRevisionItem(req.userId, problemId);

    if (!item) {
      return res.status(404).json({ error: "Revision item not found" });
    }

    return res.json({ item });
  })
);

export default router;
