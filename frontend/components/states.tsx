"use client";

import Link from "next/link";
import { ApiError } from "@/lib/api";

// ---------------------------------------------------------------------------
// LOADING, EMPTY AND ERROR — designed screens, not afterthoughts.
//
// All three are states a real user spends real time in: the recommendation
// pipeline measures 4.7-7.7 seconds, a brand-new account has nothing linked,
// and provider syncs genuinely fail. Each gets the same care as the populated
// version of the same screen.
// ---------------------------------------------------------------------------

// THE SKELETON IS THE SHAPE OF THE REAL THING, not a generic pulsing block.
//
// It draws the actual row count at the actual row pitch with the actual axis
// in place, so when the data lands NOTHING MOVES — no reflow, no jump, no
// scroll position lost. That is the functional argument for a skeleton over a
// spinner; the aesthetic one is that a spinner tells you nothing while this
// tells you what is coming.
export function SpreadSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your topic profile</span>
      <div className="bg-quiet/15 h-6 w-40 rounded-[2px]" />
      <div className="bg-quiet/10 mt-2 h-4 w-64 rounded-[2px]" />
      <div className="mt-6 grid grid-cols-[30%_40%_auto]">
        <div />
        <div className="relative">
          <div className="bg-quiet/40 absolute inset-y-0 left-1/2 w-px" aria-hidden />
          <div className="flex flex-col gap-[8px] py-1">
            {Array.from({ length: 32 }).map((_, index) => (
              <div key={index} className="bg-quiet/12 h-[5px] w-full rounded-[1px]" />
            ))}
          </div>
        </div>
        <div />
      </div>
    </div>
  );
}

export function QueueSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Building your recommendations</span>
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="border-rule border-b py-4">
          <div className="bg-quiet/15 h-4 w-2/3 rounded-[2px]" />
          <div className="bg-quiet/10 mt-2 h-3 w-1/3 rounded-[2px]" />
        </div>
      ))}
    </div>
  );
}

// ERRORS SAY WHAT HAPPENED AND WHAT TO DO, in the interface's voice. They do
// not apologise and they are never vague — "Something went wrong" is exactly
// the message this component exists to avoid, so the backend's own text is
// shown whenever there is one.
export function ErrorState({
  error,
  onRetry,
  context,
}: {
  error: Error;
  onRetry?: () => void;
  context: string;
}) {
  const message =
    error instanceof ApiError
      ? error.message
      : "The server did not respond. It may not be running.";

  return (
    <div role="alert" className="border-deficit/40 bg-deficit/5 rounded-[2px] border p-4">
      <p className="t-body-sm text-deficit font-medium">{context}</p>
      <p className="t-body-sm text-ink mt-1">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="t-body-sm text-ink mt-3 underline underline-offset-4 hover:no-underline"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

// AN EMPTY SCREEN IS AN INVITATION TO ACT. It names the one thing that will
// change it and links straight there.
export function EmptyState({
  title,
  body,
  actionHref,
  actionLabel,
}: {
  title: string;
  body: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="border-rule rounded-[2px] border border-dashed p-6">
      <p className="t-body-sm text-ink font-medium">{title}</p>
      <p className="t-body-sm text-quiet mt-1 max-w-prose">{body}</p>
      {actionHref && actionLabel ? (
        <Link
          href={actionHref}
          className="t-body-sm text-ink mt-3 inline-block underline underline-offset-4 hover:no-underline"
        >
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}
