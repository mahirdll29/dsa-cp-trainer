"use client";

import { createContext, useContext, useMemo, useReducer } from "react";

// "Something about the linked accounts changed" - a one-number broadcast.
//
// router.refresh() does nothing here: it refetches Server Components, and every fetch
// in this app runs in the browser because the auth cookie is host-only. So the panel
// that changed something calls changed(), and the bar refetches when the number moves.
//
// A counter rather than the status objects themselves, deliberately: sharing those
// would make this a small cache with two writers and a way to disagree. A counter
// carries no data, so there is nothing to get out of sync.

type IntegrationsContextValue = {
  version: number;
  changed: () => void;
};

const IntegrationsContext = createContext<IntegrationsContextValue>({
  version: 0,
  changed: () => {},
});

export function IntegrationsProvider({ children }: { children: React.ReactNode }) {
  const [version, changed] = useReducer((count: number) => count + 1, 0);
  const value = useMemo(() => ({ version, changed }), [version]);
  return (
    <IntegrationsContext.Provider value={value}>{children}</IntegrationsContext.Provider>
  );
}

export function useIntegrationsVersion(): IntegrationsContextValue {
  return useContext(IntegrationsContext);
}
