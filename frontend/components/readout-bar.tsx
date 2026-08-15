"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { absoluteTime, relativeTime } from "@/lib/format";
import type { IntegrationStatus } from "@/lib/types";
import { useIntegrationsVersion } from "@/lib/integrations-context";
import { useResource } from "@/lib/use-resource";
import { StatusPill } from "./status-pill";

// ---------------------------------------------------------------------------
// THE READOUT — permanent, on every screen, above everything else.
//
// WHY THIS IS A FIXED BAR AND NOT A TOAST. Every number in this app is a
// snapshot of an on-demand import, so it is ALWAYS some amount of stale. That
// is a permanent property of the data, not an event that happens once, and a
// toast is the wrong shape for a permanent property — it fires, it disappears,
// and the user is left reading numbers with no idea how old they are. Here the
// age is simply always on screen.
//
// The bar carries both a relative age ("2h ago", which answers "should I
// resync?") and the absolute timestamp in the title attribute (which answers
// "is this the run I just did?").
// ---------------------------------------------------------------------------

// 404 from /status means NO ACCOUNT IS LINKED. That is a normal state of this
// application, not a failure, and it is the single most common response this
// component will get — most visitors have linked nothing. Mapping it to null
// here is what stops a brand-new user seeing an error bar on a working page.
async function fetchStatus(provider: "codeforces" | "leetcode") {
  try {
    return await api<IntegrationStatus>(`/api/integrations/${provider}/status`);
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === 404) return null;
    throw caught;
  }
}

function ProviderReadout({
  tag,
  status,
  loading,
}: {
  tag: string;
  status: IntegrationStatus | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <span className="t-data-xs text-quiet">
        {tag} <span className="opacity-40">····</span>
      </span>
    );
  }

  if (!status) {
    return (
      <span className="t-data-xs text-quiet">
        {tag} <span className="opacity-70">not linked</span>
      </span>
    );
  }

  return (
    <span className="t-data-xs text-quiet flex items-center gap-2">
      <span className="text-ink">{tag}</span>
      <span>{status.handle}</span>
      <StatusPill status={status.syncStatus} />
      <span title={absoluteTime(status.lastSyncedAt)}>
        {relativeTime(status.lastSyncedAt)}
      </span>
    </span>
  );
}

export function ReadoutBar() {
  const { user, signOut } = useAuth();
  const pathname = usePathname();

  // `version` bumps whenever the integrations page links, syncs or unlinks
  // something, which is what makes this bar re-read instead of going stale.
  const { version } = useIntegrationsVersion();
  const codeforces = useResource(() => fetchStatus("codeforces"), version);
  const leetcode = useResource(() => fetchStatus("leetcode"), version);

  const links = [
    { href: "/", label: "Instrument" },
    { href: "/revision", label: "Revision" },
    { href: "/integrations", label: "Accounts" },
  ];

  return (
    <header className="border-rule bg-surface sticky top-0 z-20 border-b">
      <div className="mx-auto flex max-w-[100rem] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 sm:px-6">
        <Link href="/" className="t-eyebrow text-ink shrink-0">
          Trainer
        </Link>

        {/* Real <nav> with aria-current, so the active page is announced and
            not merely coloured. */}
        <nav aria-label="Sections" className="flex items-center gap-4">
          {links.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`t-body-sm ${
                  active ? "text-ink underline underline-offset-4" : "text-quiet hover:text-ink"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="order-last flex w-full flex-wrap items-center gap-x-5 gap-y-1 sm:order-none sm:w-auto">
          <ProviderReadout
            tag="CF"
            status={codeforces.data}
            loading={codeforces.loading}
          />
          <ProviderReadout tag="LC" status={leetcode.data} loading={leetcode.loading} />
        </div>

        <div className="ml-auto flex items-center gap-4">
          <span className="t-data-xs text-quiet hidden sm:inline">{user?.email}</span>
          <button
            type="button"
            onClick={() => void signOut()}
            className="t-body-sm text-quiet hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
