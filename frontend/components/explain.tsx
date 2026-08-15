"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAiAvailable } from "@/lib/ai-context";

// ---------------------------------------------------------------------------
// THE AI AFFORDANCE — optional by design, at both layers.
//
// WHICH ENDPOINT GOES WHERE IS NOT A STYLE CHOICE:
//
//   /api/ai/explain  narrates why the ENGINE recommended this problem. The
//                    server re-derives the reason from the real pipeline and
//                    404s if the problem is not in the caller's current
//                    recommendations — that 404 is the endpoint's ownership
//                    boundary. So Explain belongs ONLY on queue rows.
//   /api/ai/hint     is approach-level guidance about a problem. Problem rows
//                    are shared reference data, so any authenticated user may
//                    ask about any problem. Hint works anywhere, which is why
//                    revision rows get it instead.
//
// Putting Explain on a revision row would produce a 404 for every item that is
// not also in the current twelve — a broken button whose brokenness depends on
// data. Hence two variants of one component rather than one generic one.
//
// FIRED LAZILY, ON CLICK, ONE AT A TIME. /api/ai/explain measures ~11 seconds
// end to end, and roughly ten of those are the recommendation pipeline running
// a second time on the server, not the model. Firing it eagerly for all twelve
// rows would mean twelve pipeline runs for text nobody asked to read.
// ---------------------------------------------------------------------------

type Variant = "explain" | "hint";

const COPY: Record<Variant, { action: string; pending: string; failed: string }> = {
  explain: {
    action: "Why this?",
    pending: "Asking…",
    // The failure message keeps the user pointed at the thing that matters.
    // The recommendation is the product; the explanation is commentary.
    failed: "Couldn't get an explanation. The recommendation still stands.",
  },
  hint: {
    action: "Hint",
    pending: "Asking…",
    failed: "Couldn't get a hint. Open the problem and start anyway.",
  },
};

export function AiAffordance({
  problemId,
  variant,
}: {
  problemId: string;
  variant: Variant;
}) {
  const available = useAiAvailable();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // ABSENT, NOT DISABLED. A greyed-out button with a tooltip is still a
  // promise the app cannot keep, and it puts a permanently dead control in
  // front of every user on a deployment that simply chose not to configure an
  // optional feature. Rendering nothing is the honest degradation.
  if (!available) return null;

  const copy = COPY[variant];

  async function ask() {
    setPending(true);
    setError(null);
    try {
      const path = variant === "explain" ? "/api/ai/explain" : "/api/ai/hint";
      const key = variant === "explain" ? "explanation" : "hint";
      const result = await api<Record<string, string>>(path, {
        method: "POST",
        body: { problemId },
      });
      setText(result[key] ?? null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        // The backend propagates Retry-After in seconds. Surfacing it is the
        // useful thing to do; retrying automatically is not, because the
        // binding Groq limit is tokens per minute and a retry spends budget
        // that has already run out.
        setError(
          caught.retryAfterSeconds
            ? `Too many AI requests. Try again in ${caught.retryAfterSeconds}s.`
            : caught.message
        );
      } else {
        setError(copy.failed);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-2">
      {text === null ? (
        <button
          type="button"
          onClick={() => void ask()}
          disabled={pending}
          className="t-body-sm text-quiet hover:text-ink underline underline-offset-4 hover:no-underline disabled:no-underline"
        >
          {pending ? copy.pending : copy.action}
        </button>
      ) : (
        <p className="t-body-sm text-ink border-quiet/40 max-w-prose border-l-2 pl-3">
          {text}
        </p>
      )}

      {/* Inline and quiet. An AI failure must never look like the page broke —
          it is a missing sentence, not a missing feature. */}
      {error ? (
        <p role="status" className="t-body-sm text-quiet mt-1">
          {error}
        </p>
      ) : null}
    </div>
  );
}
