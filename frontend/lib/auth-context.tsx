"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ME_OPTIONS, setUnauthorizedHandler } from "./api";
import type { User } from "./types";

// Authenticated data is fetched IN THE BROWSER, and that is forced rather than
// chosen: the backend sets its cookie on its own origin with no Domain attribute,
// making it HOST-ONLY. The Next.js server process cannot see it, so no Server
// Component can read it and no Route Handler can forward it. There is no SSR of
// protected data anywhere in this app.
//
// Three states, not a boolean: "am I logged in" is not a value we hold but a question
// we ask, and the round trip means there is a real window where the answer is
// unknown. A boolean would have to lie during it - false flashes the login screen at
// a signed-in user, true flashes the app at a stranger.

export type AuthState =
  | { status: "loading"; user: null }
  | { status: "authed"; user: User }
  | { status: "anon"; user: null };

type AuthContextValue = AuthState & {
  signIn: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

// Context is sufficient: one user object, read by four components, written by three
// events. No server-cache invalidation and no optimistic mutation graph to manage.
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading", user: null });
  const router = useRouter();

  // The probe, once on mount. Written as .then/.catch so the only state write happens
  // inside an async callback - a synchronous setState in an effect body causes a
  // cascading render, which React 19's compiler rules flag.
  //
  // Note ME_OPTIONS: a 401 here must NOT trigger the global redirect.
  useEffect(() => {
    let live = true;

    api<{ user: User }>("/api/auth/me", ME_OPTIONS)
      .then(({ user }) => {
        if (live) setState({ status: "authed", user });
      })
      .catch(() => {
        // Any failure - 401, network error, backend down - resolves to "not signed in". A
        // fourth error state would need its own screen and tell the user nothing actionable.
        if (live) setState({ status: "anon", user: null });
      });

    return () => {
      live = false;
    };
  }, []);

  // The global 401 handler, registered once at the top of the tree, so a session that
  // ends mid-visit drops to the login screen instead of surfacing a raw error.
  //
  // THIS IS UX, NOT SECURITY. It protects nothing: the backend rejects every
  // unauthenticated request whether or not this exists, and someone who edits the
  // bundle gets exactly the same 401s.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setState({ status: "anon", user: null });
      router.replace("/login");
    });
    return () => setUnauthorizedHandler(null);
  }, [router]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { user } = await api<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    setState({ status: "authed", user });
  }, []);

  // Registering signs you in: the backend sets the cookie on 201.
  const register = useCallback(async (name: string, email: string, password: string) => {
    const { user } = await api<{ user: User }>("/api/auth/register", {
      method: "POST",
      body: { name, email, password },
    });
    setState({ status: "authed", user });
  }, []);

  const signOut = useCallback(async () => {
    // Deliberately NOT behind requireAuth on the backend, so this works even when the
    // token is already expired. State is cleared whether or not the call succeeds -
    // leaving the user looking signed in after they asked to leave is the worse outcome.
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      setState({ status: "anon", user: null });
    }
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, signIn, register, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  // Throwing rather than defaulting: a component reading auth outside the provider is a
  // wiring mistake, and a silent anon state would render a plausible logged-out screen.
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
