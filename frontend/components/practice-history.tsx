"use client";

import {
  absoluteTime,
  bandColorClass,
  formatDuration,
  providerTag,
} from "@/lib/format";
import type { SessionSummary } from "@/lib/types";

// Solved and gave-up sit on the same axis the rest of the palette encodes - how hard
// this was for you - and the word is always printed beside the colour.
function outcomeClass(status: SessionSummary["status"]): string {
  return status === "SOLVED" ? "text-surplus" : "text-deficit";
}

function outcomeLabel(status: SessionSummary["status"]): string {
  return status === "SOLVED" ? "solved" : "gave up";
}

export function PracticeHistory({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <ol className="border-rule border-t">
      {sessions.map((session) => (
        <li key={session.id} className="border-rule border-b last:border-b-0">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2 py-4">
            <span
              className={`t-data-xs w-20 shrink-0 pt-1 text-right ${outcomeClass(session.status)}`}
            >
              {outcomeLabel(session.status)}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="t-body-sm min-w-0 font-medium">
                  <a
                    href={session.problem.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:underline hover:underline-offset-4"
                  >
                    {session.problem.title}
                    <span className="sr-only">
                      {" "}
                      (opens on {session.problem.provider})
                    </span>
                  </a>
                </h3>
                <span className="t-data-xs flex shrink-0 items-center gap-2">
                  <span className="text-quiet">
                    {providerTag(session.problem.provider)}
                  </span>
                  <span className={bandColorClass(session.problem.difficultyBand)}>
                    {session.problem.difficultyRaw}
                  </span>
                </span>
              </div>

              <p className="t-data-xs text-quiet mt-1">
                {formatDuration(session.startedAt, session.resolvedAt)} ·{" "}
                {session.hintCount} hint{session.hintCount === 1 ? "" : "s"} ·{" "}
                {absoluteTime(session.resolvedAt)}
              </p>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
