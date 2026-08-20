import { NextFunction, Request, Response } from "express";

// CSRF protection by Origin check.
//
// The browser attaches a cookie based on where a request is GOING, never where it
// came FROM, so evil.com can aim a form at our API and the victim's browser will
// include their session cookie. SameSite normally prevents this, but production
// needs SameSite=None to work cross-site at all, and None switches that protection
// off completely. This is what closes that gap.
//
// An Origin check works because the browser sets Origin itself and page JavaScript
// cannot forge it - fetch will not let you set it, and the browser overwrites any
// attempt.

// The same value the CORS config uses. An origin CORS allows but this rejects would
// produce writes that fail for no visible reason.
const allowedOrigin = process.env.FRONTEND_URL || "http://localhost:3000";

// Safe methods change no state, and blocking OPTIONS would break the CORS preflight.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireSameOrigin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (SAFE_METHODS.has(req.method)) return next();

  // Referer is the fallback for the cases that omit Origin; only its origin is compared.
  const origin = req.get("origin") ?? refererOrigin(req.get("referer"));

  // FAILS CLOSED. No Origin and no Referer means we cannot prove the request did not
  // come from another site, and "cannot prove" has to mean reject - a plain HTML form
  // POST would otherwise walk straight through, since form posts historically omit
  // Origin. Cost: non-browser clients (curl, Postman) must send an Origin header.
  if (!origin || origin !== allowedOrigin) {
    return res.status(403).json({ error: "Invalid origin" });
  }

  next();
}

function refererOrigin(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    // A malformed Referer is treated as no Referer rather than crashing the request.
    return new URL(referer).origin;
  } catch {
    return null;
  }
}
