"use client";

import Link from "next/link";
import { ApiError } from "@/lib/api";

// The loading, error and empty states, shared by every page.

// The skeleton is the SHAPE of the real thing, not a generic grey box, so the layout
// does not jump when content arrives.
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

export function QueueSkeleton({
  label = "Building your recommendations",
}: {
  label?: string;
} = {}) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="border-rule border-b py-4">
          <div className="bg-quiet/15 h-4 w-2/3 rounded-[2px]" />
          <div className="bg-quiet/10 mt-2 h-3 w-1/3 rounded-[2px]" />
        </div>
      ))}
    </div>
  );
}

export function SessionSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your session</span>
      <div className="panel p-5">
        <div className="bg-quiet/15 h-5 w-1/2 rounded-[2px]" />
        <div className="bg-quiet/10 mt-2 h-3 w-1/4 rounded-[2px]" />
        <div className="border-rule mt-6 border-t">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="border-rule border-b py-4 last:border-b-0">
              <div className="bg-quiet/10 h-3 w-24 rounded-[2px]" />
              <div className="bg-quiet/12 mt-2 h-4 w-3/4 rounded-[2px]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Errors say what happened and what to do. The ApiError message is the backend's own
// wording, which is more specific than anything this component could invent.
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

// An empty screen is an invitation to act: it names the next step and links to it.
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
