import { UnmappedTagCounter } from "../../lib/unmappedTagCounter";

// ---------------------------------------------------------------------------
// LEETCODE TAG SLUG -> Topic.slug
//
// THE TABLE WAS BUILT FROM THE REAL CATALOG, NOT FROM MEMORY. Every row and
// every count below came from crawling all 41 pages of /problems while planning
// this module: 172 distinct tag slugs across the 3,240 free problems.
//
// THE HEADLINE FINDING, and it is the whole character of this file:
// 26 OF OUR 32 TOPIC SLUGS MATCH LEETCODE'S TAG SLUGS EXACTLY. prisma/seed.ts
// was evidently written with LeetCode's vocabulary in mind, and it shows.
//
// Contrast providers/codeforces/tags.ts: 38 Codeforces tags, ZERO exact
// matches, every single row hand-written, and several genuinely weak
// ("hashing" -> hash-table, "string suffix structures" -> trie).
//
// THE PART WORTH NOTICING: despite the vastly cleaner vocabulary, the OUTCOME
// is almost identical — 6.5% of LeetCode problems import with no topic versus
// 6.1% for Codeforces. A better-matched tag list does not eliminate the
// residue, because what is left over is ambiguous BY NATURE in both cases
// (see "deliberately unmapped" below). Measured, not assumed.
//
// TABLE SIZE WAS ALSO MEASURED. Mapping every one of the 172 tags takes 107
// rows and covers 92.7% of tag occurrences. Cutting to tags with >= 10
// occurrences takes 59 rows and covers 90.8% — and produces THE EXACT SAME 212
// untagged problems, with no topic losing coverage. The long tail buys
// literally nothing, so it is left to the unmapped log, which is precisely what
// that log is for.
// ---------------------------------------------------------------------------

// Dropped BY NAME rather than falling through the unmapped path. These are
// problem FORMATS or unrelated DOMAINS, not subject areas — there is no topic
// they should map to and no gap in our table to fix. Same reasoning as
// Codeforces' "*special", and the same purpose: if they landed in the
// unmapped log, every run would report the same non-actionable rows and the
// log would stop being read.
//
// `database` (SQL) and `shell` (bash) are not DSA at all. `design`
// ("design a data structure"), `data-stream`, `iterator`, `concurrency` and
// `interactive` describe the SHAPE of the question, not its subject.
// providers/codeforces/tags.ts made exactly this call about "interactive".
const IGNORED_TAGS: ReadonlySet<string> = new Set([
  "design", //        99
  "database", //      94
  "brainteaser", //   18
  "data-stream", //   16
  "concurrency", //    6
  "iterator", //       5
  "interactive", //    5
  "shell", //          4
]);

// Counts in the comments are occurrences among the 3,240 FREE problems at the
// time the table was written, so the next person can see which rows matter.
export const TAG_TO_TOPIC_SLUG: Readonly<Record<string, string>> = {
  // --- IDENTITY ROWS (26) ---------------------------------------------------
  //
  // The LeetCode tag slug is already our topic slug.
  //
  // WRITTEN OUT EXPLICITLY rather than handled with a rule like
  // `if (ourTopicSlugs.has(tag)) return tag`. That rule would be shorter and it
  // was rejected on purpose: this table is DATA you edit in response to a log
  // (the philosophy stated in providers/codeforces/tags.ts), and a rule would
  // silently change behaviour whenever prisma/seed.ts changes. Adding a topic
  // should never quietly re-tag 3,000 existing problems on the next sync.
  "hash-table": "hash-table", //                       701
  math: "math", //                                     598
  "dynamic-programming": "dynamic-programming", //     584
  sorting: "sorting", //                               453
  greedy: "greedy", //                                 421
  "binary-search": "binary-search", //                 292
  "depth-first-search": "depth-first-search", //       262
  "bit-manipulation": "bit-manipulation", //           259
  "prefix-sum": "prefix-sum", //                       236
  matrix: "matrix", //                                 233
  "two-pointers": "two-pointers", //                   212
  "breadth-first-search": "breadth-first-search", //   204
  simulation: "simulation", //                         193
  stack: "stack", //                                   147
  "sliding-window": "sliding-window", //               144
  backtracking: "backtracking", //                      94
  "number-theory": "number-theory", //                  93
  "union-find": "union-find", //                        82
  "segment-tree": "segment-tree", //                    69
  "linked-list": "linked-list", //                      66
  combinatorics: "combinatorics", //                    55
  queue: "queue", //                                    47
  trie: "trie", //                                      46
  recursion: "recursion", //                            42
  "shortest-path": "shortest-path", //                  33
  "binary-search-tree": "binary-search-tree", //        30

  // --- RENAMES AND PLURALS (6) ----------------------------------------------
  //
  // Mechanical, not judgment. LeetCode uses the singular where our seed uses
  // the plural. Guessing instead of checking would have silently lost the two
  // biggest tags in the entire catalog.
  array: "arrays", //                                 1879
  string: "strings", //                                758
  tree: "trees", //                                    198
  "heap-priority-queue": "heap", //                    183
  graph: "graphs", //                                  150
  "binary-tree": "trees", //                           130

  // --- JUDGMENT CALLS (27) --------------------------------------------------
  //
  // OUR LINE, drawn by us, in the same spirit as the Codeforces rating cutoffs
  // (architecture.md 2.2) and the mastery thresholds (engine/mastery.ts).
  // LeetCode publishes no mapping to anybody's taxonomy; reasonable people
  // would draw several of these elsewhere.

  // THE WEAKEST ROW IN THIS TABLE, and the direct counterpart of Module 4's
  // "hashing" -> hash-table. An ordered set IS balanced-BST-backed in
  // principle, but LeetCode problems carrying this tag are as often solved
  // with a Fenwick tree or a sorted container. Mapped anyway for the same
  // reason Module 4 mapped its weakest row: without it `binary-search-tree`
  // has only 30 problems, and the engine cannot recommend from a thin topic.
  "ordered-set": "binary-search-tree", //               64

  "monotonic-stack": "stack", //                        58

  // The SAME mapping Module 4 made for Codeforces' "divide and conquer".
  // Cross-provider consistency is the point: one topic must not mean two
  // different things depending on which importer wrote the row.
  "divide-and-conquer": "recursion", //                 58

  // Module 4 mapped Codeforces' "bitmasks" identically.
  bitmask: "bit-manipulation", //                       47

  // Memoization is top-down DP. The technique names the topic.
  memoization: "dynamic-programming", //                42

  // A Fenwick tree and a segment tree are the same range-query family, and
  // `segment-tree` is the only topic we have in it.
  "binary-indexed-tree": "segment-tree", //             35

  // Both are the polynomial/rolling-hash family. Same call Module 4 made
  // mapping Codeforces' "hashing" here — a string technique filed under a
  // dictionary-lookup topic because they share the underlying idea.
  "hash-function": "hash-table", //                     33
  "rolling-hash": "hash-table", //                      26

  // String algorithms. Filed under the subject rather than given their own
  // topics, which would each hold ten problems.
  "string-matching": "strings", //                      33
  "z-algorithm": "strings", //                          11
  "knuth-morris-pratt-algorithm": "strings", //         10

  // Graph algorithms and structures.
  "topological-sort": "graphs", //                      30
  "directed-acyclic-graph": "graphs", //                14

  // Number theory family — the cleanest group in the table.
  "greatest-common-divisor": "number-theory", //        24
  "euclidean-algorithm": "number-theory", //            22
  "prime-factorization": "number-theory", //            12
  "primality-test": "number-theory", //                 10
  "sieve-theory": "number-theory", //                   10
  "fermats-little-theorem": "number-theory", //         10

  "monotonic-queue": "queue", //                        23

  // DP variants. The TECHNIQUE wins over the STRUCTURE: "DP on trees" is
  // filed as dynamic-programming, not trees, because the difficulty of those
  // problems is the recurrence, not the tree.
  "dp-on-trees": "dynamic-programming", //              23
  "knapsack-problem": "dynamic-programming", //         16
  "longest-increasing-subsequence": "dynamic-programming", // 12

  // Bracket matching is the canonical stack problem.
  "bracket-sequences": "stack", //                      15

  dijkstra: "shortest-path", //                         12
  "merge-sort": "sorting", //                           11
  "doubly-linked-list": "linked-list", //               10
};

// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY *NOT* MAPPED, AND WHY
//
// Two tags dominate the unmapped log, and they are the exact analogue of
// Codeforces' "data structures" (2011) and "brute force" (1964):
//
//   counting      184 occurrences
//   enumeration   146 occurrences
//
// "counting" spans frequency maps, combinatorial counting and prefix counting
// at once. "enumeration" means "try all the possibilities", which is not our
// `recursion` and not our `backtracking`. Any single slug is wrong for most of
// the problems carrying either.
//
// THE SAME ASYMMETRY DECIDES IT as in Module 4: an unmapped tag costs
// visibility on one problem, but a WRONG tag corrupts a topic's mastery score
// for every user who touches it — and the mastery score is the product.
// Skipping wins.
//
// The rest are genuinely absent from our 32-topic list and would need a new
// Topic row rather than a mapping: geometry (40), game-theory (26),
// minimax-algorithm (15), randomized (12), zero-sum-game (12), sweep-line (6),
// probability-and-statistics (6), polygons (6), and a long tail below 5.
//
// MEASURED COVERAGE: this table maps 90.8% of tag occurrences and leaves 212
// of 3,240 free problems (6.5%) with no topic at all. Those problems are still
// IMPORTED — see mapTagsToSlugs.
//
// THE PAYOFF. Module 4 left 11 of our 32 topics with ZERO problems. Every one
// of them is filled here: arrays 1879, prefix-sum 236, breadth-first-search
// 204, heap 183, stack 147, sliding-window 144, backtracking 94,
// binary-search-tree 30+64, segment-tree 69+35, linked-list 66+10, queue 47+23.
//
// After this module, `constructive-algorithms` is the ONLY topic with no
// LeetCode coverage — and it has 2,079 Codeforces problems. All 32 topics are
// covered across the two providers, which also resolves the dead exploratory
// recommendation stage (session-handoff trap 16).
// ---------------------------------------------------------------------------

// Translate one problem's LeetCode tag slugs into our topic slugs.
//
// THE RULE THAT MATTERS, and it is a correctness rule rather than a nicety:
// an unmapped tag is SKIPPED, but THE PROBLEM IS STILL IMPORTED. A solve
// recorded against no topic still counts as a solve, still stops the engine
// recommending that problem again, and still shows in the user's history.
// Dropping the problem would lose the solve entirely, which is strictly worse.
// Identical rule to providers/codeforces/tags.ts.
export function mapTagsToSlugs(
  tagSlugs: string[],
  unmapped: UnmappedTagCounter
): string[] {
  const slugs = new Set<string>();

  for (const tag of tagSlugs) {
    if (IGNORED_TAGS.has(tag)) continue;

    const slug = TAG_TO_TOPIC_SLUG[tag];
    if (slug === undefined) {
      unmapped.record(tag);
      continue;
    }
    slugs.add(slug);
  }

  // A Set because several LeetCode tags map to the same slug — `tree` and
  // `binary-tree` both mean `trees`, and a problem tagged with both would
  // otherwise produce two identical ProblemTopic rows and violate its compound
  // primary key. Sorted so the write order is deterministic and two runs
  // produce identical batches.
  return [...slugs].sort();
}
