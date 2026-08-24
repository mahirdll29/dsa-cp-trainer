# DSA/CP Trainer

`v2.0` · [Live app](https://dsa-cp-trainer.vercel.app)

Pulls your solve history from LeetCode and Codeforces, works out which topics you're actually weak
at, and tells you what to do next. Weak topics first, at a difficulty just above where you're
comfortable, with spaced repetition for things you've already solved.

The part that picks problems is ordinary arithmetic and rules. No model is involved in choosing,
ranking or filtering anything, so the same inputs always give the same output. There is an LLM in
here, but it only writes hints and explanations on top of decisions that were already made.

## Features

- Link a Codeforces handle or a LeetCode username and import your submission history
- Per-topic mastery scores derived from what you've solved and what you've only attempted
- A ranked list of what to solve next, each item carrying the reason it was picked
- Spaced repetition on solved problems (1, 3, 7, 14, 30 day ladder)
- Timed practice sessions where hints unlock on a clock instead of on demand
- Paste a problem URL and get problems built on the same ideas
- Mastery charts over time, solve streaks and topic breakthroughs
- Contest mode: timed sets at a fixed difficulty spread

## Tech stack

| Layer | What |
|---|---|
| Backend | Node.js, Express 4, TypeScript |
| Database | PostgreSQL (Neon) + Prisma |
| Auth | JWT in an HTTP-only cookie, bcrypt |
| AI | Groq, JSON mode |
| Data sources | Codeforces API (official), LeetCode via the alfa-leetcode-api community wrapper |
| Frontend | Next.js 16 (App Router), React 19, Tailwind v4, shadcn/ui, motion |
| Hosting | Vercel (frontend), Render (backend) |

14 tables, 6 enums. Problems carry two difficulty columns: `difficultyRaw` is whatever the provider
said, `difficultyBand` is a normalized EASY/MEDIUM/HARD that the engine uses. The two providers'
rating scales are never mapped onto each other.

## How the engine picks problems

Mastery per topic, per user. Not `solved / total`, which hands you 1.0 for a single lucky solve:

```
smoothedRate = (solved + 2) / (total + 4)
confidence   = min(1, total / 10)
mastery      = 0.5 + (smoothedRate - 0.5) * confidence
```

Topics land in one of three buckets: weak (has data, below 0.6), strong (has data, 0.6 or above),
and unknown (no data at all). Unknown is not weak. A topic you've never touched gets one easy probe
to generate a signal, not a course of remedial work.

Target difficulty comes off the same score: below 0.45 is EASY, below 0.70 is MEDIUM, above that
HARD.

The list is then assembled in four stages, each taking only what the one before it left:

1. Revisions that are due (max 3)
2. Problems you attempted and never finished (max 2)
3. Your three weakest topics, at their target difficulty (max 2 each)
4. One easy probe per unknown topic (max 2)

Capped at 12, and no single topic can take more than 2 slots. New users with no history get a
breadth sampler instead: one easy problem per topic.

## API

Everything except register, login and health needs the auth cookie. Every non-GET request also has
its `Origin` header checked against `FRONTEND_URL`.

| Prefix | What's there |
|---|---|
| `/api/auth` | Register, login, logout, current user |
| `/api/recommendations` | The ranked list |
| `/api/mastery` | Topic scores split into weak/strong/unknown, plus a recompute trigger |
| `/api/revision` | What's due, and marking something reviewed |
| `/api/integrations/codeforces` | Link, sync, status, unlink |
| `/api/integrations/leetcode` | Same four |
| `/api/ai` | Explain a recommendation, or get a hint. Rate limited to 6/min per user |
| `/api/sessions` | Start a practice session, request a hint, resolve it, history |
| `/api/problems` | `GET /similar?url=` for problems built on the same ideas |
| `/api/analytics` | Mastery trajectory over time, and a summary with streaks and breakthroughs |
| `/api/contests` | Start a timed set, claim solves, finalize, reconcile against the provider |

## Running it locally

You'll need Node 20+ and a Postgres database. [Neon](https://neon.tech)'s free tier is fine.

```bash
git clone https://github.com/mahirdll29/dsa-cp-trainer.git
cd dsa-cp-trainer/backend
npm install

cp .env.example .env
# fill in DATABASE_URL and JWT_SECRET at minimum

npx prisma generate
npx prisma migrate dev
npm run prisma:seed         # the 32 canonical topics, required before any sync

npm run sync:cf-problems    # Codeforces catalog, ~45s
npm run sync:lc-problems    # LeetCode catalog, ~2-3 min

npm run dev                 # :5000
```

Frontend, in a second terminal:

```bash
cd ../frontend
npm install
npm run dev                 # :3000
```

Two things that will bite you if you skip them. **The frontend has to be on port 3000 exactly**,
because the API compares `Origin` against `FRONTEND_URL` byte for byte and fails closed, so any
other port makes every write return 403. And **the catalog import isn't optional**: the engine
recommends problems you haven't solved, so it needs a pool independent of your own history, and
without it every "new material" slot comes back empty. Both imports are idempotent.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection string |
| `JWT_SECRET` | yes | | Auth signing key. The server refuses to start without it |
| `PORT` | no | `5000` | |
| `FRONTEND_URL` | no | `http://localhost:3000` | CORS and CSRF origin |
| `NODE_ENV` | no | `development` | |
| `GROQ_API_KEY` | no | | Leave it out and the server still boots. Only `/api/ai/*` returns 503 |
| `GROQ_MODEL` | no | `openai/gpt-oss-120b` | |
| `GROQ_BASE_URL` | no | Groq's | Point at a local stub when testing failure paths |
| `LEETCODE_API_URL` | no | the hosted wrapper | Override to run your own instance |

## Project layout

```
backend/src
  engine/       mastery, recommendations, revision, analytics, contest selection
  providers/    all Codeforces, LeetCode and Groq calls, one folder each
  routes/       Express handlers
  lib/          auth, prisma, sync lock, cooldown math, URL parsing
frontend/app
  (app)/        the signed-in pages: home, revision, practice, similar,
                trajectory, contest, integrations
  login/  register/
```

## Tests

```bash
cd backend && npm test
```

160 Vitest tests over the pure functions: the mastery formula and its thresholds, the revision
ladder, the analytics gap and streak rules, the hint cooldown gate, URL parsing, the similarity
weighting, and the provider mappings. About a second to run, since none of them touch a database.

Routes, queries and provider calls aren't tested and aren't meant to be. They fail loudly. The
functions above fail silently, which is why they're the ones with tests.

## Notes

A few decisions that would otherwise look arbitrary:

- **No model picks problems.** An LLM asked to rank problems will produce something plausible and
  unrepeatable. The engine is auditable arithmetic, every item carries the reason it was chosen,
  and the AI layer sits strictly downstream of it.
- **Hints unlock on timestamp math, not on request.** 10 minutes to the first, 10 more to the
  second, 15 more to the third, each measured from the previous hint. A model asked whether to
  release one early folds the moment you sound frustrated. Subtraction doesn't. Asking early
  returns a normal 200 with a countdown, not an error.
- **Similarity is IDF-weighted Jaccard over topic sets.** A shared `queue` (47 problems in the
  catalog) counts for roughly four times a shared `math` (4,036). No embeddings, no model call.
- **LeetCode data is solve-biased and stays that way.** The wrapper returns recent accepted
  submissions only, with no failures and no difficulty, so a LeetCode-heavy topic scores higher
  than an equivalent Codeforces one. Documented rather than patched with invented numbers.
- **Nobody verifies you own the handle you link.** Anyone can claim any handle. All the data
  involved is already public and the damage stays inside the claiming account, so a verification
  flow that could be worked around seemed worse than an honest gap.
- **There's no job queue and no background worker.** Imports happen when you ask for them, and a
  contest whose clock ran out is finalized the next time someone reads it.

## License

Built for learning and as a portfolio piece.
