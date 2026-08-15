# DSA/CP TRAINER — AI-Powered Training Platform

### **`v1.0`** · [🔗 Live App](https://dsa-cp-trainer.vercel.app)
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

## Project Status

| Module | Status | Description |
|---|---|---|
| 1. Schema | ✅ Done | 9 models, 4 enums, migrated to Neon, 32 topics seeded |
| 2. Auth | ✅ Done | Register/login/logout/me + requireAuth middleware |
| 3. Recommendation Engine | ✅ Done | Mastery formula, spaced repetition, 4-stage pipeline |
| 4. Codeforces Integration | ✅ Done | Official API — global problem catalog, submissions, rating history |
| 5. LeetCode Integration | ✅ Done | Community wrapper — problem catalog (with difficulty gap-fill), submissions, tag mapping |
| 6. AI Layer | ✅ Done | Hints & explanations via Groq — per-user rate limiting, structured JSON, fail-soft |
| 7. Frontend | ✅ Done | 5 pages over the existing API — no new endpoints, no schema changes |

---

## Data Model

```
User ─┬─→ LinkedAccount ──→ RatingChange
      ├─→ UserProblem
      ├─→ TopicMastery
      └─→ RevisionItem

Problem ─→ ProblemTopic ←─ Topic
```

- **9 tables**, 4 enums, `cuid()` IDs everywhere
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
| `GET` | `/api/auth/me` | ✅ | Current user profile |

### Recommendation Engine
| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/recommendations` | ✅ | Ranked problem list with reason strings |
| `GET` | `/api/mastery` | ✅ | Topic mastery — weak, strong, unknown separated |
| `GET` | `/api/revision/due` | ✅ | Spaced-repetition items due now |
| `POST` | `/api/revision/:problemId/review` | ✅ | Mark reviewed, advance interval |
| `POST` | `/api/mastery/recompute` | ✅ | Rebuild mastery from current solve data |

### Codeforces Integration (`/api/integrations/codeforces`)
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/integrations/codeforces/link` | ✅ | Validate a handle and link it |
| `POST` | `/api/integrations/codeforces/sync` | ✅ | Import submissions + rating history, then recompute mastery |
| `GET` | `/api/integrations/codeforces/status` | ✅ | Sync state read from our DB, never from upstream |
| `DELETE` | `/api/integrations/codeforces/link` | ✅ | Unlink and purge imported solve history |

### LeetCode Integration (`/api/integrations/leetcode`)
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/integrations/leetcode/link` | ✅ | Validate a username and link it |
| `POST` | `/api/integrations/leetcode/sync` | ✅ | Import submissions, then recompute mastery |
| `GET` | `/api/integrations/leetcode/status` | ✅ | Sync state read from our DB, never from upstream |
| `DELETE` | `/api/integrations/leetcode/link` | ✅ | Unlink and purge imported solve history |

### AI Layer (`/api/ai`)
| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/ai/explain` | ✅ | Explain *why* a problem was recommended (engine reason → natural language) |
| `POST` | `/api/ai/hint` | ✅ | Topic-level hint for a problem (approach nudge, not a solution) |

> **AI endpoints are rate-limited** — 6 requests per user per rolling minute, protecting the shared Groq token budget. Returns `429` with a truthful `Retry-After` header when exceeded.

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
| `DATABASE_URL` | ✅ | — | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | — | Signing key for auth tokens (fail-fast if missing) |
| `PORT` | — | `5000` | Server port |
| `FRONTEND_URL` | — | `http://localhost:3000` | CORS origin |
| `NODE_ENV` | — | `development` | Environment |
| `GROQ_API_KEY` | — | — | Groq API key (fail-soft: server boots without it, AI returns 503) |
| `GROQ_MODEL` | — | `openai/gpt-oss-120b` | Model for AI layer (configurable, not hardcoded) |
| `GROQ_BASE_URL` | — | `https://api.groq.com/openai/v1` | Override for local stub testing |
| `LEETCODE_API_URL` | — | `https://alfa-leetcode-api.onrender.com` | Community wrapper URL (self-host via Docker if needed) |

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
- **AI prompt injection hardened** — engine reasons are server-derived, never from request body; rate limiting caps abuse

---

## Roadmap — v2

This is **v1** — the core loop (import → measure → recommend → review) is complete and deployed. Here's what's coming next:

| Feature | Description |
|---|---|
| **Similar Problem Finder** | Paste any LeetCode/Codeforces problem URL and get similar problems at your desired difficulty range — powered by topic and structural similarity matching across the full catalog |
| **Advanced AI Hints** | Multi-step, progressive hints that adapt to your mastery level — from high-level approach nudges to detailed breakdowns, without ever giving away the solution |
| **Contest Mode** | Timed practice sets that simulate real contest conditions with problems calibrated to your current rating |
| **Progress Analytics** | Visualize your mastery trajectory over time — weekly trends, topic breakthrough detection, and streak tracking |
| **Community Problem Lists** | Curated problem sets shared by users, filterable by topic, difficulty, and target contest level |

> Have a feature idea? [Open an issue](https://github.com/mahirdll29/dsa-cp-trainer/issues) — contributions welcome.

---

## License

This project is for learning and portfolio purposes.
