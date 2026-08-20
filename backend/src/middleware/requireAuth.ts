import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { COOKIE_NAME } from "../lib/auth";
import { JWT_SECRET } from "../lib/env";

// The gate for every protected route. The token comes from the cookie, not an
// Authorization header - the browser attaches it automatically.

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Populated by cookieParser(), which app.ts registers above the routes.
  const token = req.cookies?.[COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    // Bad signature, expired, and malformed all throw, and all collapse to one generic
    // 401 - distinguishing "expired" only matters with a refresh flow, which v1 lacks.
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

// Every failure path above starts with `return`: res.json() sends a response but does
// NOT stop the function, so without it the protected handler runs with no userId.
