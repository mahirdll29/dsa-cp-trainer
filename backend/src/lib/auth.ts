import { CookieOptions } from "express";
import jwt from "jsonwebtoken";
import { isProduction, JWT_SECRET } from "./env";

// Shared by register, login, logout and requireAuth — four callers, which is
// what justifies this being its own module rather than inline in the route file.

export const COOKIE_NAME = "token";

// ONE source of truth for the lifetime, in seconds.
//
// The token's expiry and the cookie's maxAge MUST agree, and deriving both from
// this single constant makes that structural rather than a convention someone
// has to remember. What goes wrong when they disagree:
//
//   cookie OUTLIVES token - the browser keeps sending a dead token. The user
//     looks logged in (the cookie is right there) but every request 401s. The
//     confusing failure.
//   token OUTLIVES cookie - the browser drops the cookie and the user is
//     silently logged out while a perfectly valid token still exists. Less
//     harmful, still baffling to debug.
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export function signToken(userId: string): string {
  // The payload carries ONLY userId. jsonwebtoken adds iat and exp itself.
  //
  // Nothing else belongs here for two reasons:
  //  1. Signed is not encrypted. The payload is base64url — anyone holding the
  //     token can read it. The signature proves we issued it and that nobody
  //     edited it; it does not hide it.
  //  2. It is a snapshot frozen for 7 days. If we embedded a role and later
  //     demoted the user, their existing token would keep asserting the old
  //     role until it expired. That is why /me re-reads the database: the token
  //     answers "who are you", the database answers "what are you now".
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

export function cookieOptions(): CookieOptions {
  return {
    // JavaScript cannot read this cookie — document.cookie will not show it.
    // This is the XSS mitigation: a malicious script cannot exfiltrate the
    // token. (It can still MAKE requests from the page, which is a different
    // problem this does not solve.)
    httpOnly: true,

    // secure and sameSite MUST flip together. Browsers reject SameSite=None
    // outright unless Secure is also set, so `none` without `secure` means the
    // cookie is silently never stored at all.
    //
    // dev:  frontend localhost:3000 -> backend localhost:5000. Different ports
    //       are still the SAME SITE (port is not part of "site"), so `lax`
    //       works and `secure` would break it, because localhost is plain HTTP.
    // prod: frontend on Vercel -> backend on Railway. Genuinely different
    //       sites, so the cookie must be `none` + `secure` to be sent at all.
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",

    // express takes milliseconds; our constant is seconds.
    maxAge: TOKEN_TTL_SECONDS * 1000,

    path: "/",
  };
}

// The SAME attributes the cookie was set with, MINUS maxAge.
//
// Why the attributes must match: a browser will only replace a cookie when the
// name, domain and path line up, and it will reject the replacement outright if
// the attribute combination is invalid (SameSite=None without Secure). Get them
// wrong and clearCookie appears to succeed while the old cookie sits there
// untouched — the user stays logged in.
//
// Why maxAge must be ABSENT: express's clearCookie works by setting `expires`
// to a date in the past. But res.cookie overwrites `expires` whenever `maxAge`
// is present. Passing maxAge would therefore re-issue a LIVE 7-day cookie —
// the exact opposite of logging out.
export function clearCookieOptions(): CookieOptions {
  const { maxAge: _maxAge, ...attributesWithoutMaxAge } = cookieOptions();
  return attributesWithoutMaxAge;
}
