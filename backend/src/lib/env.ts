// Environment access in one place.
//
// The helper's RETURN TYPE is `string` rather than a guarded module-scope constant,
// because TypeScript resets control-flow narrowing for variables captured in
// closures: a module-scope `if (!secret) throw` would still leave every function
// below seeing `string | undefined` and inviting an `as string` cast.
//
// This module reads process.env at import time, so it must only ever be reached after
// dotenv has run - which holds because server.ts imports "dotenv/config" first.

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

// Throws at startup rather than defaulting. A fallback secret would be a value
// present in our source, so anyone could forge a token for any userId - silent and
// total. A server that cannot do auth correctly should not accept traffic.
export const JWT_SECRET = requireEnv("JWT_SECRET");

// Deliberately NOT requireEnv: an unset NODE_ENV should mean development, not a crash.
export const isProduction = process.env.NODE_ENV === "production";
