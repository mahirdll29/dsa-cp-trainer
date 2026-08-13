// Environment access, in one place.
//
// THE TYPING PROBLEM this solves:
// process.env values are typed `string | undefined`. The obvious guard —
//
//     const secret = process.env.JWT_SECRET;
//     if (!secret) throw new Error("...");
//
// narrows `secret` to string for the rest of the module body, but that
// narrowing does NOT reliably survive into function bodies declared below it:
// TypeScript resets control-flow narrowing for variables captured inside
// closures, because it cannot prove when the closure will actually run. So
// every function using it would still see `string | undefined` and you would be
// tempted to write `as string` — a cast that silences the checker without
// making anything safer.
//
// The fix without any cast: a helper whose RETURN TYPE is `string`. There is
// then nothing to narrow anywhere — the exported constant is simply a string,
// everywhere, forever.
//
// NOTE ON IMPORT ORDER: this module reads process.env at import time, so it
// must only ever be imported after dotenv has run. That holds because
// server.ts imports "dotenv/config" before it imports ./app, and everything
// here is reached through ./app.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy backend/.env.example to backend/.env and fill it in.`
    );
  }
  return value;
}

// WHY THIS THROWS AT STARTUP RATHER THAN DEFAULTING:
// Auth is not something the app can be partially correct about. If JWT_SECRET
// were missing and we fell back to some default string, the app would keep
// running and every token would be signed with a value that is in our source
// code — meaning anyone could forge a token for any userId and impersonate any
// user. That failure is silent and total.
//
// Throwing here kills the process during startup, before it ever accepts a
// request, instead of failing at the first login. A server that cannot do auth
// correctly should not be answering traffic at all: failing fast beats running
// wrong.
export const JWT_SECRET = requireEnv("JWT_SECRET");

// Drives the cookie's `secure` and `sameSite` attributes. Deliberately NOT
// requireEnv — an unset NODE_ENV should mean "development", not a crash.
export const isProduction = process.env.NODE_ENV === "production";
