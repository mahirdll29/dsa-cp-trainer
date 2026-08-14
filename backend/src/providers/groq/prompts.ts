// ---------------------------------------------------------------------------
// EVERY PROMPT IN THE PROJECT LIVES HERE. None is inlined in a handler.
//
// Prompt wording is a DESIGN DECISION, not an implementation detail: it is the
// only thing standing between "explain this recommendation" and a model that
// confidently describes a problem it has never seen. Keeping the prompts in one
// file means they can be read, reviewed and changed as a set, the way the tag
// tables in providers/*/tags.ts are.
//
// Every prompt below does four things:
//   1. states the role,
//   2. constrains the output shape explicitly,
//   3. FORBIDS inventing problem details it was not given,
//   4. stays short — these are sent on every single call, so every extra
//      sentence is a permanent tax on latency and tokens.
// ---------------------------------------------------------------------------

import { Provider } from "@prisma/client";

// The fields every prompt is built from. All of them come from a `Problem` row
// or from the engine's own output — NOTHING here is supplied by the client. See
// routes/ai.ts for why that matters.
export type PromptProblem = {
  title: string;
  provider: Provider;
  difficultyRaw: string;
  difficultyBand: string;
  topics: string[];
};

// ---------------------------------------------------------------------------
// WHY EVERY PROMPT SAYS "YOU HAVE NOT BEEN GIVEN THE PROBLEM STATEMENT".
//
// We do not store problem statements. Problem has title, url, difficultyRaw,
// difficultyBand and topics via ProblemTopic — no statement text (and the
// providers are asymmetric anyway: the Codeforces API does not return one at
// all, LeetCode's /select does, and fetching it live would spend the wrapper's
// 120-per-hour quota on a cosmetic feature).
//
// SO THE MODEL WILL INVENT ONE UNLESS TOLD NOT TO. This is not a hypothetical.
// Verified during planning against this exact model, given only
// `title: "Unit Array", topics: greedy+math, difficulty 800`, it produced:
//
//     "...adjusting each element to the nearest multiple of the target unit
//      without overshooting"
//
// — a completely fabricated description of what the problem asks. Fluent,
// confident, wrong, and indistinguishable from a real one to a learner who has
// not opened the problem yet. A hallucinated problem statement is the worst
// output this module can produce, so the prohibition is stated in every prompt
// rather than once in a shared preamble that a future prompt might forget.
// ---------------------------------------------------------------------------

export const EXPLAIN_SYSTEM_PROMPT = `You are a study coach for a DSA and competitive-programming practice tool.

A deterministic recommendation engine has already decided this problem should be practised next, and produced a short machine-generated reason. Your only job is to restate that reason for the learner in two or three plain sentences.

RULES
- The engine's decision is final. Never question it, never suggest a different problem, never imply the recommendation might be wrong.
- You have been given ONLY the problem's title, topics and difficulty. You have NOT been given the problem statement. Never describe what the problem asks, never name the algorithm that solves it, never invent constraints, inputs or examples.
- No hints and no solution approach. That is a different feature.
- Two or three sentences. No lists, no headings, no markdown.
- Reply with JSON only, in exactly this shape:
  {"explanation": "<your two or three sentences>"}`;

export const HINT_SYSTEM_PROMPT = `You are a hint generator for a DSA and competitive-programming practice tool.

CRITICAL: you have NOT been given the problem statement. You know only its title, topics and difficulty. You do not know what the problem asks.

Give a TOPIC-LEVEL nudge: what to think about when facing a problem of this difficulty in these topics, and what question to ask yourself first. Never describe this specific problem, never invent its input, output, constraints or examples, and never claim to know what it asks. Never give a full solution and never give code.

Two or three sentences. No lists, no headings, no markdown.
Reply with JSON only, in exactly this shape:
  {"hint": "<your two or three sentences>"}`;

// ---------------------------------------------------------------------------
// USER MESSAGES.
//
// Deliberately a flat list of labelled lines rather than JSON or prose. Labelled
// lines are unambiguous to the model, cost fewer tokens than nested JSON, and
// stay readable in a log — which matters, because when an explanation comes out
// wrong the first question is always "what exactly did we send?".
// ---------------------------------------------------------------------------

function describeProblem(problem: PromptProblem): string {
  return [
    `Problem title: ${problem.title}`,
    `Provider: ${problem.provider}`,
    // Both difficulty columns are shown because they say different things.
    // difficultyRaw is the provider's own value ("1600", "Medium") and is what
    // a user recognises; difficultyBand is our normalized EASY/MEDIUM/HARD and
    // is the only one comparable across the two providers. architecture.md 2.2
    // keeps them separate for exactly this reason, and the prompt benefits from
    // both: "800 (EASY)" tells the model more than either half alone.
    `Difficulty: ${problem.difficultyRaw} (${problem.difficultyBand})`,
    // Topic NAMES, not slugs. "Dynamic Programming" reads as English;
    // "dynamic-programming" is a database key and would leak into the prose.
    `Topics: ${problem.topics.length > 0 ? problem.topics.join(", ") : "none recorded"}`,
  ].join("\n");
}

// THE REASON SLOT IS THE WHOLE SECURITY STORY OF THIS MODULE.
//
// `reason` here is ALWAYS a string the engine produced — routes/ai.ts obtains it
// by re-running buildRecommendations() for the authenticated user and reading
// the reason off the matching recommendation. It is never taken from the request
// body.
//
// The obvious API, POST /api/ai/explain { problemId, reason }, would let any
// caller put arbitrary text into this exact position and have the model explain
// a recommendation the engine never made. The boundary would still be documented
// and would be gone in practice: the AI would be explaining the CLIENT's claim
// while looking exactly like it was explaining the engine's.
//
// The real strings this receives, from engine/recommend.ts:
//   "due for revision"              "unfinished attempt in <Topic>"
//   "weak in <Topic>"               "unfinished attempt"
//   "new topic: <Topic>"            "starting point: <Topic>"
export function buildExplainUserMessage(
  problem: PromptProblem,
  reason: string
): string {
  return `${describeProblem(problem)}\nEngine reason: ${reason}`;
}

export function buildHintUserMessage(problem: PromptProblem): string {
  return describeProblem(problem);
}
