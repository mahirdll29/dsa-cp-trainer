"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

// ---------------------------------------------------------------------------
// One read, with its loading and error state.
//
// WHY THIS EXISTS AND WHY IT IS NOT A DATA LIBRARY. Five call sites need the
// identical three-line dance — set loading, await, set data or set error — and
// writing it five times guarantees that one of them eventually forgets to clear
// `loading` on the error path and hangs a skeleton forever.
//
// What it deliberately does NOT do: cache, deduplicate, revalidate on focus,
// retry, or share state between components. Those are the features that justify
// TanStack Query or SWR, and this app wants none of them — its two expensive
// reads are triggered by explicit user action (a sync, a review) and a
// background refetch would be actively wrong, because a recommendation list
// that silently reshuffled would undo the engine's determinism guarantee.
//
// THE ERROR IS KEPT AS AN ApiError, NOT FLATTENED TO A STRING. Callers need the
// status code: /integrations/*/status answers 404 for "nothing linked", which
// is a NORMAL STATE and not a failure, and only the caller knows that.
// ---------------------------------------------------------------------------

export type Resource<T> = {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
  // Lets a caller write the result of a mutation straight into the resource
  // instead of re-reading. Used by "Mark reviewed", where the POST already
  // returns the updated item and a refetch would cost another round trip to
  // learn something we were just told.
  set: (updater: (current: T | null) => T | null) => void;
};

// ONE STATE OBJECT, NOT THREE.
//
// Held together because the three values are one fact — a request is loading,
// or it produced data, or it produced an error, and never two of those at once.
// Three separate useState calls let those drift (the classic bug is an error
// path that forgets to clear `loading`, leaving a skeleton on screen forever)
// AND they force multiple setState calls per transition, which React 19's
// compiler rules correctly flag as cascading renders.
type State<T> = {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
};

// `refreshKey` lets a PARENT force a refetch by changing a number, which is how
// the readout bar learns that the integrations page linked or unlinked an
// account. `router.refresh()` cannot do this job: it re-renders Server
// Components, and every fetch in this app happens in the browser (host-only
// cookie — see lib/auth-context.tsx), so there is no server render to
// invalidate. Caught in verification, where the bar kept reporting "not linked"
// on a page that had just linked something.
export function useResource<T>(
  fetcher: () => Promise<T>,
  refreshKey: number = 0
): Resource<T> {
  const [state, setState] = useState<State<T>>({
    data: null,
    error: null,
    // Starts true. Nothing has to SET it true on mount, which is what removes
    // the synchronous setState from the effect below — the effect now only ever
    // writes from an async callback, once, when the request settles.
    loading: true,
  });
  const [nonce, setNonce] = useState(0);

  // THE LATEST-REF PATTERN, and the assignment lives in an effect rather than
  // in the render body.
  //
  // Callers pass an inline arrow — `useResource(() => api("/api/mastery"))` —
  // which is a brand-new function identity on every render. Put that in the
  // fetch effect's dependency array and it refetches forever. Holding it in a
  // ref breaks that loop without pushing a useCallback onto every call site.
  //
  // This effect is declared BEFORE the fetch effect on purpose: effects run in
  // declaration order after each commit, so the ref is always current by the
  // time the fetch effect reads it.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    // GUARDS AGAINST A RESOLVED PROMISE WRITING INTO AN UNMOUNTED COMPONENT.
    // GET /api/recommendations takes 4.7-7.7 seconds on a real account, which
    // is more than long enough for someone to navigate away mid-flight.
    let live = true;

    fetcherRef
      .current()
      .then((result) => {
        if (live) setState({ data: result, error: null, loading: false });
      })
      .catch((caught: unknown) => {
        if (!live) return;
        setState({
          data: null,
          error: caught instanceof Error ? caught : new Error("Request failed"),
          loading: false,
        });
      });

    return () => {
      live = false;
    };
  }, [nonce, refreshKey]);

  // `loading` is flipped back on HERE, in an event handler, rather than at the
  // top of the effect. Same visible behaviour, and it keeps the effect free of
  // a synchronous state write.
  const reload = useCallback(() => {
    setState((current) => ({ ...current, loading: true, error: null }));
    setNonce((value) => value + 1);
  }, []);

  const set = useCallback(
    (updater: (current: T | null) => T | null) =>
      setState((current) => ({ ...current, data: updater(current.data) })),
    []
  );

  return { ...state, reload, set };
}
