import { Provider } from "@prisma/client";

// Every field comes from a Problem row or from the engine's own output. NOTHING here
// is supplied by the client - see routes/ai.ts.
export type PromptProblem = {
  title: string;
  provider: Provider;
  difficultyRaw: string;
  difficultyBand: string;
  topics: string[];
};

// EVERY PROMPT MUST STATE THAT THE PROBLEM STATEMENT WAS NOT PROVIDED. We do not
// store statements, and without the prohibition the model invents one: given only
// title "Unit Array" plus tags it described "adjusting each element to the nearest
// multiple of the target unit" - fluent, confident, and entirely fabricated. A
// hallucinated statement is the worst output this module can produce, so the rule is
// repeated in each prompt rather than kept in a shared preamble a new prompt could
// forget.

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

// Problem.title is provider data, and Codeforces GYM CONTESTS ARE USER-CREATABLE - gym
// problems reach our database through the user-sync path specifically. So the title is the
// one field in this prompt an outsider can influence. Collapsing it to a single line and
// bounding its length means it cannot open what looks like a new instruction block.
//
// The engine `reason` is server-derived and is the defence that matters; this closes the
// remaining gap rather than replacing it.
const MAX_TITLE_CHARS = 120;

function sanitizeTitle(title: string): string {
  const oneLine = title.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TITLE_CHARS
    ? `${oneLine.slice(0, MAX_TITLE_CHARS)}...`
    : oneLine;
}

function describeProblem(problem: PromptProblem): string {
  return [
    `Problem title: ${sanitizeTitle(problem.title)}`,
    `Provider: ${problem.provider}`,
    // Both difficulty columns: difficultyRaw is what a user recognises ("1600"),
    // difficultyBand is the only one comparable across providers.
    `Difficulty: ${problem.difficultyRaw} (${problem.difficultyBand})`,
    // Topic NAMES, not slugs - a slug is a database key and would leak into the prose.
    `Topics: ${problem.topics.length > 0 ? problem.topics.join(", ") : "none recorded"}`,
  ].join("\n");
}

// `reason` is ALWAYS a string the engine produced: routes/ai.ts re-runs the pipeline
// for the authenticated user and reads it off the matching recommendation. Accepting
// it from the request body would let any caller put arbitrary text in this slot and
// have the model explain a recommendation the engine never made.
export function buildExplainUserMessage(
  problem: PromptProblem,
  reason: string
): string {
  return `${describeProblem(problem)}\nEngine reason: ${reason}`;
}

export function buildHintUserMessage(problem: PromptProblem): string {
  return describeProblem(problem);
}
