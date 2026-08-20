import { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 does not understand promises: nothing awaits what an async handler
// returns, so a rejection becomes an unhandled promise rejection, which since Node 15
// terminates the process. One failed Prisma query in one route would kill the server.
//
// Calling next() WITH an argument is Express's signal to jump straight to the
// four-argument error handler. Express 5 does this automatically; doing it by hand is
// the cost of staying on v4.

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
