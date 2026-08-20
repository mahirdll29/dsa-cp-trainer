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

// bcrypt's cost factor is an EXPONENT: cost 10 is 2^10 iterations, ~100 ms per hash,
// and each +1 doubles the work. The asymmetry is the point - a real login pays it
// once, an attacker brute-forcing a stolen database pays it per guess. It is also a
// denial-of-service surface, since anyone can trigger it unauthenticated.
const BCRYPT_COST = 10;

// A select allowlist: the password hash is never even fetched. Stronger than deleting
// the field after the fact, which leaves a window where the hash is in memory and can
// reach a log, an error reporter, or a future code path that forgets to strip it.
const PUBLIC_USER_FIELDS = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
};

// Deliberately simple. A fully RFC-5322-correct regex is thousands of characters and
// still accepts addresses no mail server would; the only real proof is sending mail.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Postgres unique constraints are case-SENSITIVE, so without this "Mahir@x.com" and
// "mahir@x.com" are two accounts. Applied on BOTH register and login, or someone who
// registers with one capitalisation cannot log in with another.
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { email, password, name } = req.body ?? {};

    // The typeof checks matter as much as the emptiness checks: req.body is parsed JSON,
    // so a caller can send {"email": 123} and a truthiness-only check would let a number
    // through to Prisma and produce a 500 instead of a 400.
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

    // Length is checked on the RAW password: spaces are legitimate characters.
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

      res.cookie(COOKIE_NAME, signToken(user.id), cookieOptions());
      return res.status(201).json({ user });
    } catch (error) {
      // No pre-check that the email is free, deliberately. findUnique-then-create is
      // read-then-write and two concurrent registrations can both read "not found" before
      // either writes; `await` yields the event loop, so single-threaded Node does not
      // close that window. Only the unique constraint is atomic, so P2002 is the guarantee
      // and this branch is just the friendly message.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return res.status(409).json({ error: "Email already registered" });
      }
      // Anything else is genuinely unexpected - re-throw rather than dressing it as a 409.
      throw error;
    }
  })
);

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

    // Both failure modes return a byte-identical 401. Distinguishable errors would turn
    // login into an account-existence oracle: feed it addresses, learn which are
    // registered, then phish or credential-stuff them.
    //
    // Known gap: the two paths differ in TIMING, because only this one runs bcrypt
    // (~100 ms). Accounts remain enumerable by stopwatch. Not fixed in v1.
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Strip the hash before responding - this is the one route where it is in memory.
    const { password: _passwordHash, ...publicUser } = user;

    res.cookie(COOKIE_NAME, signToken(user.id), cookieOptions());
    return res.json({ user: publicUser });
  })
);

router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, clearCookieOptions());

  // Deliberately NOT behind requireAuth: logout must work when the token is already
  // expired or malformed, which is exactly when a user most wants it. It only deletes
  // the caller's own cookie.
  //
  // The JWT itself stays valid until its exp - stateless auth holds no session record,
  // so there is nothing to invalidate.
  res.json({ message: "Logged out" });
});

router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Redundant in practice, but req.userId is typed optional because that is the honest
    // type. One cheap check beats a type that lies.
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    // A fresh database lookup rather than trusting token fields: the token is a snapshot
    // frozen for 7 days and answers only "who are you".
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: PUBLIC_USER_FIELDS,
    });

    if (!user) {
      // A validly signed token for a user who no longer exists - concrete proof of why the
      // fresh lookup matters. Clear the dead cookie on the way out.
      res.clearCookie(COOKIE_NAME, clearCookieOptions());
      return res.status(401).json({ error: "Not authenticated" });
    }

    return res.json({ user });
  })
);

export default router;
