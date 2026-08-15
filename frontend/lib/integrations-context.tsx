"use client";

import { createContext, useContext, useMemo, useReducer } from "react";

// ---------------------------------------------------------------------------
// "SOMETHING ABOUT THE LINKED ACCOUNTS CHANGED" — a one-number broadcast.
//
// THE BUG THIS FIXES, found in verification: link a Codeforces account on
// /integrations and the readout bar at the top of every page keeps saying "CF
// not linked" until a full reload.
//
// The instinctive fix is `router.refresh()`, and it does nothing here. That API
// re-renders SERVER Components and refetches their data. Every fetch in this
// app happens in the BROWSER, because the auth cookie is host-only and the Next
// server can never see it (lib/auth-context.tsx). There is no server render to
// invalidate, so `router.refresh()` is a no-op against client state — a
// genuinely useful reminder that the host-only-cookie decision has consequences
// well beyond the auth code itself.
//
// So the two components have to be connected explicitly. The panel that changed
// something calls `changed()`; the bar passes `version` into its `useResource`
// and refetches when the number moves.
//
// A COUNTER RATHER THAN THE STATUS ITSELF, deliberately. Sharing the actual
// IntegrationStatus objects would make this a small cache: two writers, a
// merge, and a way for the bar and the panel to disagree about the same
// account. A counter carries no data, so there is nothing to get out of sync —
// it only says "re-read", and the server stays the single source of truth.
// ---------------------------------------------------------------------------

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
