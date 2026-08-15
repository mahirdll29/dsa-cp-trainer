"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ReadoutBar } from "@/components/readout-bar";
import { AiProvider } from "@/lib/ai-context";
import { IntegrationsProvider } from "@/lib/integrations-context";
import { useAuth } from "@/lib/auth-context";

// ---------------------------------------------------------------------------
// THE PROTECTED SHELL — everything behind requireAuth on the backend.
//
// A ROUTE GROUP, `(app)`, so /login and /register can live outside it without
// appearing in the URL. The parentheses are the whole mechanism: the folder
// organises the tree and contributes nothing to the path, so this layout wraps
// /, /revision and /integrations while the auth pages stay untouched.
//
// SAY THIS PLAINLY BECAUSE IT IS THE EASIEST THING IN THE MODULE TO GET
// BACKWARDS: **THE REDIRECT BELOW IS UX, NOT SECURITY.**
//
// It protects nothing. Anyone can open devtools and delete it, or request the
// API directly, and they will get exactly the same result they get now — the
// backend's requireAuth middleware rejects every request without a valid token,
// and requireSameOrigin rejects every write from another origin. Those two run
// on the server and cannot be reached from a browser. This component exists so
// that a signed-out visitor sees a login form instead of three empty panels and
// a row of failed requests.
//
// If a client-side check were ever the only thing standing between a user and
// someone else's data, the vulnerability would be on the server, not here.
// ---------------------------------------------------------------------------

export default function AppLayout({ children }: LayoutProps<"/">) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "anon") router.replace("/login");
  }, [status, router]);

  // THE FLASH OF UNKNOWN STATE, HANDLED DELIBERATELY.
  //
  // "Am I signed in" is a network round trip (GET /api/auth/me), so there is a
  // real moment where the answer is unknown. Rendering the app during it would
  // flash a dashboard at a stranger; rendering the login form would flash a
  // login form at someone already signed in. So we render THE FRAME AND
  // NOTHING ELSE: the correct background, the correct page structure, no
  // content, and no spinner.
  //
  // No spinner on purpose. A spinner communicates "this is taking a while";
  // this resolves in well under a second on localhost and the honest signal is
  // simply that the page has not finished arriving yet.
  if (status !== "authed") {
    return (
      <div className="bg-paper min-h-svh" aria-busy="true" aria-live="polite">
        <span className="sr-only">Checking your session</span>
      </div>
    );
  }

  // AiProvider sits INSIDE the auth gate, not outside it. Its probe is an
  // authenticated POST, so firing it before we know there is a session would
  // produce a guaranteed 401 — and that 401 would trip the global redirect
  // handler and bounce a signing-in user back to /login.
  // IntegrationsProvider wraps the bar AND the pages, because that is the only
  // way a change made on /integrations can reach the bar rendered above it.
  return (
    <AiProvider>
      <IntegrationsProvider>
        <div className="flex min-h-svh flex-col">
          <ReadoutBar />
          {children}
        </div>
      </IntegrationsProvider>
    </AiProvider>
  );
}
