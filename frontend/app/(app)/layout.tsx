"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ReadoutBar } from "@/components/readout-bar";
import { AiProvider } from "@/lib/ai-context";
import { IntegrationsProvider } from "@/lib/integrations-context";
import { useAuth } from "@/lib/auth-context";

// The protected shell. A route group, `(app)`, so /login and /register live outside
// it without appearing in the URL.
//
// THE REDIRECT BELOW IS UX, NOT SECURITY. It protects nothing - anyone can delete it
// in devtools or call the API directly and get exactly the same result, because
// requireAuth and requireSameOrigin run on the server. It exists so a signed-out
// visitor sees a login form instead of three empty panels and a row of failed
// requests.

export default function AppLayout({ children }: LayoutProps<"/">) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "anon") router.replace("/login");
  }, [status, router]);

  // "Am I signed in" is a network round trip, so there is a real moment where the
  // answer is unknown. Rendering the app during it flashes a dashboard at a stranger;
  // rendering the login form flashes it at someone already signed in. So we render the
  // frame and nothing else - and no spinner, because this resolves in well under a
  // second and the honest signal is that the page has not finished arriving.
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
