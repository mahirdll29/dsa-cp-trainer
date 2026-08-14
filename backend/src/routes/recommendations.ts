import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { buildRecommendations } from "../engine/recommend";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/recommendations — the ranked list, each item with its reason
//
// The handler is deliberately three lines. All of the logic lives in
// src/engine/recommend.ts, because the engine has to be testable without HTTP
// and callable from the importers in Modules 4 and 5. The route's only job is
// to turn a request into a userId and a result into JSON.
//
// Recommendations are NEVER STORED (architecture.md 2.6, decision 3). They are
// cheap to derive, and storing them would create a third copy of derived data
// with its own staleness and invalidation bugs, buying nothing. Computed per
// request, every request.
// ---------------------------------------------------------------------------
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
