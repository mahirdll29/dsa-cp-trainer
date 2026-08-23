import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import aiRoutes from "./routes/ai";
import analyticsRoutes from "./routes/analytics";
import authRoutes from "./routes/auth";
import codeforcesRoutes from "./routes/codeforces";
import leetcodeRoutes from "./routes/leetcode";
import masteryRoutes from "./routes/mastery";
import problemRoutes from "./routes/problems";
import recommendationRoutes from "./routes/recommendations";
import revisionRoutes from "./routes/revision";
import sessionRoutes from "./routes/sessions";
import { requireSameOrigin } from "./middleware/requireSameOrigin";

const app = express();

// Order is causal, not stylistic. cookieParser() below the routes is the subtlest
// failure: nothing crashes, req.cookies is undefined, and every authenticated request
// 401s with the cookie sitting right there in the headers.

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    // Must be true or the browser will not send our HTTP-only auth cookie.
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// Registered GLOBALLY rather than per-route: a per-route opt-in is a checklist item,
// and checklist items get forgotten on route number twelve.
app.use(requireSameOrigin);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/analytics", analyticsRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/mastery", masteryRoutes);
app.use("/api/problems", problemRoutes);
app.use("/api/recommendations", recommendationRoutes);
app.use("/api/revision", revisionRoutes);
app.use("/api/sessions", sessionRoutes);
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

// MUST be registered LAST, and _next MUST stay even though it is unused: Express
// detects an error handler by ARITY (fn.length === 4). At 3 it silently becomes
// ordinary middleware, never receives an error, and stack traces reach the client.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Something went wrong" });
});

export default app;
