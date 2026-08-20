import { CookieOptions } from "express";
import jwt from "jsonwebtoken";
import { isProduction, JWT_SECRET } from "./env";
export const COOKIE_NAME = "token";

// One source of truth: the token's expiry and the cookie's maxAge must agree, or the
// user is either silently logged out or logged-in-looking while every request 401s.
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export function signToken(userId: string): string {
  // ONLY userId: signed is not encrypted, so no secret goes in. It is also frozen for
  // 7 days, which is why /me re-reads the database rather than trusting token fields.
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
}

export function cookieOptions(): CookieOptions {
  return {
    // JavaScript cannot read this cookie. Stops an XSS payload exfiltrating the token;
    // it does not stop that payload USING the session from inside the page.
    httpOnly: true,

    // These two MUST flip together: browsers reject SameSite=None without Secure, so
    // `none` alone means the cookie is silently never stored.
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
