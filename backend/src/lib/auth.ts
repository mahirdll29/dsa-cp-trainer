import { CookieOptions } from "express";
import jwt from "jsonwebtoken";
import { isProduction, JWT_SECRET } from "./env";
export const COOKIE_NAME = "token";

// ONE source of truth for the lifetime. The token's expiry and the cookie's maxAge
// MUST agree: if the cookie outlives the token the user looks logged in while every
// request 401s; if the token outlives the cookie they are silently logged out while a
// valid token still exists.
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export function signToken(userId: string): string {
  // ONLY userId. Signed is not encrypted - the payload is base64url and readable by
  // anyone holding the token - so no secret goes in. It is also a snapshot frozen for
  // 7 days, which is why /me re-reads the database: the token answers who you are, the
  // database answers what you are now.
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

export function cookieOptions(): CookieOptions {
  return {
    // JavaScript cannot read this cookie. Stops an XSS payload exfiltrating the token;
    // it does not stop that payload USING the session from inside the page.
    httpOnly: true,

    // secure and sameSite MUST flip together. Browsers reject SameSite=None unless Secure
    // is also set, so `none` without `secure` means the cookie is silently never stored.
    // Dev is localhost:3000 -> :5000, which is the same site (port is not part of "site"),
    // so lax works and secure would break it. Prod is genuinely cross-site.
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",

    // express takes milliseconds; our constant is seconds.
    maxAge: TOKEN_TTL_SECONDS * 1000,

    path: "/",
  };
}

// The same attributes MINUS maxAge. The attributes must match or the browser will not
// replace the cookie. maxAge must be ABSENT because clearCookie works by setting
// `expires` to the past, and res.cookie overwrites `expires` whenever maxAge is
// present - passing it would re-issue a live 7-day cookie.
export function clearCookieOptions(): CookieOptions {
  const { maxAge: _maxAge, ...attributesWithoutMaxAge } = cookieOptions();
  return attributesWithoutMaxAge;
}
