import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { getMasteryOverview, recomputeMastery } from "../engine/mastery";
import { syncRevisionSchedule } from "../engine/revision";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// Ownership here differs from a typical CRUD API and is stronger. A route like
// GET /api/reports/:id fetches the row and THEN compares owner ids - a separate
// authorization step, and separate steps get forgotten, which is how an IDOR appears.
// No endpoint in this module accepts a user identifier at all: req.userId goes into
// the WHERE clause, so another user's row is never fetched in the first place.

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

// TopicMastery is stored rather than computed, and any stored copy of a derived fact
// rots unless something refreshes it. The importers call the same engine functions
// directly; this route is the manual trigger.
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
