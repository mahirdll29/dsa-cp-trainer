# DSA/CP TRAINER

A personalized learning platform for Data Structures & Algorithms and Competitive Programming. It imports your real activity from **LeetCode** and **Codeforces**, derives per-topic mastery from your solve history, and deterministically recommends what to solve next — weak topics first, at the right difficulty, with spaced repetition for problems you've already solved.

**The recommendation engine is pure backend logic with no AI.** It is deterministic: the same inputs always produce the same recommendations. AI is layered on top for hints and explanations only — it never decides what you should solve.

---

## Architecture

```
User's solve history (LeetCode + Codeforces)
              │
              ▼
     ┌─────────────────┐
     │  Import Pipeline │  ← Modules 4 & 5
     │  (validate, map, │
     │   store)         │
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │ Mastery Recompute│  ← Laplace-smoothed, volume-weighted
     │ (per user×topic) │
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │  Weak Area       │  ← Weak ≠ Unknown (different treatments)
     │  Detection       │
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │  Difficulty      │  ← Just above current comfort
     │  Selection       │
     └────────┬────────┘
              │
              ▼
     ┌─────────────────┐
     │  Recommendation  │  ← Revisions → Unfinished → Weak → Exploratory
     │  Assembly        │
     └─────────────────┘
```

### Key Design Decisions

- **Mastery formula uses Laplace smoothing** — the naive `solved/total` gives 1.0 on a single lucky solve. The smoothed formula adds imaginary evidence so low-volume topics can't claim high mastery without sustained proof.
- **Weak ≠ Unknown** — a topic with low scores needs practice; a topic with *no data* needs one exploratory probe. Conflating them floods new users with 32 fabricated "weaknesses."
- **Deterministic output** — no randomness, every sort has a unique tie-breaker. Same inputs → same recommendations. Testable, explainable, trustworthy.
- **Spaced repetition** — simplified SM-2 with fixed intervals (1, 3, 7, 14, 30 days). No per-item ease factor because we lack the user-supplied quality rating SM-2 requires.
- **No AI in the engine** — recommendations are arithmetic and rules, fully auditable. The AI layer explains them; it never produces them.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Node.js, Express 4, TypeScript |
| **Database** | PostgreSQL (Neon) + Prisma ORM |
| **Auth** | JWT + bcrypt + HTTP-only cookies |
| **AI** | Groq (structured JSON output) — Module 6 |
| **External Data** | Codeforces API (official), LeetCode (community wrapper) |
| **Frontend** | Next.js, TypeScript, Tailwind CSS, shadcn/ui — Module 7 |
| **Deployment** | Vercel (frontend) + Railway (backend) — later stage |

---

## Project Status

| Module | Status | Description |
|---|---|---|
| 1. Schema | ✅ Done | 9 models, 4 enums, migrated to Neon, 32 topics seeded |
| 2. Auth | ✅ Done | Register/login/logout/me + requireAuth middleware |
| 3. Recommendation Engine | ✅ Done | Mastery formula, spaced repetition, 4-stage pipeline |
| 4. Codeforces Integration | 🔜 Next | Official API — profile, submissions, rating history |
| 5. LeetCode Integration | ⬜ | Community wrapper (alfa-leetcode-api) |
| 6. AI Layer | ⬜ | Hints, explanations, code review via Groq |
| 7. Frontend | ⬜ | Next.js dashboard |

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

# Seed the 32 canonical DSA topics
npm run prisma:seed

# Start the dev server
npm run dev
```

### Development Commands

```bash
npm run dev              # Start dev server (tsx watch)
npm run prisma:seed      # Seed 32 canonical topics (idempotent)
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

## Security

- **HTTP-only cookies** — JavaScript cannot access the auth token
- **bcrypt** (cost 10) — passwords are hashed, never stored in plaintext
- **CSRF protection** — Origin-header check on all state-changing requests, fails closed
- **Query-scoped ownership** — `userId` goes into WHERE clauses; other users' data is never fetched
- **Prisma select allowlists** — password hash is never included in API responses

---

## License

This project is for learning and portfolio purposes.
