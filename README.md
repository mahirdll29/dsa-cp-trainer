# DSA/CP TRAINER — AI-Powered Training Platform

### **`v1.0`** · [Live App](https://dsa-cp-trainer.vercel.app)
A personalized learning platform for Data Structures & Algorithms and Competitive Programming. It imports your real activity from **LeetCode** and **Codeforces**, derives per-topic mastery from your solve history, and deterministically recommends what to solve next — weak topics first, at the right difficulty, with spaced repetition for problems you've already solved.

**The recommendation engine is pure backend logic with no AI.** It is deterministic: the same inputs always produce the same recommendations. AI is layered on top for hints and explanations only — it never decides what you should solve.

---

## Architecture

```
User's solve history (LeetCode + Codeforces)
              │
              ▼
     ┌─────────────────┐
     │  Import Pipeline│  ← Modules 4 & 5
     │  (validate, map,│
     │   store)        │
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │Mastery Recompute│  ← Laplace-smoothed, volume-weighted
     │ (per user×topic)│
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │  Weak Area      │  ← Weak ≠ Unknown (different treatments)
     │  Detection      │
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │  Difficulty     │  ← Just above current comfort
     │  Selection      │
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │  Recommendation │  ← Revisions → Unfinished → Weak → Exploratory
     │  Assembly       │
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │  AI Layer       │  ← Module 6: explains & hints, never decides
     │  (Groq)         │
     └─────────────────┘
```

### Key Design Decisions

- **Mastery formula uses Laplace smoothing** — the naive `solved/total` gives 1.0 on a single lucky solve. The smoothed formula adds imaginary evidence so low-volume topics can't claim high mastery without sustained proof.
- **Weak ≠ Unknown** — a topic with low scores needs practice; a topic with *no data* needs one exploratory probe. Conflating them floods new users with 32 fabricated "weaknesses."
- **Deterministic output** — no randomness, every sort has a unique tie-breaker. Same inputs → same recommendations. Testable, explainable, trustworthy.
- **Spaced repetition** — simplified SM-2 with fixed intervals (1, 3, 7, 14, 30 days). No per-item ease factor because we lack the user-supplied quality rating SM-2 requires.
- **No AI in the engine** — recommendations are arithmetic and rules, fully auditable. The AI layer explains them; it never produces them.
- **AI fails soft** — if `GROQ_API_KEY` is missing the server still boots, every non-AI endpoint works normally, and only `/api/ai/*` returns 503. The recommendation engine is fully correct with AI switched off.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Node.js, Express 4, TypeScript |
| **Database** | PostgreSQL (Neon) + Prisma ORM |
| **Auth** | JWT + bcrypt + HTTP-only cookies |
| **AI** | Groq (structured JSON output, configurable model) |
| **External Data** | Codeforces API (official), LeetCode (alfa-leetcode-api community wrapper) |
| **Frontend** | Next.js 16 (App Router), React 19, TypeScript, Tailwind v4, `motion`, shadcn/ui |
| **Deployment** | Vercel (frontend) + Render (backend) |

---

## Data Model

```
User ─┬─→ LinkedAccount ──→ RatingChange
      ├─→ UserProblem
      ├─→ TopicMastery
      ├─→ RevisionItem
      ├─→ MasteryLog
      └─→ PracticeSession ─→ SessionHint

Problem ─→ ProblemTopic ←─ Topic
```

- **12 tables**, 5 enums, `cuid()` IDs everywhere
- **Two difficulty columns**: `difficultyRaw` (provider's value verbatim) + `difficultyBand` (normalized EASY/MEDIUM/HARD for the engine)
- **`TopicMastery` is stored, not computed** — denormalized for fast reads, recomputed after every import
- **`onDelete` decided per relation** — Cascade for user-owned data, Restrict for shared reference data (Problem, Topic)

---

## API Endpoints

### Auth (`/api/auth`)
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | — | Create account + set cookie |
| `POST` | `/api/auth/login` | — | Authenticate + set cookie |
| `POST` | `/api/auth/logout` | — | Clear cookie |
| `GET` | `/api/auth/me` | required | Current user profile |

### Recommendation Engine
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/recommendations` | required | Ranked problem list with reason strings |
| `GET` | `/api/mastery` | required | Topic mastery — weak, strong, unknown separated |
| `GET` | `/api/revision/due` | required | Spaced-repetition items due now |
| `POST` | `/api/revision/:problemId/review` | required | Mark reviewed, advance interval |
| `POST` | `/api/mastery/recompute` | required | Rebuild mastery from current solve data |

### Codeforces Integration (`/api/integrations/codeforces`)
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/integrations/codeforces/link` | required | Validate a handle and link it |
| `POST` | `/api/integrations/codeforces/sync` | required | Import submissions + rating history, then recompute mastery |
| `GET` | `/api/integrations/codeforces/status` | required | Sync state read from our DB, never from upstream |
| `DELETE` | `/api/integrations/codeforces/link` | required | Unlink and purge imported solve history (`409` while a sync is running) |

### LeetCode Integration (`/api/integrations/leetcode`)
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/integrations/leetcode/link` | required | Validate a username and link it |
| `POST` | `/api/integrations/leetcode/sync` | required | Import submissions, then recompute mastery |
| `GET` | `/api/integrations/leetcode/status` | required | Sync state read from our DB, never from upstream |
| `DELETE` | `/api/integrations/leetcode/link` | required | Unlink and purge imported solve history (`409` while a sync is running) |

### AI Layer (`/api/ai`)
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/ai/explain` | required | Explain *why* a problem was recommended (engine reason → natural language) |
| `POST` | `/api/ai/hint` | required | Topic-level hint for a problem (approach nudge, not a solution) |

### Practice Sessions (`/api/sessions`)
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/sessions` | required | Start a session on a problem (`409` if one is already active on a different problem) |
| `GET` | `/api/sessions/active` | required | The active session with its issued hints, or `null` |
| `POST` | `/api/sessions/:id/hint` | required | Request the next hint. Always `200`: either the hint, or a countdown |
| `POST` | `/api/sessions/:id/resolve` | required | End a session as `SOLVED` or `ABANDONED` |
| `GET` | `/api/sessions/history` | required | Resolved sessions, newest first, capped at 50 |

> **Hint release is decided by timestamp arithmetic, never by a model.** Ten minutes from session start to hint 1, ten more to hint 2, fifteen more to hint 3 — each measured from the previous hint rather than from the start. Asking early returns a normal `200` carrying a countdown, not an error.

> **AI endpoints are rate-limited** — 6 requests per user per rolling minute, protecting the shared Groq token budget. Returns `429` with a truthful `Retry-After` header when exceeded.

### Similar Problems (`/api/problems`)
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/problems/similar` | required | Paste a problem URL, get problems built on the same ideas. `?url=` required, `?bands=EASY,MEDIUM` and `?limit=1..50` optional |

> **Similarity is IDF-weighted Jaccard over topic sets, not a model call.** Each shared topic is weighted by `ln(1 + N/df)`, so a shared `queue` (47 problems) counts for roughly four times a shared `math` (4,036). Ranking is score, then rating distance between two rated problems, then problem id — a total order, so identical requests return identical bytes. Difficulty is filtered on the normalized band; the two providers' rating scales are never mapped onto each other.

> A URL that cannot be parsed is `400`, one parsed but not in the catalog is `404` echoing the parsed id, and one in the catalog carrying no topics is `422`. An empty result set with a valid source is a normal `200`.

### Progress Analytics (`/api/analytics`)
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/analytics/trajectory` | required | Per-topic mastery over time, bucketed daily. `?days=1..365` and `?tzOffsetMinutes=` optional |
| `GET` | `/api/analytics/summary` | required | Breakthroughs, solve streak and the week's biggest movers in one response |

> **The log records only what changed, so a topic with no row for a week means one of two things.** If it still has a mastery row the value persisted and carries forward; if it does not, the topic lost its data and the series returns `null` from its last recorded day onward. Nothing is interpolated and no line is drawn across a gap, because a gap is a period we have no measurement for rather than a score of zero.

> **A breakthrough is a topic crossing 0.6 upward and still being above it the next day.** `unknown -> strong` does not count, or every topic getting its first data would fire one. A crossing in the most recent day has no following day to check yet and is reported separately as pending, never as confirmed.

> Both responses carry `historyDays` and `sufficient`, so "nothing happened" and "not enough data to say" stay distinguishable. Days are bucketed against a caller-supplied UTC offset, defaulting to +330; the streak is counted up to the last successful sync rather than to now, and returns that timestamp.

### Contest Mode (`/api/contests`)
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/contests/options` | required | Allowed durations and sizes, plus the difficulty spread each size produces |
| `POST` | `/api/contests` | required | Start a timed set. `{ durationMinutes, size }`, both rejected unless they are allowed values |
| `GET` | `/api/contests/active` | required | The running contest with every problem's claim state, or `null` |
| `GET` | `/api/contests/:id` | required | One contest in full, so a mid-contest refresh restores everything |
| `POST` | `/api/contests/:id/problems/:pid/claim` | required | Mark a problem solved or unmark it, while the clock is running |
| `POST` | `/api/contests/:id/finalize` | required | End as `COMPLETED` or `ABANDONED`. Idempotent |
| `POST` | `/api/contests/:id/reconcile` | required | Check claims against real provider submissions. `409` while the contest is still `ACTIVE` |
| `GET` | `/api/contests/history` | required | Finished contests, newest first, capped at 50 |

> **Problem selection is its own thing, not the recommendation engine.** The engine ranks by weak topics and due revisions, which is the wrong answer for a contest; this picks a fixed spread (1 easy / 2 medium / 2 hard at size 5) at random from everything you have not already solved. Calibration is by normalized band, never by a cross-provider rating mapping. If a band cannot be filled the request fails naming that band and the counts, rather than quietly substituting from another one.

> **`endsAt` is the only authority, and expiry is lazy.** A contest whose time has run out is finalized by the next read of it - there is no scheduler, no background job and no server timer. Running out of time is `COMPLETED`; `ABANDONED` means you quit early. A contest and a practice session cannot run at the same time, in either direction.

> **Solves are self-reported during the contest and verified afterwards.** Real-time detection is impossible against a pull-based sync, so you mark your own, and reconciliation later confirms any problem whose provider submission timestamp falls inside the contest window. It is a separate explicit step because it needs a full sync, which measures 45 seconds. Until it runs, `reconciledAt` is null and the results say so rather than implying nothing was solved. There is no simulated rating, performance score or percentile anywhere - there is nothing to compare against, so any number would be invented.

All non-GET requests are protected by an Origin-header CSRF check (registered globally).

---

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL database (or [Neon](https://neon.tech) free tier)

### Setup

```bash
# Clone
git clone https://github.com/mahirdll29/dsa-cp-trainer.git
cd dsa-cp-trainer/backend

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL, JWT_SECRET, etc.

# Generate Prisma client + run migrations
npx prisma generate
npx prisma migrate dev

# Seed the 32 canonical DSA topics (required before any provider sync)
npm run prisma:seed

# Import problem catalogs — the pool recommendations are drawn from
npm run sync:cf-problems    # Codeforces (~45s first run)
npm run sync:lc-problems    # LeetCode (~2-3 min first run)

# Start the API
npm run dev
```

Then, in a second terminal, start the frontend:

```bash
cd ../frontend
npm install
npm run dev          # http://localhost:3000
```

> **The frontend must be served from exactly `http://localhost:3000`.** The API's
> `requireSameOrigin` middleware compares the browser's `Origin` header against `FRONTEND_URL`
> byte for byte and fails closed, so any other port makes every write return `403`.

> **The catalog import is not optional.** The recommendation engine suggests problems you have
> *not* solved, so it needs a pool of problems that exists independently of any user's history.
> Without it, every "new material" recommendation returns empty. Both imports are idempotent, so
> re-running them is safe and cheap.

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL connection string |
| `JWT_SECRET` | yes | — | Signing key for auth tokens (fail-fast if missing) |
| `PORT` | no | `5000` | Server port |
| `FRONTEND_URL` | no | `http://localhost:3000` | CORS origin |
| `NODE_ENV` | no | `development` | Environment |
| `GROQ_API_KEY` | no | — | Groq API key (fail-soft: server boots without it, AI returns 503) |
| `GROQ_MODEL` | no | `openai/gpt-oss-120b` | Model for AI layer (configurable, not hardcoded) |
| `GROQ_BASE_URL` | no | `https://api.groq.com/openai/v1` | Override for local stub testing |
| `LEETCODE_API_URL` | no | `https://alfa-leetcode-api.onrender.com` | Community wrapper URL (self-host via Docker if needed) |

### Development Commands

```bash
npm run dev              # Start dev server (tsx watch)
npm run prisma:seed      # Seed 32 canonical topics (idempotent)
npm run sync:cf-problems # Import the Codeforces catalog (idempotent, ~45s first run)
npm run sync:lc-problems # Import the LeetCode catalog (idempotent, ~2-3 min first run)
npm run dev:seed         # Seed test data for engine verification
npm run dev:seed:clean   # Clean up test data
npx prisma studio        # Browse database
npx tsc --noEmit         # Type check
```

---

## The Recommendation Engine — How It Works

### 1. Mastery Score

Not the naive `solved / total` (which gives 1.0 on one lucky solve). Instead:

```
smoothedRate = (solved + 2) / (total + 4)        ← Laplace smoothing
confidence   = min(1, total / 10)                ← Volume weight
mastery      = 0.5 + (smoothedRate - 0.5) × confidence
```

### 2. Weak Area Detection

Topics are categorized into three buckets — **weak** (has data, score < 0.6), **strong** (has data, score ≥ 0.6), and **unknown** (no data at all). Unknown topics receive exploratory probes, not remedial practice.

### 3. Difficulty Selection

| Mastery | Target Difficulty |
|---|---|
| < 0.45 | EASY |
| 0.45 – 0.69 | MEDIUM |
| ≥ 0.70 | HARD |

### 4. Spaced Repetition

Fixed interval ladder: **1 → 3 → 7 → 14 → 30 days** (then 30 repeating). A simplified SM-2 without per-item ease factors.

### 5. Assembly Pipeline

1. **Due revisions** (cap: 3) — reviewing beats new material
2. **Unfinished attempts** (cap: 2) — known gaps with existing context
3. **Weak topic problems** (3 topics × 2 each) — at target difficulty
4. **Exploratory problems** (cap: 2) — one EASY probe per unknown topic

**Total cap: 12.** Per-topic cap: 2. Every item carries a `reason` string for auditability.

**Cold start:** brand-new users get a breadth sampler — one EASY problem per topic to generate initial mastery signals.

---

## The AI Layer — How It Works

The AI layer is a **strict consumer** of the recommendation engine. The dependency arrow points AI → engine, never the reverse — enforced by the import graph (reversing it would be a visible import cycle).

### Explain

`POST /api/ai/explain { problemId }` — takes a problem from the user's current recommendations, reads the engine's `reason` string, and asks Groq to restate it in natural language. The reason is **server-derived** (re-running the real pipeline), never taken from the request body — so a caller cannot inject arbitrary text into the prompt.

### Hint

`POST /api/ai/hint { problemId }` — generates a topic-level nudge based on the problem's title, topics, and difficulty. The model is explicitly told it has **not** been given the problem statement, so it cannot hallucinate one.

### Design Constraints

- **No problem statements stored** — `Problem` has title, url, difficulty, and topics, but no statement text. Hints are approach-level by design.
- **Structured JSON output** — both endpoints return `{ "explanation": "..." }` or `{ "hint": "..." }` via Groq's JSON mode.
- **Per-user rate limiting** — 6 calls per rolling minute, sliding window, in-memory. Protects the shared Groq token budget.
- **Zero retries** — AI failures are cosmetic (the recommendation list is already rendered), so retrying would double latency for no user benefit.

---

## Provider Integrations

All calls to a provider live in **one module** (`src/providers/<provider>/`), so a breaking change
upstream touches one file. Every response is validated before it reaches the database — even
Codeforces', which is officially documented.

### Codeforces

- **Official API** — documented, stable, returns full submission history in a single call.
- One API call, no pagination. Every sync is a full re-sync, so rejudged verdicts are picked up automatically.

### LeetCode

- **No official API** — uses the [alfa-leetcode-api](https://github.com/alfaarghya/alfa-leetcode-api) community wrapper, a reverse-engineered proxy on free hosting.
- **Quota, not a rate limit** — 120 requests per hour per IP. Spacing cannot buy budget back, so every call is counted and the import is designed to minimise them.
- **Difficulty gap-fill** — the submission endpoint returns no difficulty. The import checks whether the problem is already in the catalog first; only unknown problems spend one of those 120 calls fetching from `/select`.
- **Username validation at link time** — the submission endpoint returns `200 { count: 0 }` for both nonexistent users and users with zero solves. Only the profile endpoint can distinguish them, so validation happens at link, not sync.

### Shared Decisions

- **The problem catalog is global; submissions are per-user.** These are separate jobs. The engine recommends problems you have *not* solved, so if `Problem` were populated only from your own submissions, every row would be one you had already touched and the engine would return nothing — silently.
- **Idempotency replaces transactions.** Tens of thousands of writes can't go in one transaction, so every write is keyed on a natural unique. A run that dies halfway converges on the same state when retried, and `syncStatus` tells you a retry is needed.
- **Batched, set-based writes.** Round-trip latency to a hosted Postgres (~250 ms measured) makes per-row upsert loops unusable — the catalog would take hours instead of seconds.
- **`syncStatus` is a mutex with an expiry.** A process that dies mid-import would otherwise leave the account stuck on `SYNCING` forever. The lock is acquired with an atomic compare-and-set and reclaimed after 5 minutes. The lock logic is shared (`lib/syncLock.ts`) because divergence there is a silent correctness bug.
- **Unlinking purges imported solve history but keeps revision progress.** Solve history is re-importable from the provider; your spaced-repetition ladder is not.
- **Unmapped provider tags are skipped, but the problem is still imported.** A solve recorded against no topic beats a lost solve — and a *wrong* topic tag would corrupt mastery scores.

### Known limitation

Handle ownership is **not** verified — anyone can claim any handle. Recorded as a deliberate v1
non-goal: the damage is confined to the claiming account (all imported data is already public),
and a bypassable verification flow would be worse than an honest gap.

---

## Security

- **HTTP-only cookies** — JavaScript cannot access the auth token
- **bcrypt** (cost 10) — passwords are hashed, never stored in plaintext
- **CSRF protection** — Origin-header check on all state-changing requests, fails closed
- **Query-scoped ownership** — `userId` goes into WHERE clauses; other users' data is never fetched
- **Prisma select allowlists** — password hash is never included in API responses
- **AI prompt inputs are server-derived** — `/api/ai/explain` re-runs the real pipeline to obtain
  the engine's reason rather than accepting one from the request body, so a caller cannot put
  arbitrary text into the prompt. Titles come from the providers rather than from users, but
  Codeforces gym contests are user-creatable, so titles are collapsed to a single line and
  length-bounded before they reach the model. The prompt carries no secrets, and the output is
  two sentences shown only to the caller.

---

## Roadmap — v2

The v1 core loop (import → measure → recommend → review) is complete and deployed. v2 is in progress — practice sessions, the similar problem finder and progress analytics have shipped. Here's what's still ahead:

| Feature | Description |
|---|---|
| **Contest Mode** | Timed practice sets that simulate real contest conditions with problems calibrated to your current rating |

> Have a feature idea? [Open an issue](https://github.com/mahirdll29/dsa-cp-trainer/issues) — contributions welcome.

---

## License

This project is for learning and portfolio purposes.
