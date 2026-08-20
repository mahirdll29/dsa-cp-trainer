// The one place this app talks to the backend, so credentials:"include" is written
// once and cannot be forgotten. Omitting it does not throw or warn - the browser just
// declines to attach the cookie, and the symptom looks like an auth bug.

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    // Surfaced rather than retried: Groq's binding limit is tokens per minute, so an
    // automatic retry spends budget that has already run out.
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// The global session-expiry hook. A module-level callback rather than context,
// because api() is a plain function called from event handlers and cannot read one.
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

type ApiOptions = {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  // Opt out of the global 401 redirect. Exactly one caller uses it - see ME_OPTIONS.
  silent401?: boolean;
};

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, silent401 = false } = options;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    // ↓↓↓ WRITTEN ONCE, PROJECT-WIDE ↓↓↓
    credentials: "include",
    // Content-Type only when there is a body: sending it on a GET makes the request
    // non-simple and forces a CORS preflight before every read.
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // No Origin header is set here, deliberately: the browser sets it and will not let
  // page JavaScript override it, which is exactly why the backend can trust it as a
  // CSRF defence.

  // Parse first, branch on status second: every backend error carries a useful
  // { error } body, and throwing before reading it would discard the one thing worth
  // showing the user.
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

// GET /api/auth/me MUST bypass the redirect: its 401 is the expected answer for a
// signed-out visitor, and routing it through the handler loops /login with itself.
export const ME_OPTIONS: ApiOptions = { silent401: true };
