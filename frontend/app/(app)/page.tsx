"use client";

import { api } from "@/lib/api";
import { Queue } from "@/components/queue";
import { Spread } from "@/components/spread";
import { EmptyState, ErrorState, QueueSkeleton, SpreadSkeleton } from "@/components/states";
import type { MasteryOverview, Recommendation } from "@/lib/types";
import { useResource } from "@/lib/use-resource";

// ---------------------------------------------------------------------------
// THE INSTRUMENT — the one screen that answers "what do I do right now".
//
// WHY THE SPREAD AND THE QUEUE ARE SIDE BY SIDE AND NOT TWO PAGES. The product
// is one sentence: *make your weaknesses legible, then tell you what to do
// about them.* Diagnosis on the left, prescription on the right, both visible
// at once, is that sentence rendered as a layout. Splitting them across two
// routes would break the causal link the whole engine exists to draw — and the
// engine caps its output at twelve, so there is no second page of queue to go
// to anyway.
//
// TWO INDEPENDENT FETCHES WITH TWO INDEPENDENT LOADING STATES, and that is
// forced by measured latency rather than chosen for tidiness:
//
//     GET /api/mastery          two fixed queries       ~1s
//     GET /api/recommendations  ~15 sequential Neon round trips at 250-450ms
//                               each — MEASURED 4.7-7.7s on a real account
//
// Awaiting both before painting anything would hold the whole screen hostage
// to the slow one for up to eight seconds. Fetched separately, the Spread —
// which is the signature element and the thing worth looking at — lands almost
// immediately and the Queue fills in behind its own skeleton.
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const mastery = useResource(() => api<MasteryOverview>("/api/mastery"));
  const recommendations = useResource(() =>
    api<{ recommendations: Recommendation[] }>("/api/recommendations")
  );

  // "Has this user linked anything" is answered by their own mastery data, not
  // by a second call to the integrations endpoints: a profile where all 32
  // topics are unmeasured is exactly the state that needs the invitation,
  // whether that is because nothing is linked or because a sync has not run.
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
            // THE EMPTY STATE IS A PRIMARY SCREEN, not a fallback, because it
            // is what every new visitor sees first. It is also not blank: the
            // engine has a real cold-start branch that returns one EASY problem
            // per topic with reason "starting point: <Topic>", so a brand-new
            // user gets twelve genuine recommendations before linking anything.
            // The invitation sits above them rather than replacing them.
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
            // A genuinely empty queue is possible and is an honest outcome: the
            // engine never pads a list to a round number, so if every stage is
            // exhausted it returns fewer items, or none. Saying so is better
            // than implying something is broken.
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
