import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth";
import codeforcesRoutes from "./routes/codeforces";
import masteryRoutes from "./routes/mastery";
import recommendationRoutes from "./routes/recommendations";
import revisionRoutes from "./routes/revision";
import { requireSameOrigin } from "./middleware/requireSameOrigin";

const app = express();

// MIDDLEWARE ORDER IS CAUSAL, NOT STYLISTIC. Each piece prepares something the
// next one depends on:
//
//   cors()          - if it ran after the routes, the route would still respond
//                     but without Access-Control-Allow-Origin, so the browser
//                     would block the response. Preflight OPTIONS would 404.
//   express.json()  - if it ran after the routes, req.body would be undefined
//                     and `const { email } = req.body` would throw a TypeError,
//                     turning every POST into a 500.
//   cookieParser()  - if it ran after the routes, req.cookies would be
//                     undefined, so requireAuth would find no token and EVERY
//                     authenticated request would 401 while the cookie sat
//                     right there in the request headers. The subtlest of the
//                     three, because nothing crashes.
//
// Separately: server.ts imports "dotenv/config" BEFORE it imports this file,
// which matters because line ~30 below reads process.env.FRONTEND_URL at module
// scope — during import evaluation, not at request time. Reverse those two
// imports and FRONTEND_URL is undefined, CORS silently falls back to the
// hardcoded default, and nothing errors. Silent misconfiguration is the worst
// failure mode, so the order in server.ts is load-bearing.

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    // credentials must be true so the browser sends our HTTP-only auth cookie
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// CSRF protection, added in Module 3 because Module 3 introduces the first
// authenticated state-changing endpoints. Registered GLOBALLY and before the
// routes, rather than attached to the two writes that need it today.
//
// Per-route opt-in is a checklist item, and checklist items get forgotten on
// route number twelve — which is how CSRF holes actually appear in real
// codebases. Registering it once means every route added in Modules 4-7
// inherits the protection by default and has to opt OUT deliberately.
//
// It also now covers /api/auth/login and /logout, which were previously
// unprotected. Login CSRF is a real if minor attack: force a victim's browser
// to log into the ATTACKER's account, and everything they then do accrues to it.
//
// Safe methods pass straight through, so this must sit above the routes but
// below cookieParser — see requireSameOrigin.ts for why it fails closed and
// what that costs non-browser clients.
app.use(requireSameOrigin);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Routes get mounted here as modules are built (auth, codeforces, leetcode, ...)
app.use("/api/auth", authRoutes);
app.use("/api/mastery", masteryRoutes);
app.use("/api/recommendations", recommendationRoutes);
app.use("/api/revision", revisionRoutes);
// Module 4. Mounted under /api/integrations/<provider> so Module 5's LeetCode
// routes become a sibling rather than a competing top-level namespace.
app.use("/api/integrations/codeforces", codeforcesRoutes);

// 404 catch-all. MUST come after every route: app.use() with no path matches
// everything, so registered any earlier it would swallow the whole app.
// Without it, an unknown path falls through to Express's default handler and
// returns an HTML error page, which breaks a JSON client's response parsing.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler. MUST be registered LAST — Express only forwards an error
// FORWARD through the stack, so a handler registered before the routes never
// sees their errors.
//
// Express tells an error handler apart from ordinary middleware by inspecting
// the function's ARITY: fn.length === 4. Delete the unused `_next` parameter
// and the arity drops to 3, Express silently registers this as normal
// middleware, it never receives a single error, and errors fall through to
// Express's built-in handler — which in development puts the full stack trace
// in the response body. The parameter must exist even though it is never used.
//
// The real error goes to the server log; the client gets a generic message so
// we never leak stack traces, file paths or internal error text.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong" });
});

export default app;
