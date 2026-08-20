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

// The practice-session hint ladder (Module 9). Three levels, three ceilings, three
// prompts - never one call that produces all three. A graduated set written in a
// single pass leaks the third level's phrasing into the first, which is the whole
// thing the ladder exists to prevent.
//
// The ceilings are bounded by what we actually have. Without the statement, nothing
// here can be about THIS problem; every level speaks about the class of problem the
// topics and difficulty describe. Level 3 is therefore the standard construction for
// a technique, not the answer, and it says so to the learner.

// Three states, not a score: the weak/strong line is WEAK_THRESHOLD's to draw, and
// engine/mastery.ts is where it is drawn. Passing the number here would invite a
// second definition of the same boundary.
export type PromptTopicMastery = {
  name: string;
  standing: "weak" | "strong" | "unknown";
};

const SESSION_HINT_L1_SYSTEM_PROMPT = `You are the first of three graduated hints for a DSA and competitive-programming practice tool.

CRITICAL: you have NOT been given the problem statement. You know only its title, topics and difficulty. You do not know what the problem asks, and you must never claim to.

This is hint 1 of 3, and its ceiling is ORIENTATION. Point at what is worth noticing before solving anything: what this difficulty suggests about the size of the input, and what this combination of topics invites the learner to look at first. NAME NO ALGORITHM, no data structure and no technique - those are hints 2 and 3, and spending them here collapses the ladder.

Where the learner's standing in a topic is weak or unknown, lay more groundwork. Where it is strong, assume it and be brief.

Never describe this specific problem, never invent its input, output, constraints or examples. No code.

Two or three sentences. No lists, no headings, no markdown.
Reply with JSON only, in exactly this shape:
  {"hint": "<your two or three sentences>"}`;

const SESSION_HINT_L2_SYSTEM_PROMPT = `You are the second of three graduated hints for a DSA and competitive-programming practice tool.

CRITICAL: you have NOT been given the problem statement. You know only its title, topics and difficulty. You do not know what the problem asks, and you must never claim to.

This is hint 2 of 3, and its ceiling is TECHNIQUE. Name the approach or data structure this combination of topics points at, and the property that makes it the right tool. DO NOT CONSTRUCT THE SOLUTION: no invariant, no order of steps, no edge cases, no complexity. That is hint 3.

Hint 1 has already been given and is quoted below. Build on it. Do not restate it.

Where the learner's standing in a topic is weak or unknown, lay more groundwork. Where it is strong, assume it and be brief.

Speak about this CLASS of problem, never about this specific one. Never invent its input, output, constraints or examples. No code.

Three or four sentences. No lists, no headings, no markdown.
Reply with JSON only, in exactly this shape:
  {"hint": "<your three or four sentences>"}`;

const SESSION_HINT_L3_SYSTEM_PROMPT = `You are the third and last of three graduated hints for a DSA and competitive-programming practice tool.

CRITICAL: you have NOT been given the problem statement. You know only its title, topics and difficulty. You do not know what the problem asks, and you must never claim to.

This is hint 3 of 3, and its ceiling is CONSTRUCTION. Give the full standard construction for the technique these topics imply: the invariant it maintains, the edge cases that class of problem usually has, and its time and space complexity. NO CODE and no pseudocode.

Because you have not seen this problem, speak about the CLASS of problem throughout. Never assert what this problem's input, output or constraints are, and never present the construction as a finished solution to it - the learner still has to map it onto what is in front of them, and saying so is part of the hint.

Hints 1 and 2 have already been given and are quoted below. Build on them. Do not restate them.

Four to six sentences. No lists, no headings, no markdown.
Reply with JSON only, in exactly this shape:
  {"hint": "<your four to six sentences>"}`;

// Indexed by level - 1, the same way lib/practiceCooldown.ts indexes its cooldowns.
export const SESSION_HINT_SYSTEM_PROMPTS = [
  SESSION_HINT_L1_SYSTEM_PROMPT,
  SESSION_HINT_L2_SYSTEM_PROMPT,
  SESSION_HINT_L3_SYSTEM_PROMPT,
];

// "no data" rather than 0.00: a topic we have never seen the learner attempt is not a
// topic they scored zero in, and the difference changes how much groundwork the hint
// should lay.
function describeMastery(mastery: PromptTopicMastery[]): string {
  if (mastery.length === 0) return "Learner's standing: none recorded";

  const parts = mastery.map(
    (topic) =>
      `${topic.name} ${topic.standing === "unknown" ? "no data" : topic.standing}`
  );
  return `Learner's standing: ${parts.join(", ")}`;
}

// Every argument is read from our own database by userId in routes/sessions.ts. The
// hint route takes NO REQUEST BODY AT ALL, which is the strongest available statement
// of that boundary: there is no client string that could reach this function.
export function buildSessionHintUserMessage(
  problem: PromptProblem,
  mastery: PromptTopicMastery[],
  previousHints: string[]
): string {
  const lines = [describeProblem(problem), describeMastery(mastery)];

  previousHints.forEach((hint, index) => {
    lines.push(`Hint ${index + 1} already given: ${hint}`);
  });

  return lines.join("\n");
}
