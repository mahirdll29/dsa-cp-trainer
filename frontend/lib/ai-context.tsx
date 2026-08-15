"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { api, ApiError } from "./api";

// ---------------------------------------------------------------------------
// IS THE AI SWITCHED ON? — asked once, cheaply, at the top of the app.
//
// The backend's AI layer FAILS SOFT BY DESIGN: with GROQ_API_KEY absent the
// server boots, every other endpoint works normally, and only /api/ai/* returns
// 503. The recommendation engine is pure deterministic logic and produces a
// complete, correct answer with the AI switched off entirely.
//
// THIS FILE IS THAT SAME PROPERTY EXPRESSED ONE LAYER UP. If the AI is off, the
// Explain and Hint affordances are ABSENT — not disabled with a tooltip, not
// present-and-broken, and never an error toast on page load. Everything else
// behaves identically. A UI that fails soft because the backend fails soft is
// the architecture showing through, not a special case.
//
// HOW THE PROBE WORKS, AND WHY IT IS FREE.
//
// There is no GET /api/ai/status endpoint, and Module 7 adds no endpoints. But
// routes/ai.ts runs its three guards in a documented order:
//
//     1. isAiConfigured()  -> 503        <- checked FIRST
//     2. body validation   -> 400
//     3. rate limit        -> 429
//
// So a POST to /api/ai/hint with an EMPTY BODY answers 503 when the AI is off
// and 400 when it is on — and in both cases it returns before touching Groq,
// before touching the database, and before consuming any rate-limit budget. One
// request, no cost, and the interface is honest from first paint instead of
// after a click that fails.
//
// NAMED DEPENDENCY: this reads the guard ORDER as a contract. If not-configured
// were ever moved below body validation, an unconfigured server would answer
// 400 and we would read it as "available" — showing a button that then fails.
// The safer failure would be the other way round, so this is worth knowing.
// The fallback, if that ordering ever changes: drop the probe and set
// `available = false` on the first 503 from a real click. One wasted click, once.
// ---------------------------------------------------------------------------

const AiContext = createContext<boolean>(false);

export function AiProvider({ children }: { children: React.ReactNode }) {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let live = true;

    api("/api/ai/hint", { method: "POST", body: {} })
      .then(() => {
        // A 200 from an empty body should be impossible — the route validates
        // problemId. Treat it as available anyway rather than reasoning about
        // an impossible state.
        if (live) setAvailable(true);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        if (caught instanceof ApiError) {
          // 400 = the guard let us past "not configured", so the key is set.
          // 503 = explicitly not configured.
          // Anything else (network down, 401) leaves it off, which degrades to
          // the safe direction: no AI affordances on a page that still works.
          setAvailable(caught.status === 400);
        }
      });

    return () => {
      live = false;
    };
  }, []);

  return <AiContext.Provider value={available}>{children}</AiContext.Provider>;
}

export function useAiAvailable(): boolean {
  return useContext(AiContext);
}
