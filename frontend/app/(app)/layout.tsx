"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ReadoutBar } from "@/components/readout-bar";
import { AiProvider } from "@/lib/ai-context";
import { IntegrationsProvider } from "@/lib/integrations-context";
import { useAuth } from "@/lib/auth-context";

// The protected shell. A route group, `(app)`, so /login and /register live outside it
// without appearing in the URL.
//
// THE REDIRECT BELOW IS UX, NOT SECURITY: requireAuth and requireSameOrigin run on the
// server and cannot be reached from a browser. This only stops a signed-out visitor
// staring at empty panels and failed requests.

export default function AppLayout({ children }: LayoutProps<"/">) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "anon") router.replace("/login");
  }, [status, router]);

  // There is a real moment where "am I signed in" is unknown. Rendering either answer
  // flashes the wrong screen at somebody, so we render the frame and nothing else - and
  // no spinner, because a spinner says "this is taking a while" and it is not.
  if (status !== "authed") {
    return (
      <div className="bg-paper min-h-svh" aria-busy="true" aria-live="polite">
        <span className="sr-only">Checking your session</span>
      </div>
    );
  }

  // AiProvider sits INSIDE the auth gate: its probe is an authenticated POST, so firing
  // it before we know there is a session would produce a guaranteed 401 - and that 401
  // would trip the global redirect and bounce a signing-in user back to /login.
  // IntegrationsProvider wraps the bar AND the pages, because that is the only way a
  // change made on /integrations can reach the bar rendered above it.
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
