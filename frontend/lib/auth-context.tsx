"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ME_OPTIONS, setUnauthorizedHandler } from "./api";
import type { User } from "./types";

// ---------------------------------------------------------------------------
// AUTH STATE — a three-state machine, and no auth library.
//
// WHY AUTHENTICATED DATA IS FETCHED IN THE BROWSER, WHICH IS THE WHOLE REASON
// THIS FILE IS "use client":
//
// The backend sets its `token` cookie on ITS OWN ORIGIN (localhost:5000 in dev)
// with no Domain attribute, which makes it a HOST-ONLY cookie. The browser will
// not send it to localhost:3000, and the Next.js server process — a different
// machine entirely in production — has no access to it at all. So a Server
// Component cannot read it, and a Route Handler cannot forward it.
//
// That is not a limitation of Next.js; it is what host-only means. The
// consequence is architectural and it is the same in production (Vercel ->
// Railway, SameSite=None + Secure): EVERY AUTHENTICATED REQUEST IS MADE FROM
// THE BROWSER. No SSR of protected data anywhere in this app.
//
// WHY THREE STATES AND NOT A BOOLEAN. There is no way to read an httpOnly
// cookie from JavaScript — that is the entire point of httpOnly — so "am I
// logged in" is not a value we hold, it is a QUESTION WE ASK: does GET
// /api/auth/me return 200? Asking takes a network round trip, so there is a
// real window where the answer is genuinely unknown. A boolean would have to
// lie during that window (defaulting to false flashes the login screen at a
// logged-in user; defaulting to true flashes the app at a stranger). Modelling
// it as `loading` lets every consumer render a deliberate third thing.
// ---------------------------------------------------------------------------

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

// CONTEXT IS SUFFICIENT HERE, and naming why is the point of this comment.
// The shared state is one user object, read by four components and written by
// exactly three events (sign in, register, sign out). There is no server-cache
// invalidation, no optimistic mutation graph, no cross-page subscription. A
// state library would add a dependency, a provider, and a set of concepts to
// explain, in exchange for solving problems this app does not have.
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading", user: null });
  const router = useRouter();

  // THE PROBE, run once on mount. Arriving fresh and arriving after a reload
  // are the same code path: we ask the server who we are.
  //
  // Note ME_OPTIONS — a 401 here must NOT trigger the global redirect, or
  // /login enters a loop with itself.
  //
  // Written as .then/.catch rather than an awaited helper so the only state
  // write happens inside an async callback. An effect body that calls setState
  // synchronously causes a cascading render, and React 19's compiler rules
  // flag it; here there is nothing to write until the request settles anyway.
  useEffect(() => {
    let live = true;

    api<{ user: User }>("/api/auth/me", ME_OPTIONS)
      .then(({ user }) => {
        if (live) setState({ status: "authed", user });
      })
      .catch(() => {
        // Any failure — 401, a network error, the backend being down —
        // resolves to "not signed in". That is the honest reading: we could
        // not establish a session, so we do not have one. A fourth "error"
        // state would need its own screen and would tell the user nothing they
        // could act on that the login page does not already tell them.
        if (live) setState({ status: "anon", user: null });
      });

    return () => {
      live = false;
    };
  }, []);

  // THE GLOBAL 401 HANDLER, registered once at the top of the tree.
  //
  // A token expires after 7 days and can be invalidated by the user record
  // being deleted, so a session can end mid-visit with the app already
  // rendered. Without this, the next click would surface a raw error on an
  // otherwise-normal page. With it, any 401 from any call drops straight to the
  // login screen.
  //
  // TO BE CLEAR ABOUT WHAT THIS IS: **this is UX, not security.** Nothing here
  // protects any data. The backend's requireAuth middleware rejects every
  // unauthenticated request whether or not this handler exists, and someone who
  // disables JavaScript or edits the bundle gets exactly the same 401s. The
  // enforcement is on the server; this only stops a logged-out user staring at
  // a broken screen.
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

  // Registering signs you in — the backend sets the cookie on 201, so there is
  // no second login step to perform and none to fail.
  const register = useCallback(async (name: string, email: string, password: string) => {
    const { user } = await api<{ user: User }>("/api/auth/register", {
      method: "POST",
      body: { name, email, password },
    });
    setState({ status: "authed", user });
  }, []);

  const signOut = useCallback(async () => {
    // POST /api/auth/logout is deliberately NOT behind requireAuth on the
    // backend, so this works even when the token is already expired or
    // malformed — which is exactly when a user most wants it to.
    //
    // The state is cleared whether or not the call succeeds. If the network is
    // down we cannot clear the server's cookie, but leaving the user looking
    // signed in after they asked to leave is the worse of the two outcomes.
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
  // Throwing rather than returning a default: a component reading auth outside
  // the provider is a wiring mistake, and a silent `{ status: "anon" }` would
  // render a plausible logged-out screen instead of reporting it.
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}
