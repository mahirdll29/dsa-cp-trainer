"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAiAvailable } from "@/lib/ai-context";

// Which endpoint goes where is not a style choice. /api/ai/explain narrates why the
// ENGINE recommended a problem and 404s for anything outside the caller's current
// recommendations, so it belongs only on queue rows. /api/ai/hint is approach-level
// guidance about shared reference data, so it works anywhere - which is why revision
// rows get it instead. Putting Explain on a revision row would be a button whose
// brokenness depends on data.
//
// Fired lazily, on click, one at a time: /api/ai/explain takes ~11 s, roughly ten of
// which are the recommendation pipeline running a second time on the server.

type Variant = "explain" | "hint";

const COPY: Record<Variant, { action: string; pending: string; failed: string }> = {
  explain: {
    action: "Why this?",
    pending: "Asking…",
    // The failure message keeps the user pointed at the thing that matters.
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

  // ABSENT, not disabled. A greyed-out button with a tooltip is still a promise the
  // app cannot keep on a deployment that simply chose not to configure the feature.
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
        // Surfaced rather than retried: the binding Groq limit is tokens per minute, so an
        // automatic retry spends budget that has already run out.
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
