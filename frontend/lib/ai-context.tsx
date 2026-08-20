"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { api, ApiError } from "./api";

// Is the AI switched on? Asked once, cheaply, at the top of the app.
//
// The backend fails soft by design: with no key it boots normally and only /api/ai/*
// returns 503. This is that property one layer up - if the AI is off the Explain and
// Hint affordances are ABSENT, not disabled with a tooltip and never an error toast.
//
// THE PROBE READS routes/ai.ts GUARD ORDER AS A CONTRACT. That route checks
// not-configured (503) BEFORE body validation (400), so a POST with an empty body
// answers 503 when the AI is off and 400 when it is on - without touching Groq, the
// database, or the rate-limit budget. If that order ever changes this silently reads
// "available" and shows a button that fails.

const AiContext = createContext<boolean>(false);

export function AiProvider({ children }: { children: React.ReactNode }) {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let live = true;

    api("/api/ai/hint", { method: "POST", body: {} })
      .then(() => {
        // A 200 from an empty body should be impossible, but treat it as available rather
        // than reasoning about an impossible state.
        if (live) setAvailable(true);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        if (caught instanceof ApiError) {
          // 400 = we got past "not configured", so the key is set. 503 = explicitly not
          // configured. Anything else leaves it off, which degrades in the safe direction.
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
