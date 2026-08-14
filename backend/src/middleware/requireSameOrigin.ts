import { NextFunction, Request, Response } from "express";

// ---------------------------------------------------------------------------
// CSRF PROTECTION — an Origin check.
//
// THE PROBLEM, spelled out. Our auth is a cookie, and the browser attaches a
// cookie to a request based on where the request is GOING, never on where it
// came FROM. So evil.com can host a form or a fetch aimed at our API, and the
// victim's browser will helpfully include their session cookie. The attacker
// cannot read the response (CORS stops that), but for a state-changing
// endpoint they do not need to — the write already happened.
//
// SameSite is the usual defence, and in development (`lax`) it holds: lax
// withholds the cookie on cross-site POSTs. But production runs the frontend on
// Vercel and the API on Railway, which are genuinely different sites, so the
// cookie must be SameSite=None or it is never sent at all — and SameSite=None
// switches that protection off completely. Module 2 recorded this as a gap that
// had to be closed before the first authenticated write existed. Module 3 adds
// two of them, so it is closed here.
//
// WHY AN ORIGIN CHECK WORKS: the browser sets `Origin` itself and page
// JavaScript cannot forge it — fetch will not let you set it, and the browser
// overwrites any attempt. So a request from evil.com announces "evil.com"
// truthfully and we reject it. Compared with a double-submit CSRF token this
// needs no secret to generate, store, rotate or leak, and no cooperation from
// a frontend that does not exist yet (Module 7).
// ---------------------------------------------------------------------------

// The same value the CORS config uses. Keeping them in agreement matters: an
// origin CORS allows but this rejects would produce writes that fail for no
// visible reason.
const allowedOrigin = process.env.FRONTEND_URL || "http://localhost:3000";

// GET/HEAD/OPTIONS change no state, so they are not CSRF targets, and blocking
// them would break ordinary navigation and the CORS preflight the browser sends
// before every credentialed cross-site request.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireSameOrigin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (SAFE_METHODS.has(req.method)) return next();

  // Origin is the reliable signal. Referer is the fallback for the handful of
  // older cases that omit Origin; it carries a full URL, so only its origin
  // portion is compared.
  const origin = req.get("origin") ?? refererOrigin(req.get("referer"));

  // FAILS CLOSED. No Origin and no Referer means we cannot prove the request
  // did not come from another site, and "cannot prove" has to mean "reject" —
  // allowing the header-less case would leave a hole that a plain HTML form
  // POST could walk straight through, since form posts have historically
  // omitted Origin.
  //
  // THE HONEST COST: non-browser clients must now send an Origin header. curl,
  // Postman and any future server-to-server caller get a 403 without one. That
  // is documented rather than worked around, because a silent 403 on an
  // integration is exactly the kind of thing that eats an afternoon.
  if (!origin || origin !== allowedOrigin) {
    return res.status(403).json({ error: "Invalid origin" });
  }

  next();
}

function refererOrigin(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    // Throws on anything that is not a valid absolute URL. A malformed Referer
    // is treated as no Referer rather than crashing the request.
    return new URL(referer).origin;
  } catch {
    return null;
  }
}
