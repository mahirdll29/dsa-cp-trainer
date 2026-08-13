import { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 predates async/await and does not understand promises. Nothing in
// Express awaits the value an `async` route handler returns, so if that handler
// rejects, Express never finds out: the rejection becomes an UNHANDLED PROMISE
// REJECTION, and since Node 15 the default behaviour for those is to terminate
// the process. One failed Prisma query in one route would kill the whole server.
//
// This wrapper attaches .catch(next) to the returned promise. Calling next()
// WITH an argument is Express's signal to skip every remaining normal
// middleware and jump straight to the 4-argument error handler — so a rejection
// becomes a clean 500 instead of a crash.
//
// Express 5 does this automatically. Writing it by hand is the honest cost of
// staying on Express 4 (chosen for parity with the first project and for the
// far more settled v4 type/middleware ecosystem).

type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<unknown>;

export function asyncHandler(fn: AsyncRouteHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
