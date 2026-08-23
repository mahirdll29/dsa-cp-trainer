"use client";

import { useCallback, useState } from "react";
import { ContestHistory } from "@/components/contest-history";
import { ContestLive } from "@/components/contest-live";
import { ContestResults } from "@/components/contest-results";
import { ContestSetup } from "@/components/contest-setup";
import { EmptyState, ErrorState, SessionSkeleton } from "@/components/states";
import { api } from "@/lib/api";
import type { Contest, ContestSummary } from "@/lib/types";
import { useResource } from "@/lib/use-resource";

// One route, no dynamic segment: presence of the server object is the mode, the same
// way the practice page works. A past contest is opened into local state rather than a
// nested URL, which also keeps the nav tab's exact-match highlight working.
//
// Nothing here decides when a contest ends. The clock is the server's, and a contest
// whose time has run out is finalized by the next read of it.

export default function ContestPage() {
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const [viewing, setViewing] = useState<string | null>(null);

  const active = useResource(
    () => api<{ contest: Contest | null }>("/api/contests/active"),
    version
  );
  const history = useResource(
    () => api<{ contests: ContestSummary[] }>("/api/contests/history"),
    version
  );

  const finished = useCallback(
    (contestId: string) => {
      setViewing(contestId);
      refresh();
    },
    [refresh]
  );

  const contests = history.data?.contests ?? [];
  const running = active.data?.contest ?? null;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="t-display">Contest</h1>
      <p className="t-body-sm text-quiet mt-1 max-w-prose">
        A timed set at a fixed difficulty spread. You mark what you solve as you go;
        afterwards the app checks those marks against what Codeforces and LeetCode
        actually recorded.
      </p>

      <div className="mt-6">
        {active.loading ? (
          <SessionSkeleton />
        ) : active.error ? (
          <ErrorState
            error={active.error}
            onRetry={active.reload}
            context="Couldn't load your contest."
          />
        ) : running ? (
          <ContestLive contest={running} onFinished={finished} />
        ) : viewing ? (
          <ContestResults contestId={viewing} onBack={() => setViewing(null)} />
        ) : (
          <ContestSetup onStarted={refresh} />
        )}
      </div>

      {running || viewing ? null : (
        <section className="mt-12">
          <h2 className="t-display">Past contests</h2>
          <p className="t-data-xs text-quiet mt-3 tracking-[0.1em] uppercase">
            {contests.length} recorded
          </p>

          <div className="mt-4">
            {history.error ? (
              <ErrorState
                error={history.error}
                onRetry={history.reload}
                context="Couldn't load your past contests."
              />
            ) : contests.length === 0 ? (
              <EmptyState
                title="No contests yet."
                body="Finish one and it lands here with what you marked and what the providers confirmed."
              />
            ) : (
              <ContestHistory contests={contests} onSelect={setViewing} />
            )}
          </div>
        </section>
      )}
    </main>
  );
}
