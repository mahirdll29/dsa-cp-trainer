"use client";

import { api } from "@/lib/api";
import { Queue } from "@/components/queue";
import { Spread } from "@/components/spread";
import { EmptyState, ErrorState, QueueSkeleton, SpreadSkeleton } from "@/components/states";
import type { MasteryOverview, Recommendation } from "@/lib/types";
import { useResource } from "@/lib/use-resource";

// Diagnosis on the left, prescription on the right, both visible at once - the
// product's one sentence rendered as a layout.
//
// Two independent fetches with two independent loading states, forced by measured
// latency rather than chosen for tidiness: GET /api/mastery is ~1s, GET
// /api/recommendations is 4.7-7.7s. Awaiting both before painting would hold the
// whole screen hostage to the slow one.

export default function DashboardPage() {
  const mastery = useResource(() => api<MasteryOverview>("/api/mastery"));
  const recommendations = useResource(() =>
    api<{ recommendations: Recommendation[] }>("/api/recommendations")
  );

  // Answered by the user's own mastery data rather than a second call to the
  // integrations endpoints: 32 unmeasured topics is exactly the state that needs the
  // invitation, whether nothing is linked or a sync has not run.
  const nothingMeasured =
    mastery.data !== null &&
    mastery.data.weak.length === 0 &&
    mastery.data.strong.length === 0;

  return (
    <main className="mx-auto w-full max-w-[100rem] flex-1 px-4 py-8 sm:px-6">
      {/* 32rem for the Spread, arrived at by measurement rather than by taste:
          at 26rem the track collapsed to ~150px and 32 bars stopped reading as
          measurements. The instrument needs the room; the Queue is text and
          reflows fine with whatever is left. */}
      <div className="grid gap-10 lg:grid-cols-[32rem_minmax(0,1fr)] lg:gap-12">
        {/* --- THE SPREAD ---
            Sticky on wide screens so the diagnosis stays on screen while the
            reader works down the queue. On mobile it comes SECOND (order-2):
            the queue answers "what now", which is the more urgent question on
            a phone, and the 32-row diagram wants a wider viewport to be read
            properly. */}
        <div className="order-2 lg:order-1">
          <div className="lg:sticky lg:top-20">
            {mastery.loading ? (
              <SpreadSkeleton />
            ) : mastery.error ? (
              <ErrorState
                error={mastery.error}
                onRetry={mastery.reload}
                context="Couldn't load your topic profile."
              />
            ) : mastery.data ? (
              <Spread overview={mastery.data} />
            ) : null}
          </div>
        </div>

        {/* --- THE QUEUE --- */}
        <div className="order-1 lg:order-2">
          {nothingMeasured ? (
            // Not a fallback - this is what every new visitor sees first, and it is not blank:
            // the engine's cold-start branch returns real recommendations, so the invitation sits
            // above them rather than replacing them.
            <div className="mb-8">
              <EmptyState
                title="Nothing measured yet."
                body="Link a judge and your solve history fills in the Spread. Until then, here is a starting set — one problem from each topic, chosen to produce a first signal rather than to be difficult."
                actionHref="/integrations"
                actionLabel="Link an account"
              />
            </div>
          ) : null}

          {recommendations.loading ? (
            <QueueSkeleton />
          ) : recommendations.error ? (
            <ErrorState
              error={recommendations.error}
              onRetry={recommendations.reload}
              context="Couldn't build your recommendations."
            />
          ) : recommendations.data && recommendations.data.recommendations.length > 0 ? (
            <Queue items={recommendations.data.recommendations} />
          ) : (
            // A genuinely empty queue is an honest outcome: the engine never pads a list to a
            // round number, so if every stage is exhausted it returns fewer items, or none.
            <EmptyState
              title="Nothing to recommend right now."
              body="Every topic with data is above the weak threshold and nothing is due for revision. Sync again after you have solved a few more problems."
              actionHref="/integrations"
              actionLabel="Sync your accounts"
            />
          )}
        </div>
      </div>
    </main>
  );
}
