import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { buildRecommendations } from "../engine/recommend";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// The handler is deliberately three lines: all the logic lives in engine/recommend.ts
// so it is testable without HTTP and callable from the importers.
//
// Recommendations are NEVER STORED. They are cheap to derive, and storing them would
// create a third copy of derived data with its own staleness and invalidation bugs.
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const recommendations = await buildRecommendations(req.userId);

    return res.json({ recommendations });
  })
);

export default router;
