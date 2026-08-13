import bcrypt from "bcrypt";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../lib/asyncHandler";
import {
  clearCookieOptions,
  cookieOptions,
  COOKIE_NAME,
  signToken,
} from "../lib/auth";
import prisma from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

// bcrypt's cost factor is an EXPONENT: the algorithm runs 2^cost iterations.
// Cost 10 = 1,024 iterations ~ 100ms per hash. Each +1 DOUBLES the work, so
// 10 -> 14 is 16x slower, not 40% slower.
//
// The asymmetry is the point. A real login pays 100ms once and nobody notices.
// An attacker brute-forcing a stolen database pays it PER GUESS, so instead of
// the ~10 billion guesses/second a GPU manages against a fast hash like
// SHA-256, they get roughly 10 per second per core.
//
// Honest cost: 100ms of CPU per login attempt is also a denial-of-service
// surface, since anyone can trigger it unauthenticated. Rate limiting is the
// normal answer and is explicitly out of scope for v1 — recorded as a known gap.
const BCRYPT_COST = 10;

// Prisma SELECT ALLOWLIST — the password hash is never even fetched.
//
// Stronger than fetching the row and deleting the field afterwards, because
// that leaves a window where the hash is in memory: it can be logged by a
// stray console.log of the raw object, captured by an error reporter, or
// forgotten entirely on some future code path. Here it never leaves Postgres.
const PUBLIC_USER_FIELDS = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
};

// Deliberately simple. Fully validating an email address per RFC 5322 is a
// famous rabbit hole (the "correct" regex is thousands of characters and still
// accepts things no mail server would), and it buys nothing: the only real
// proof an address works is sending mail to it, which v1 does not do. This
// catches typos and obvious garbage, which is all it is for.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Trim and lowercase, applied on BOTH register and login.
//
// Postgres unique constraints are case-SENSITIVE, so without this
// "Mahir@x.com" and "mahir@x.com" would be two separate accounts. It has to be
// applied to both routes or someone who registers with one capitalisation
// cannot log in with another.
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { email, password, name } = req.body ?? {};

    // Hand-written validation, no Zod. Each failure names its specific problem
    // so the client can show something useful. The typeof checks matter as much
    // as the emptiness checks: req.body is parsed JSON, so a caller can send
    // `{"email": 123}` or `{"email": null}` and these fields are `unknown` in
    // practice — checking only for truthiness would let a number through to
    // Prisma and produce a 500 instead of a 400.
    if (typeof email !== "string" || email.trim() === "") {
      return res.status(400).json({ error: "Email is required" });
    }
    if (typeof password !== "string" || password.trim() === "") {
      return res.status(400).json({ error: "Password is required" });
    }
    if (typeof name !== "string" || name.trim() === "") {
      return res.status(400).json({ error: "Name is required" });
    }

    const normalizedEmail = normalizeEmail(email);
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      return res.status(400).json({ error: "Email format is invalid" });
    }

    // Length is checked on the RAW password, not the trimmed one — spaces are
    // legitimate password characters and must count.
    if (password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters" });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    try {
      const user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          password: passwordHash,
          name: name.trim(),
        },
        select: PUBLIC_USER_FIELDS,
      });

      // Registering logs you in — no separate login round trip.
      res.cookie(COOKIE_NAME, signToken(user.id), cookieOptions());
      return res.status(201).json({ user });
    } catch (error) {
      // NO PRE-CHECK FOR AN EXISTING EMAIL, deliberately.
      //
      // A findUnique-then-create pattern is read-then-write, and two concurrent
      // registrations for the same address can both read "not found" before
      // either writes. Node being single-threaded does not help: the `await` on
      // the read yields the event loop, which is exactly when the other request
      // runs its own check. The pre-check narrows the race window; it does not
      // close it. Only the database's unique constraint is atomic, so only the
      // database constraint is authoritative.
      //
      // P2002 IS one of the codes Prisma maps (see architecture.md 2.5, where
      // Module 1 found that onDelete: Restrict violations raise PostgreSQL
      // 23001 and get NO P-code at all). Unique violations are the well-mapped
      // case, so branching on error.code is safe *here* specifically.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return res.status(409).json({ error: "Email already registered" });
      }
      // Anything else is genuinely unexpected — re-throw so asyncHandler routes
      // it to the error handler as a 500 rather than swallowing it as a 409.
      throw error;
    }
  })
);

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body ?? {};

    if (typeof email !== "string" || email.trim() === "") {
      return res.status(400).json({ error: "Email is required" });
    }
    if (typeof password !== "string" || password === "") {
      return res.status(400).json({ error: "Password is required" });
    }

    // The ONE place the hash is read. This row never becomes the response.
    const user = await prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      select: { ...PUBLIC_USER_FIELDS, password: true },
    });

    // BOTH failure modes below return a byte-identical 401.
    //
    // If "no such user" and "wrong password" were distinguishable, the login
    // endpoint would become an account-existence oracle: an attacker feeds it a
    // list of addresses and learns which ones are registered. That list is
    // worth money — it powers targeted phishing and credential stuffing
    // (trying passwords leaked from other breaches against accounts known to
    // exist here). Same status code, same body, no exceptions.
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // KNOWN GAP, recorded rather than fixed: the two paths are identical in
    // content but not in TIMING. The no-such-user path returns immediately,
    // while the wrong-password path first runs bcrypt.compare (~100ms). That
    // difference is measurable over a few requests, so a determined attacker
    // can still enumerate accounts by stopwatch. The standard fix is to compare
    // against a dummy hash when the user is missing, so both paths burn the
    // same time. Deliberately not implemented in v1.

    // Strip the hash before responding. Login is the one route where the field
    // is in memory at all, which is exactly why the removal is explicit here.
    const { password: _passwordHash, ...publicUser } = user;

    res.cookie(COOKIE_NAME, signToken(user.id), cookieOptions());
    return res.json({ user: publicUser });
  })
);

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
//
// Deliberately NOT behind requireAuth. Logging out must work even when the
// token is already expired or malformed — otherwise a user holding a broken
// cookie could never clear it, which is the exact situation where they most
// want to. There is nothing to protect: the only effect is deleting the
// caller's own cookie.
router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, clearCookieOptions());

  // THE REVOCATION TRADEOFF, stated plainly: this deletes the cookie from the
  // browser, but the JWT itself stays cryptographically valid until its exp.
  // If someone copied the token before logout, it keeps working for up to 7
  // days and we have no way to stop it. That is the price of stateless auth —
  // the server holds no session record, so there is nothing to invalidate.
  // Accepted for v1; the fixes (short tokens + refresh, a denylist, or a
  // tokenVersion column) all reintroduce server state.
  res.json({ message: "Logged out" });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Redundant in practice — requireAuth guarantees userId is set or the
    // handler never runs. It exists because req.userId is typed optional, which
    // is the honest type (see types/express.d.ts). One cheap check is a better
    // trade than a type that lies.
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // FRESH DATABASE LOOKUP rather than returning fields from the token.
    //
    // The token is a snapshot frozen when it was issued, valid for 7 days. A
    // name changed yesterday, or a role revoked an hour ago, would not be
    // reflected in it. The token's job is to answer "who are you" — that one
    // fact is stable for its lifetime. Everything else must come from the
    // database, which is the only thing that is current.
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: PUBLIC_USER_FIELDS,
    });

    if (!user) {
      // Validly signed token for a user who no longer exists — a deleted
      // account whose 7-day token is still in flight. Concrete proof of why
      // the fresh lookup matters: trusting the token alone would serve data
      // for a user that is gone. Clear the dead cookie on the way out.
      res.clearCookie(COOKIE_NAME, clearCookieOptions());
      return res.status(401).json({ error: "Not authenticated" });
    }

    return res.json({ user });
  })
);

export default router;
