import { UnmappedTagCounter } from "../../lib/unmappedTagCounter";

// LeetCode tag slug -> Topic.slug. Data, not logic: this table is edited in response
// to the unmapped-tag log, not reasoned about from first principles.
//
// 26 of our 32 topic slugs match LeetCode's tag slugs exactly, because seed.ts was
// written with LeetCode's vocabulary in mind. Contrast providers/codeforces/tags.ts:
// 38 tags, zero exact matches, every row hand-written.

// Dropped by name rather than through the unmapped path: these are problem FORMATS or
// unrelated domains (database, shell, design, concurrency), not subject areas. There
// is no topic they should map to and no gap in our table to fix, so letting them
// reach the improvement log would train us to ignore it.
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

// Counts are occurrences among the 3,240 free problems when the table was written.
export const TAG_TO_TOPIC_SLUG: Readonly<Record<string, string>> = {
  // --- Identity rows: our slug already matches LeetCode's (26) ---
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

  // --- Renames and plurals (6) ---
  array: "arrays", //                                 1879
  string: "strings", //                                758
  tree: "trees", //                                    198
  "heap-priority-queue": "heap", //                    183
  graph: "graphs", //                                  150
  "binary-tree": "trees", //                           130

  // --- Judgment calls: our line, drawn by us (27) ---

  // The weakest row in this table: LeetCode's "string-matching" is KMP/Z-algorithm
  // territory, filed under trie only because that is the nearest structural topic.
  "ordered-set": "binary-search-tree", //               64

  "monotonic-stack": "stack", //                        58

  // The same mapping Module 4 made for Codeforces' "divide and conquer".
  "divide-and-conquer": "recursion", //                 58

  // Module 4 mapped Codeforces' "bitmasks" identically.
  bitmask: "bit-manipulation", //                       47

  // Memoization is top-down DP. The technique names the topic.
  memoization: "dynamic-programming", //                42

  // A Fenwick tree and a segment tree are the same range-query family for our purposes.
  "binary-indexed-tree": "segment-tree", //             35

  // Both are the polynomial/rolling-hash family.
  "hash-function": "hash-table", //                     33
  "rolling-hash": "hash-table", //                      26

  // Filed under the subject rather than the technique.
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

  // DP variants: the TECHNIQUE wins over the STRUCTURE.
  "dp-on-trees": "dynamic-programming", //              23
  "knapsack-problem": "dynamic-programming", //         16
  "longest-increasing-subsequence": "dynamic-programming", // 12

  // Bracket matching is the canonical stack problem.
  "bracket-sequences": "stack", //                      15

  dijkstra: "shortest-path", //                         12
  "merge-sort": "sorting", //                           11
  "doubly-linked-list": "linked-list", //               10
};

// DELIBERATELY UNMAPPED, and this is a decision rather than an oversight. The
// leftovers are ambiguous BY NATURE - the same finding as Codeforces, despite a far
// cleaner vocabulary: 6.5% of LeetCode problems import with no topic against 6.1%
// for Codeforces. The asymmetry decides it: an unmapped tag costs visibility on one
// problem, a WRONG tag corrupts a topic's mastery score for every user who touches
// it - and mastery is the product.
//
// Table size was measured too: mapping all 172 tags takes 107 rows and covers 92.7%
// of occurrences; cutting to tags with >= 10 occurrences takes 59 rows, covers 90.8%,
// and produces THE EXACT SAME 212 untagged problems. The long tail buys nothing.

// An unmapped tag is skipped but THE PROBLEM IS STILL IMPORTED. A solve recorded
// against no topic still blocks the engine from recommending it again; dropping the
// problem would lose the solve entirely, which is strictly worse.
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

  // A Set because several LeetCode tags map to one slug - `tree` and `binary-tree` both
  // mean `trees` - and a duplicate pair would violate ProblemTopic's compound primary
  // key. Sorted so writes are deterministic.
  return [...slugs].sort();
}
