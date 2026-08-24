# AI DSA/CP Coach — Project Context & Working Instructions

## What this is

A personalized learning platform for DSA and competitive programming. It imports a user's real
activity from Codeforces and LeetCode, measures topic mastery from it, and uses a deterministic
recommendation engine to decide what they should solve next. AI sits on top for hints and
explanations. The engine works completely without it.

This is a personal tool first and a public repository second. I use it. Decisions should optimize
for something I actually want to open every day and for a codebase that reads well to anyone who
clones it — in that order.

## Status

v1 is complete and deployed: the full loop of import, measure, recommend, review, plus a designed
frontend over it. A hardening pass has since removed AI-generated code tells and audited for bugs.

v2 is in progress. See "v2 build order" below.

## Tech stack

- Frontend: Next.js (App Router), TypeScript, Tailwind CSS v4, shadcn/ui as a restyled component
  substrate, `motion` for state-change animation
- Backend: Node.js, Express, REST, TypeScript
- Database: PostgreSQL (Neon) + Prisma
- Auth: JWT + bcrypt + HTTP-only cookies
- AI: Groq (`openai/gpt-oss-120b`), structured JSON output
- External data: Codeforces API (official, documented) and LeetCode via the community
  `alfa-leetcode-api` wrapper — LeetCode has no official public API
- Deployment: Vercel (frontend), Render (backend, free tier with a self-ping keep-alive)

## What exists

- Auth: register, login, profile
- Codeforces: catalog sync, profile import, contest analytics, rating progress
- LeetCode: catalog sync, profile import, solved-problem and topic breakdown
- Topic mastery tracking and a revision planner
- Recommendation engine: mastery to weak areas to difficulty selection to a four-stage candidate
  pipeline. Pure deterministic logic, no AI.
- AI layer: hints and explanations only
- Frontend: designed client over the above

## Standing architectural boundaries

These are settled. Do not reopen them inside a feature module; if one needs to change, that is its
own conversation and its own pass.

- **The recommendation engine is deterministic and stays that way.** No model call ever selects,
  ranks or filters a problem. AI explains and hints; it does not decide.
- **The mastery formula is frozen** unless I explicitly open it. Features read mastery, they do not
  redefine it. New signals (hint usage, contest results) get recorded now and weighted later, if at
  all.
- **Everything reaching Groq is server-derived.** No client-supplied string is ever interpolated
  into a prompt. Reason strings, mastery values and problem metadata are fetched server-side by
  `userId`. This is the boundary that keeps prompt injection out; treat any new AI input as
  crossing it until proven otherwise.
- **Derived values are derived, not stored.** Mastery state (weak/strong/unknown) and streaks are
  computed at read time from stored inputs. Storing a derived label means a threshold change
  silently invalidates history.
- **`docs/architecture.md` is the single source of truth** for reasoning. It is the only
  destination for design rationale. Fill sections in with real specifics as things are built;
  leave unbuilt parts marked TBD and never speculate.

## How to work with me

### Per-module process

1. **Plan mode first.** Show the plan in plain English — what you'll build, why it's shaped that
   way, and the framework concepts underneath. Wait for approval before writing code.
2. **Read the repo before planning.** Ground every decision in what the files actually say. Quote
   real signatures and field names. If this prompt contradicts the repo, surface the contradiction
   rather than silently picking a side.
3. **Explain as you build, file by file.** What each part does and why this approach over the
   alternatives. Don't move on until the current file is explained.
4. **One module at a time.** Build only what I asked for. Wait for me to say next.
5. **Guard scope actively.** If you find yourself building something that belongs to a later
   module, stop and say so. A module that quietly grows is worse than one that ships small.
6. **Don't invent.** If something isn't specified, ask. Never fabricate endpoints, fields or
   behaviour we haven't agreed on.
7. **Flag genuinely interesting concepts** as you go — things worth understanding properly rather
   than pattern-matching. Keep it short and only when it's real.
8. **Verify your own work.** Run the checks with bash and show real output, including failure
   paths, not just happy ones. Fix failures and re-run rather than reporting them as caveats.
   `npx tsc --noEmit` clean is a hard gate. Kill any server process you start — kill by port,
   `tsx watch` orphans its child.
9. **Update `docs/session-handoff.md`** at the end of every module so a fresh session can resume
   cheaply.

### Documentation policy

- `docs/architecture.md` is where reasoning goes. Update the relevant sections in the same commit
  as the code.
- The seven `docs/*-interview-prep.md` files are a **frozen v1 artifact**. Do not create new ones.
  Do not edit the existing seven, even where they have gone stale — note the staleness and leave
  the file alone.
- `README.md` describes what the project is and what it does. It is not a status log.

## Code style

Write like a person who has been maintaining this for months, not like a generator producing a
first draft.

- Plain, readable Express handlers. No service or repository layer unless a piece of logic has two
  real callers — and if so, say that's why.
- Straightforward Prisma. No transactions unless genuinely required. Note that nothing in the repo
  currently uses `$transaction`; introducing one is a deliberate decision, not a default.
- Hand-written validation, consistent across the project. No Zod.
- TypeScript with simple, readable types. No type gymnastics, no `as any`, no `@ts-ignore`.
- Prefer deleting code over guarding it. Defensive branches that defend against nothing are noise.

### Comments

Comment density is a quality metric here, and the bar is high. Every comment gets triaged:

- **Load-bearing** — marks an invariant where a future edit would silently break correctness.
  Keep it, as **one line stating the consequence**, not the derivation. The full explanation goes
  to `architecture.md`.
- **Unique reasoning, not load-bearing** — migrate to `architecture.md` first, then delete the
  comment. Never delete reasoning that exists nowhere else.
- **Redundant with the code or already documented** — delete.

A comment survives only if removing it would let a competent reader either misunderstand the code
or reintroduce a bug. Flag any file that exceeds roughly 20% comment lines and justify it.

Never write: comments restating the line below, step-number narration inside functions, banner or
divider comments, JSDoc on self-explanatory signatures, references to module numbers or the build
process, or decorative `NOTE:`/`IMPORTANT:`.

### Output and logging

- No emoji anywhere — code, logs, commit messages, docs, seed scripts, README.
- Log lines are flat and factual. No progress banners, no summary tables, no celebratory strings.
- Error messages state the failure. They don't explain, apologize or suggest.

## External API rules (both providers)

Codeforces has an official documented API. LeetCode does not, and the wrapper is community
maintained — its response shape can change without notice. So for both:

- All calls to a provider live in one module, so a break or a swap touches one file.
- Every response is validated before it touches the database. Treat it as untrusted input.
- Explicit timeout via `AbortController`. A provider failure is a recoverable state, never a crash.
- Results are cached in our own database with a sync status and `lastSyncedAt`. We do not hit
  upstream on every page load.
- A failed import must never break the page. Graceful degradation throughout.

**Known limitation, deliberately not hidden:** the LeetCode wrapper returns only recent accepted
submissions, with no difficulty, tags or failed attempts. Mastery derived from LeetCode data is
therefore solve-biased. This is documented in `architecture.md`, not patched with invented data.

## Non-goals

- No admin role, no real-time updates, no websockets
- No code execution or judging. This platform recommends and tracks; it does not run code.
- No scraping. LeetCode data comes through the wrapper only.
- No job queue. Imports are on-demand.
- No server-side rendering of authenticated data — foreclosed by the host-only cookie
  (`architecture.md` §9.2)
- No business logic on the client. The frontend renders what endpoints return and adds no API
  surface. A feature needing a new endpoint is a backend module, not a quiet frontend addition.
- **Tests stop at the pure functions.** Vitest covers the mastery formula and band cutoffs, the
  revision interval ladder, the analytics carry-forward and streak rules, the hint cooldown gate,
  problem URL parsing, the similarity weighting and tie-break, and the provider mappings — the
  logic that is frozen, is a function of its arguments, and fails silently rather than loudly.
  Everything past that line stays a non-goal: no route or HTTP tests, no test database, no mocking
  of Prisma or any provider, no frontend tests, no CI, no coverage thresholds, no snapshots. A
  function that cannot be tested without one of those is out of scope — say so rather than
  reshaping it to fit. See `architecture.md` §15.

## v2 build order

Modules 8 through 12, in this order. Same rule as v1: do not begin one until I ask for it. The
decisions listed under each are settled — implement them, don't relitigate them. Open questions are
marked as such and need a decision at plan time.

### Module 8 — Mastery history

A `MasteryLog` table plus a write hook on mastery recompute. No endpoints, no UI, no queries. It
exists so Module 11 has something to read.

Ships first, ahead of features that are more interesting, because history cannot be backfilled.
Every day it isn't running is a day of trajectory permanently lost.

Settled:
- Stores raw inputs only — `solvedCount`, `attemptedCount`, `masteryScore`, `capturedAt`. No
  derived state column, because thresholds can change and would silently invalidate stored labels.
- Append-only. Rows are never updated or deleted.
- Writes only when a value actually changed, so repeated syncs in a day don't produce identical
  rows across 32 topics. A user's first recompute always writes a baseline.
- Not transactional. `TopicMastery` stays the source of truth; a dropped log row costs one chart
  point, not correctness. The insert is last and non-fatal — caught, logged with `userId` and the
  count of dropped rows, sync still succeeds. Adding `$transaction` to `recomputeMastery` is a
  separate decision on its own merits.
- Deletions are not logged. When a topic loses all its data (account unlink), writing a terminal
  zero row would assert a regression that never happened. The honest representation is a gap.

### Module 9 — Practice session (personal trainer)

The flagship feature and the one I'll use daily. Start a session on a problem, the app times you,
and hints unlock on a schedule rather than on demand.

Settled:
- Fixed cooldowns, no difficulty scaling: 10 minutes from session start to hint 1, 10 more to hint
  2, 15 more to hint 3. `difficultyBand` is normalized across two providers with different scales,
  so keying a UX rule to it would inherit that noise. Values live in a config constant so they can
  be tuned from felt experience.
- **The gate is deterministic timestamp math, never a model call.** An LLM asked whether to release
  a hint early will cave the moment the user sounds frustrated. The server won't.
- Requesting early returns `200` with `{ granted: false, secondsRemaining, message }` — a normal
  product state, not an error. The pushback message is a static rotation, not generated.
- Three fixed levels with hard ceilings, each its own prompt and system message. **L1 orientation:**
  points at what to notice, names no technique. **L2 technique:** names the approach or structure,
  not the construction. **L3 construction:** full approach, invariants, edge cases, no code.
- Generated on demand, one level at a time, stored permanently. Re-requesting a level returns the
  stored row and never makes a second call. Generating a level passes the previous levels' stored
  text in so it builds rather than repeats. Never generate all three in one call — a graduated set
  from a single call leaks L3 into L1.
- Mastery for the problem's topics feeds the prompt so hints on weak topics explain more
  groundwork. Fetched server-side by `userId`, never client-supplied.
- Sessions resolve as solved or abandoned, and record hints used. Abandoning after three hints is
  the strongest weak-topic signal in the system.
- Hint usage is recorded but does **not** feed the mastery formula. A hinted solve is genuinely
  weaker evidence, but that changes the engine. Collect now, decide in v3.

### Module 10 — Similar problem finder

Paste a Codeforces or LeetCode problem URL, get back problems built on the same ideas within a
difficulty range.

Settled:
- Scoring is IDF-weighted Jaccard over topic sets: intersection over union, each shared tag
  weighted by `log(N / count(t))` so a rare tag counts for more than a ubiquitous one. IDF
  precomputed, not recalculated per request.
- Candidates come from the `ProblemTopic` join — problems sharing at least one topic. Never a full
  catalog scan.
- Filter to a difficulty window, sort by score, tie-break on rating distance then problem id.
- **No embeddings, no model call.** If this starts reaching for semantic similarity it has left the
  design philosophy of the project.
- A URL not in the catalog says so plainly. No fuzzy fallback matching.

### Module 11 — Progress analytics

Charts over Module 8's log. Nothing here is hard once snapshots exist.

Settled:
- Trajectory per topic over time, bucketed daily at query time.
- Breakthrough detection is a deterministic rule, not a model: a topic crossing weak to strong and
  holding across at least two consecutive snapshots.
- Streaks are derived from `UserProblem` timestamps, not a stored counter. Counters drift; derived
  values don't.
- Gaps in history render as gaps. Never interpolate across an unlink.
- The empty state is real and needs handling — for the first weeks after Module 8 ships, every
  chart is nearly flat. Say "not enough history yet" rather than rendering a single sad point.

### Module 12 — Contest mode

Timed practice sets at a calibrated difficulty spread. Largest surface, most unresolved, ships last
so its problems block nothing else.

Settled:
- Problem selection reuses the recommendation engine with a contest profile — an easy/medium/hard
  spread instead of the study-oriented mix. Do not write a second selection algorithm.

Open at plan time:
- **Rating calibration only works for Codeforces.** LeetCode users have no rating. Either derive a
  target band from their mastery distribution, or require a linked CF account for rating-calibrated
  mode and offer band-based selection otherwise.
- **Real-time solve detection is not possible today** — sync is pull-based. Either the user
  self-reports during the session, or we poll the provider on an interval for its duration. Polling
  is more honest but is the project's first background-work problem and collides with the no-job-
  queue non-goal. Self-report is acceptable for a first version; this is a practice tool, not a
  judge.

### Cut and deferred

**Cut: community problem lists.** Sharing means public/private states, unauthenticated viewing,
moderation and spam, none of which make the coach better at coaching. It's a different product.

**Deferred to v3: agentic AI.** When it comes, the agent orchestrates *around* the deterministic
engine — it calls the recommender and acts on its output; it does not replace its judgment. An LLM
picking problems directly would undo the thing that makes this project worth having.

## Repo hygiene

- Commit directly to `main`. Do not create branches or open pull requests unless I explicitly
  ask for one. A branch is for a large, risky, multi-commit pass (like the v1 hardening) — not
  for routine module work.
- Style changes and behavior changes never share a commit.
- The frontend design system lives in `.claude/skills/trainer-design/SKILL.md`, gitignored. Read
  it before touching frontend styling rather than re-deriving the tokens.
