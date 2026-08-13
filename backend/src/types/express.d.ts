// DECLARATION MERGING.
//
// requireAuth needs to hand the verified userId to the route handler, and the
// only object that travels between them is `req`. But `Request` is declared by
// @types/express, a package we do not own and must not edit.
//
// TypeScript's answer is declaration merging: reopen an interface another
// package already declared and add fields to it. Every `Request` in the project
// then has the field, with no cast anywhere. The alternative — writing
// `(req as any).userId` at each use — would switch off type checking on the one
// value that decides who the caller is, which is the last place to want it off.
//
// `export {}` is what makes this file a module. Without it TypeScript treats it
// as a global script and `declare global` is illegal inside it.

export {};

declare global {
  namespace Express {
    interface Request {
      // OPTIONAL, and deliberately so.
      //
      // On an unauthenticated request this genuinely is absent. Declaring it
      // required (`userId: string`) would be the type system asserting
      // something false — and that lie would spread: every future route,
      // including ones NOT behind requireAuth, would believe the value is
      // guaranteed and use it without checking.
      //
      // The cost is one redundant `if (!req.userId)` inside handlers that
      // requireAuth already protects. That check is cheap; a type that lies is
      // not. Honest beats convenient.
      userId?: string;
    }
  }
}
