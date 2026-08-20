import { NextFunction, Request, Response } from "express";

// CSRF protection. Production needs SameSite=None to work cross-site at all, which
// switches SameSite's own protection off completely; this closes that gap. It works
// because the browser sets Origin itself and page JavaScript cannot forge it.

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

  // FAILS CLOSED: a header-less request would otherwise let a plain HTML form POST
  // walk straight through. Cost: curl and Postman must send an Origin header.
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
