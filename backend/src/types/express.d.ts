// Declaration merging: reopen the Request interface that @types/express declares -
// a package we do not own and must not edit - so requireAuth can hand the verified
// userId to the route handler with no cast anywhere. Writing (req as any).userId
// instead would switch off type checking on the one value that decides who the
// caller is.
//
// `export {}` is what makes this a module; without it `declare global` is illegal.

export {};

declare global {
  namespace Express {
    interface Request {
      // Optional, deliberately: on an unauthenticated request it genuinely is absent, and
      // declaring it required would be the type system asserting something false. The cost
      // is one redundant check inside handlers requireAuth already protects.
      userId?: string;
    }
  }
}
