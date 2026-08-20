import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { getMasteryOverview, recomputeMastery } from "../engine/mastery";
import { syncRevisionSchedule } from "../engine/revision";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// No endpoint here accepts a user identifier: req.userId goes into the WHERE clause,
// so another user's row is never fetched. The scoping IS the query, not a check after
// it - there is no separate authorization step to forget.

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Redundant in practice; req.userId is typed optional because that is the honest type.
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const overview = await getMasteryOverview(req.userId);

    // Three separate arrays, never merged. `unknown` carries no score, because inventing
    // one (0? 0.5?) is exactly the conflation this module exists to avoid.
    return res.json(overview);
  })
);

// TopicMastery is stored, and a stored derived value rots unless refreshed. The
// importers call the same engine functions directly; this route is the manual trigger.
router.post(
  "/recompute",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // Two named effects, both reported in the response rather than happening invisibly:
    // rebuild every TopicMastery row, and ensure every solved problem has a revision item.
    const topicsUpdated = await recomputeMastery(req.userId);
    const revisionItemsCreated = await syncRevisionSchedule(req.userId);

    return res.json({ topicsUpdated, revisionItemsCreated });
  })
);

export default router;
