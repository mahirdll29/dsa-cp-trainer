"use client";

import { useState } from "react";
import { PracticeHistory } from "@/components/practice-history";
import { PracticeSession } from "@/components/practice-session";
import { PracticeStart } from "@/components/practice-start";
import { EmptyState, ErrorState, SessionSkeleton } from "@/components/states";
import { api } from "@/lib/api";
import type { ActiveSession, SessionSummary } from "@/lib/types";
import { useResource } from "@/lib/use-resource";

// One session at a time, timed, with hints on a schedule the server owns. Nothing on
// this page decides when a hint unlocks - it renders the answer the server already
// gave and counts down toward asking again.

export default function PracticePage() {
  // Starting, resolving or taking a hint all change both reads, so one counter
  // invalidates both rather than each component refetching on its own schedule.
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((value) => value + 1);

  const active = useResource(
    () => api<{ session: ActiveSession | null }>("/api/sessions/active"),
    version
  );
  const history = useResource(
    () => api<{ sessions: SessionSummary[] }>("/api/sessions/history"),
    version
  );

  const sessions = history.data?.sessions ?? [];

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="t-display">Practice</h1>
      <p className="t-body-sm text-quiet mt-1 max-w-prose">
        Start one problem, and the clock starts with it. Hints arrive on a fixed
        schedule rather than on demand, because the minutes before the first one are
        where the work actually happens.
      </p>

      <div className="mt-6">
        {active.loading ? (
          <SessionSkeleton />
        ) : active.error ? (
          <ErrorState
            error={active.error}
            onRetry={active.reload}
            context="Couldn't load your session."
          />
        ) : active.data?.session ? (
          <PracticeSession session={active.data.session} onChanged={refresh} />
        ) : (
          <PracticeStart onStarted={refresh} />
        )}
      </div>

      <section className="mt-12">
        <h2 className="t-display">Past sessions</h2>
        <p className="t-data-xs text-quiet mt-3 tracking-[0.1em] uppercase">
          {sessions.length} recorded
        </p>

        <div className="mt-4">
          {history.error ? (
            <ErrorState
              error={history.error}
              onRetry={history.reload}
              context="Couldn't load your past sessions."
            />
          ) : sessions.length === 0 ? (
            <EmptyState
              title="No sessions yet."
              body="Finish one and it lands here with how long it took and how many hints it needed."
            />
          ) : (
            <PracticeHistory sessions={sessions} />
          )}
        </div>
      </section>
    </main>
  );
}
