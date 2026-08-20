import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { getDueRevisions, reviewRevisionItem } from "../engine/revision";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

router.get(
  "/due",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // "Due" means dueAt <= now. Future items are absent rather than shown-and-greyed: a
    // list that shows everything is a list people stop reading.
    const items = await getDueRevisions(req.userId);

    return res.json({ items });
  })
);

router.post(
  "/:problemId/review",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { problemId } = req.params;

    // An empty segment is rejected explicitly rather than sent to Prisma to 404 by accident.
    if (typeof problemId !== "string" || problemId.trim() === "") {
      return res.status(400).json({ error: "Problem id is required" });
    }

    // The only route here taking a path parameter, and therefore the only place an
    // ownership bug could hide. There is no ownership branch because the engine looks the
    // item up on the compound { userId, problemId } unique - another user's item does not
    // match. The 404 covers both "not yours" and "does not exist", deliberately
    // indistinguishable, so it cannot be used to probe what others are revising.
    const item = await reviewRevisionItem(req.userId, problemId);

    if (!item) {
      return res.status(404).json({ error: "Revision item not found" });
    }

    return res.json({ item });
  })
);

export default router;
