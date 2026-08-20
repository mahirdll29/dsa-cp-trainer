"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

// One read with its loading and error state. Deliberately NOT a data library: no
// cache, no dedupe, no revalidate-on-focus, no retry. Background revalidation is
// actively unwanted here - a recommendation list that silently reshuffled would undo
// the engine's determinism guarantee.
//
// The error is kept as an ApiError rather than flattened to a string, because callers
// need the status: /integrations/*/status answers 404 for "nothing linked", which is
// a normal state and only the caller knows that.

export type Resource<T> = {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
  // Lets a caller write a mutation's result straight in instead of re-reading.
  set: (updater: (current: T | null) => T | null) => void;
};

// One state object, not three: the values are one fact, and separate useState calls
// let them drift - the classic bug is an error path that forgets to clear `loading`
// and leaves a skeleton on screen forever.
type State<T> = {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
};

// `refreshKey` lets a parent force a refetch. router.refresh() cannot do this job: it
// re-renders Server Components, and every fetch here runs in the browser, so there is
// no server render to invalidate.
export function useResource<T>(
  fetcher: () => Promise<T>,
  refreshKey: number = 0
): Resource<T> {
  const [state, setState] = useState<State<T>>({
    data: null,
    error: null,
    // Starts true, so nothing has to SET it true on mount - which is what keeps the
    // synchronous setState out of the effect below.
    loading: true,
  });
  const [nonce, setNonce] = useState(0);

  // Callers pass an inline arrow, so a new identity every render would refetch forever.
  // This effect MUST be declared before the fetch effect: effects run in declaration
  // order, so the ref is current by the time the fetch effect reads it.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    // Guards against a resolved promise writing into an unmounted component:
    // /api/recommendations takes 4.7-7.7 s, long enough to navigate away mid-flight.
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

  // `loading` is flipped back on here, in an event handler, to keep the effect free of
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
