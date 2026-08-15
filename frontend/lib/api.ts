// ---------------------------------------------------------------------------
// THE ONE PLACE THIS APP TALKS TO THE BACKEND.
//
// Same rule the backend applies to Codeforces, LeetCode and Groq — every call
// to an external system lives in one module, so a break or a swap touches one
// file. Here it buys something more specific as well: `credentials: "include"`
// is written exactly once and therefore cannot be forgotten on call number
// twelve.
//
// WHY THAT MATTERS MORE THAN IT SOUNDS. Omitting `credentials: "include"` does
// not throw, does not warn, and does not fail. The browser simply declines to
// attach the cookie, the request arrives unauthenticated, and the backend
// answers 401 — so the symptom is "I am logged in but the app says I am not",
// which looks like an auth bug and is actually a fetch bug. It is documented in
// docs/auth-interview-prep.md 2.5 as the most common failure in this stack. A
// wrapper turns "remember this on every call" into "it is structurally true".
//
// It pairs with `cors({ credentials: true })` in the backend's app.ts. BOTH
// sides are required: permission to read the response and permission to send
// the cookie are two separate grants.
// ---------------------------------------------------------------------------

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    // Propagated from the backend's `Retry-After` header on a 429. The AI
    // routes set it in seconds; we surface it rather than retrying, because
    // Groq's binding limit is tokens per minute and an automatic retry spends
    // budget that is already gone.
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// The global session-expiry hook. AuthProvider registers itself here on mount
// so that a 401 from ANY call — not just the ones a page remembered to handle —
// drops the user back to the login screen.
//
// A module-level callback rather than a React context because `api()` is a
// plain function called from event handlers and effects, not a hook, and cannot
// read context. One registration, set once, at the top of the tree.
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

type ApiOptions = {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  // Opt out of the global 401 redirect. Exactly one caller uses this, and the
  // reason is important enough to be a named option rather than a special case
  // buried in a condition — see the comment on the constant below.
  silent401?: boolean;
};

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, silent401 = false } = options;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    // ↓↓↓ WRITTEN ONCE, PROJECT-WIDE ↓↓↓
    credentials: "include",
    // The Content-Type header is set ONLY when there is a body. Sending it on a
    // GET would make the request non-simple and force the browser into a CORS
    // preflight — an extra OPTIONS round trip before every single read, for a
    // header describing a body that does not exist.
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // NOTE WHAT IS *NOT* HERE: an Origin header. The browser sets it itself and
  // will not let page JavaScript override it — which is precisely why the
  // backend's requireSameOrigin middleware can trust it as a CSRF defence. From
  // a real frontend that check is invisible and passes for free, provided this
  // app is served from exactly the origin in the backend's FRONTEND_URL.

  // Parse first, branch on status second. Every backend error in this project
  // carries a useful JSON body (`{ "error": "..." }`), and `if (!response.ok)
  // throw` before reading it would discard the one piece of information worth
  // showing the user. That is the same trap the Codeforces client documents in
  // reverse — a good body behind a bad status.
  const data = await response.json().catch(() => ({}) as Record<string, unknown>);

  if (response.status === 401 && !silent401) {
    onUnauthorized?.();
  }

  if (!response.ok) {
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ApiError(
      response.status,
      typeof (data as { error?: unknown }).error === "string"
        ? ((data as { error: string }).error)
        : "Something went wrong",
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
    );
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// THE ONE ENDPOINT THAT MUST NOT TRIGGER THE REDIRECT.
//
// GET /api/auth/me answers the question "am I logged in", and its 401 is the
// EXPECTED ANSWER for a logged-out visitor — not an expired session. Routing it
// through onUnauthorized would mean: land on /login, AuthProvider probes /me,
// /me returns 401, the handler redirects to /login, which mounts AuthProvider,
// which probes /me... a redirect loop on the app's most-visited page.
//
// This is the subtlest trap in the module, which is why the exemption is a
// named constant used by one caller rather than a boolean passed at the call
// site and forgotten about.
// ---------------------------------------------------------------------------
export const ME_OPTIONS: ApiOptions = { silent401: true };
