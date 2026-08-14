import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler";
import { getMasteryOverview, recomputeMastery } from "../engine/mastery";
import { syncRevisionSchedule } from "../engine/revision";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// ---------------------------------------------------------------------------
// OWNERSHIP IN THIS MODULE — and how it differs from a typical CRUD API.
//
// A CRUD endpoint like GET /api/reports/:id fetches the row, then compares
// report.userId with req.userId and 403s on a mismatch. That is a SEPARATE
// AUTHORIZATION STEP, and separate steps get forgotten: miss it on one new
// route and you have an IDOR, where changing an id in the URL returns somebody
// else's data.
//
// None of the five endpoints in this module accepts a user identifier at all.
// req.userId goes straight into the WHERE clause of every query, so another
// user's row is never FETCHED in the first place. The scoping IS the query,
// not a check performed after it — there is no code path on which the check
// could be skipped, because skipping it would mean writing a query with no
// user filter, which is immediately visible in review and returns nothing
// coherent. That is the stronger guarantee.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /api/mastery — the overview, weak and unknown kept separate
// ---------------------------------------------------------------------------
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Redundant in practice — requireAuth guarantees it — but req.userId is
    // typed optional because that is the honest type. Same pattern as
    // /api/auth/me.
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const overview = await getMasteryOverview(req.userId);

    // Three separate arrays, never merged. `unknown` carries no score, because
    // inventing one (0? 0.5?) is exactly the conflation this module exists to
    // avoid: a topic with no data is not a topic scored zero.
    return res.json(overview);
  })
);

// ---------------------------------------------------------------------------
// POST /api/mastery/recompute
// ---------------------------------------------------------------------------
//
// TopicMastery is stored rather than computed (architecture.md 2.2), and any
// stored copy of a derived fact rots unless something refreshes it. Refreshing
// it is this endpoint.
//
// It exists as an endpoint because the importers that would normally call
// recomputeMastery do not exist yet (Modules 4 and 5). When they land they call
// the same engine function directly; this route stays as the manual trigger.
router.post(
  "/recompute",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // TWO NAMED EFFECTS, both reported in the response rather than happening
    // invisibly:
    //   1. rebuild every TopicMastery row from the user's current solve data
    //   2. make sure every solved problem has a revision item
    //
    // The second is here for the same reason as the first: an importer will do
    // both together, so keeping them together now means the scheduling code has
    // a real caller and gets exercised, instead of sitting dead until Module 4.
    const topicsUpdated = await recomputeMastery(req.userId);
    const revisionItemsCreated = await syncRevisionSchedule(req.userId);

    return res.json({ topicsUpdated, revisionItemsCreated });
  })
);

export default router;
