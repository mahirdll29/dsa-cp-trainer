import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import aiRoutes from "./routes/ai";
import authRoutes from "./routes/auth";
import codeforcesRoutes from "./routes/codeforces";
import leetcodeRoutes from "./routes/leetcode";
import masteryRoutes from "./routes/mastery";
import recommendationRoutes from "./routes/recommendations";
import revisionRoutes from "./routes/revision";
import { requireSameOrigin } from "./middleware/requireSameOrigin";

const app = express();

// Middleware order is causal, not stylistic. cors() after the routes means the
// browser blocks the response; express.json() after them means req.body is undefined
// and every POST is a 500; cookieParser() after them is the subtlest, because nothing
// crashes - req.cookies is undefined and EVERY authenticated request 401s with the
// cookie sitting right there in the headers.

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    // Must be true or the browser will not send our HTTP-only auth cookie.
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// Registered GLOBALLY and above the routes rather than on the two writes that need
// it today. Per-route opt-in is a checklist item, and checklist items get forgotten
// on route number twelve - which is how CSRF holes actually appear. Every route
// added later inherits the protection and has to opt OUT deliberately.
app.use(requireSameOrigin);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRoutes);
app.use("/api/mastery", masteryRoutes);
app.use("/api/recommendations", recommendationRoutes);
app.use("/api/revision", revisionRoutes);
app.use("/api/integrations/codeforces", codeforcesRoutes);
app.use("/api/integrations/leetcode", leetcodeRoutes);
// The AI layer is an ordinary sibling of the rest of the API, not something the
// pipeline runs through: /api/recommendations never calls Groq, so this whole subtree
// can be unconfigured without changing a byte of what the engine returns.
app.use("/api/ai", aiRoutes);

// MUST come after every route: app.use() with no path matches everything. Without it
// an unknown path returns Express's HTML error page and breaks a JSON client.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// MUST be registered LAST - Express only forwards errors forward through the stack.
//
// Express tells an error handler from ordinary middleware by ARITY: fn.length === 4.
// Delete the unused _next and the arity drops to 3, Express silently registers this
// as normal middleware, it never receives a single error, and errors fall through to
// Express's built-in handler - which in development puts the stack trace in the
// response body. The parameter must exist even though it is never used.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong" });
});

export default app;
