"use client";

import { useEffect, useState } from "react";
import { StatusPill } from "./status-pill";
import { Button } from "@/components/ui/button";
import { FormError, FormField } from "./form-field";
import { api, ApiError } from "@/lib/api";
import { absoluteTime, relativeTime } from "@/lib/format";
import type { IntegrationStatus, LinkedAccount, SyncResult } from "@/lib/types";

// Syncs are slow and they fail, and this component is designed for that rather than
// around it. Codeforces holds the connection 13-28s; the LeetCode wrapper runs on a
// free tier that cold-starts in 30-60s.
//
// A spinner is the wrong answer. We cannot know a percentage - the endpoint is a
// single synchronous POST with no progress channel - so we show the two things we do
// know: how long this has been running, and how long it usually takes.

type ProviderKey = "codeforces" | "leetcode";

const META: Record<
  ProviderKey,
  { name: string; tag: string; field: string; expectation: string; note?: string }
> = {
  codeforces: {
    name: "Codeforces",
    tag: "CF",
    field: "Codeforces handle",
    expectation: "Codeforces syncs usually take 13–28 seconds.",
  },
  leetcode: {
    name: "LeetCode",
    tag: "LC",
    field: "LeetCode username",
    expectation: "LeetCode syncs usually take 15–60 seconds.",
    // Stated up front rather than discovered as a hang.
    note: "LeetCode has no official API, so this goes through a community service that sleeps when idle. The first sync of the day can take a minute to wake it up.",
  },
};

export function SyncPanel({
  provider,
  onChanged,
}: {
  provider: ProviderKey;
  onChanged: () => void;
}) {
  const meta = META[provider];

  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "linking" | "syncing" | "unlinking">(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<SyncResult | null>(null);

  const base = `/api/integrations/${provider}`;

  // 404 IS "NOTHING LINKED", NOT AN ERROR - the most common response this endpoint
  // gives, and treating it as a failure would put a red error card on a healthy page.
  async function readStatus(): Promise<IntegrationStatus | null> {
    try {
      return await api<IntegrationStatus>(`${base}/status`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 404) return null;
      throw caught;
    }
  }

  const refresh = async () => {
    try {
      setStatus(await readStatus());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't read sync status.");
    } finally {
      setLoading(false);
    }
  };

  // The write happens after an await, so nothing is set synchronously in the effect.
  useEffect(() => {
    let live = true;
    readStatus()
      .then((next) => {
        if (!live) return;
        setStatus(next);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        setError(
          caught instanceof ApiError ? caught.message : "Couldn't read sync status."
        );
        setLoading(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // Ticks only while a sync is running, so nothing on this page moves when it is idle.
  // The counter is reset in sync() rather than here, because the reset belongs to the
  // event that starts the sync, not to the effect that observes it.
  useEffect(() => {
    if (busy !== "syncing") return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // POST /sync is synchronous and tells us nothing until it finishes, so GET /status -
  // a cheap read of our own database - is what makes PENDING -> SYNCING -> COMPLETED
  // visible while the work happens. It also covers the case the POST cannot: if the
  // browser loses the response, the import is still running on the server.
  useEffect(() => {
    if (busy !== "syncing") return;
    const poll = setInterval(() => {
      void readStatus()
        .then((next) => next && setStatus(next))
        .catch(() => {
          /* a failed poll is not worth surfacing; the next one will do */
        });
    }, 2000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, provider]);

  async function link() {
    setBusy("linking");
    setError(null);
    try {
      const { linkedAccount } = await api<{ linkedAccount: LinkedAccount }>(`${base}/link`, {
        method: "POST",
        body: { handle },
      });
      // The stored handle is the provider's canonical casing, not what was typed.
      setStatus({
        handle: linkedAccount.handle,
        syncStatus: linkedAccount.syncStatus,
        lastSyncedAt: linkedAccount.lastSyncedAt,
      });
      setHandle("");
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't link that account.");
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    setBusy("syncing");
    setElapsed(0);
    setError(null);
    setResult(null);
    try {
      setResult(await api<SyncResult>(`${base}/sync`, { method: "POST" }));
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        // "A sync is already in progress" is not a failure - another tab is doing the work.
        setError(null);
      } else {
        setError(caught instanceof ApiError ? caught.message : "The sync didn't finish.");
      }
    } finally {
      setBusy(null);
      // Always re-read: the POST may have failed, and only /status knows whether the
      // backend recorded FAILED and left lastSyncedAt alone.
      void refresh();
    }
  }

  async function unlink() {
    setBusy("unlinking");
    setError(null);
    try {
      await api(`${base}/link`, { method: "DELETE" });
      setStatus(null);
      setResult(null);
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't unlink that account.");
    } finally {
      setBusy(null);
    }
  }

  const syncing = busy === "syncing" || status?.syncStatus === "SYNCING";

  return (
    <section className="panel p-5" aria-labelledby={`${provider}-heading`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`${provider}-heading`} className="t-eyebrow text-ink">
          {meta.name}
        </h2>
        {status ? <StatusPill status={syncing ? "SYNCING" : status.syncStatus} /> : null}
      </div>

      {loading ? (
        <p className="t-body-sm text-quiet mt-4">Checking…</p>
      ) : status === null ? (
        /* ---------- NOT LINKED ---------- */
        <div className="mt-4 grid max-w-md gap-3">
          <p className="t-body-sm text-quiet">
            Not linked. {meta.note ?? "Your solve history is imported on demand, never in the background."}
          </p>
          <FormError message={error} />
          <FormField
            id={`${provider}-handle`}
            label={meta.field}
            value={handle}
            onChange={setHandle}
            disabled={busy !== null}
            invalid={Boolean(error)}
          />
          <div>
            <Button
              type="button"
              onClick={() => void link()}
              disabled={busy !== null || handle.trim() === ""}
              className="h-9 rounded-[2px]"
            >
              {busy === "linking" ? "Linking…" : "Link account"}
            </Button>
          </div>
        </div>
      ) : (
        /* ---------- LINKED ---------- */
        <div className="mt-4">
          <p className="t-data text-ink">{status.handle}</p>

          {/* STALENESS, STATED PLAINLY. Both forms: the relative age answers
              "should I sync again", the absolute timestamp answers "is this the
              run I just did". */}
          <p className="t-data-xs text-quiet mt-1">
            {status.lastSyncedAt
              ? `Last synced ${absoluteTime(status.lastSyncedAt)} · ${relativeTime(status.lastSyncedAt)}`
              : "Never synced. Run a sync to import your history."}
          </p>

          {syncing ? (
            /* REAL PROGRESS STATE, NOT A SPINNER. We cannot report a
               percentage, so we report the two facts we have. */
            <p role="status" className="t-body-sm text-median mt-3">
              Importing… <span className="t-data">{elapsed}s</span> elapsed.{" "}
              <span className="text-quiet">{meta.expectation}</span>
            </p>
          ) : null}

          {/* A FAILED IMPORT IS VISIBLE, EXPLAINS ITSELF, AND IS RETRYABLE.
              The reassurance is literally true: the backend moves syncStatus to
              FAILED but leaves lastSyncedAt untouched and every existing row
              intact, and it releases the lock so a retry works immediately
              rather than waiting out a staleness window. */}
          {status.syncStatus === "FAILED" && !syncing ? (
            <div
              role="alert"
              className="border-deficit/40 bg-deficit/5 mt-3 rounded-[2px] border p-3"
            >
              <p className="t-body-sm text-deficit font-medium">The last sync failed.</p>
              {error ? <p className="t-body-sm text-ink mt-1">{error}</p> : null}
              <p className="t-body-sm text-quiet mt-1">
                Your existing data is unchanged. Try again — it usually works on a
                second attempt.
              </p>
            </div>
          ) : error ? (
            <p role="alert" className="t-body-sm text-deficit mt-3">
              {error}
            </p>
          ) : null}

          {result ? (
            <p className="t-data-xs text-quiet mt-3">
              {result.solved ?? 0} solved · {result.topicsUpdated ?? 0} topics updated
              {result.revisionItemsCreated
                ? ` · ${result.revisionItemsCreated} revision items scheduled`
                : ""}
            </p>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => void sync()}
              disabled={busy !== null}
              className="h-9 rounded-[2px]"
            >
              {syncing ? "Syncing…" : status.syncStatus === "FAILED" ? "Try again" : "Sync now"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void unlink()}
              disabled={busy !== null}
              className="border-quiet/70 h-9 rounded-[2px]"
            >
              {busy === "unlinking" ? "Unlinking…" : "Unlink"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
