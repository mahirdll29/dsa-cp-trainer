"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { api, ApiError } from "./api";

// Is the AI switched on? The backend fails soft, so this is that same property one
// layer up: with no key, the Explain and Hint affordances are ABSENT rather than
// present-and-broken.
//
// THE PROBE READS routes/ai.ts GUARD ORDER AS A CONTRACT: that route checks
// not-configured (503) before body validation (400), so an empty-body POST
// distinguishes the two for free. Change that order and this silently reads
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
