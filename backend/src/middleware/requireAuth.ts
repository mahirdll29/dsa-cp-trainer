import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { COOKIE_NAME } from "../lib/auth";
import { JWT_SECRET } from "../lib/env";

// The gate for every protected route. Reads the token from the cookie (not an
// Authorization header - the browser attaches this one automatically), verifies it,
// and puts the userId on the request.

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Populated by cookieParser(), which app.ts registers above the routes.
  const token = req.cookies?.[COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    // Throws on all three failure modes we care about: bad signature, expired token, and
    // a string that is not a well-formed JWT. All three collapse to the same generic 401
    // - distinguishing "expired" only matters with a refresh flow, which v1 does not have.
    const payload = jwt.verify(token, JWT_SECRET);

    // jwt.verify returns `string | JwtPayload`, so the shape is not guaranteed by the
    // type system even for a token we signed.
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.userId !== "string"
    ) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    req.userId = payload.userId;

    next();
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }
}

// Every failure path above starts with `return` because res.status().json() sends a
// response but does NOT stop the function. Without it execution reaches next(), the
// protected handler runs with no userId, and Express throws "Cannot set headers after
// they are sent". The return is the difference between a guard and a suggestion.
