import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { COOKIE_NAME } from "../lib/auth";
import { JWT_SECRET } from "../lib/env";

// The gate for every protected route from Module 3 onward.
//
// It reads the token from the cookie (NOT from an Authorization header — the
// browser attaches this cookie automatically, which is the whole point of the
// httpOnly cookie approach), verifies it, and puts the userId on the request.

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // req.cookies is populated by cookieParser(), which app.ts registers before
  // any route. If cookieParser ever moved below the routes, this would be
  // undefined and every authenticated request would 401 with the cookie
  // sitting right there in the headers.
  const token = req.cookies?.[COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    // jwt.verify recomputes the signature over the received header+payload
    // using our secret and compares it to the signature attached. It THROWS on
    // all three failure modes we care about:
    //   - the signature does not match (someone edited the payload)
    //   - the token is expired (exp is in the past)
    //   - the string is not a well-formed JWT at all
    //
    // All three collapse to the same generic 401. We deliberately do not tell
    // the client which one it was: it is information the caller does not need,
    // and distinguishing "expired" only matters if you have a refresh flow,
    // which v1 does not.
    const payload = jwt.verify(token, JWT_SECRET);

    // jwt.verify returns `string | JwtPayload`, so the shape is not guaranteed
    // by the type system. A token we signed always has a string userId, but
    // checking costs nothing and keeps a malformed-but-validly-signed token
    // from putting a non-string onto req.
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.userId !== "string"
    ) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    req.userId = payload.userId;

    // Only on the success path. next() hands control to the route handler.
    next();
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }
}

// WHY EVERY FAILURE PATH ABOVE STARTS WITH `return`:
//
// res.status(401).json(...) sends a response but does NOT stop the function.
// Without the `return`, execution would continue past the guard, reach next(),
// and run the protected handler anyway — with no userId set. The handler would
// then try to send a second response and Express would throw "Cannot set
// headers after they are sent to the client".
//
// So the `return` is not a style preference. It is the difference between a
// guard and a suggestion.
