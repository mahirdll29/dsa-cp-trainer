"use client";

import { SyncPanel } from "@/components/sync-panel";
import { useIntegrationsVersion } from "@/lib/integrations-context";

// ---------------------------------------------------------------------------
// ACCOUNTS — the page everything else depends on.
//
// Nothing in this app has data until a judge is linked, so this is the first
// stop for every new user and the only place the two providers are managed.
//
// WHAT UNLINKING ACTUALLY DOES, said out loud on the page rather than buried in
// a confirm dialog: it deletes that provider's imported solve history and
// rebuilds mastery from what is left. That is not over-caution — leaving the
// data behind would let someone link handle A, sync, unlink, link handle B, and
// end up with one mastery profile built from two different people's histories,
// permanently and invisibly. The deletion is recoverable (re-link and re-sync
// restores it, and the revision ladder is kept), which is exactly why it is the
// right trade. A user deserves to know that before they click.
// ---------------------------------------------------------------------------

export default function IntegrationsPage() {
  const { changed } = useIntegrationsVersion();

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="t-display">Accounts</h1>
      <p className="t-body-sm text-quiet mt-1 max-w-prose">
        Link a judge to import your solve history. Imports run when you ask for
        them, never in the background, so what you see is always as fresh as your
        last sync.
      </p>

      <div className="mt-6 grid gap-4">
        {/* `changed()` tells the readout bar in the layout to re-read both
            providers after a link, sync or unlink. NOT `router.refresh()` —
            that refetches Server Components, and every fetch in this app runs
            in the browser, so it is a no-op here. See lib/integrations-context. */}
        <SyncPanel provider="codeforces" onChanged={changed} />
        <SyncPanel provider="leetcode" onChanged={changed} />
      </div>

      <div className="border-rule mt-8 border-t pt-6">
        <h2 className="t-eyebrow">What unlinking removes</h2>
        <p className="t-body-sm text-quiet mt-2 max-w-prose">
          Unlinking deletes the solve history imported from that provider and
          recomputes your topic mastery without it. Your revision schedule is
          kept — that progress was earned here, not imported. Re-linking the same
          handle and syncing restores everything, and picks the revision ladder
          up where it left off.
        </p>
      </div>
    </main>
  );
}
