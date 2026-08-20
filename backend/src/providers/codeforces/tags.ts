import { UnmappedTagCounter } from "../../lib/unmappedTagCounter";

// Dropped by name rather than through the unmapped path: "*special" marks unusual
// judging, not a subject area, so it is not a gap in our table and must never appear
// in the improvement log.
const IGNORED_TAGS: ReadonlySet<string> = new Set(["*special"]);

// Counts are occurrences among rated problems when the table was written, so the next
// person can see which rows matter.
export const TAG_TO_TOPIC_SLUG: Readonly<Record<string, string>> = {
  // --- Direct matches: same concept, different spelling ---------------------
  greedy: "greedy", //                              3518
  math: "math", //                                  3438
  dp: "dynamic-programming", //                     2496
  "constructive algorithms": "constructive-algorithms", // 2079
  "binary search": "binary-search", //              1278
  sortings: "sorting", //                           1231  (note CF's plural)
  graphs: "graphs", //                              1200
  trees: "trees", //                                 957
  "number theory": "number-theory", //               887
  combinatorics: "combinatorics", //                 830
  strings: "strings", //                             802
  bitmasks: "bit-manipulation", //                   702
  "two pointers": "two-pointers", //                 645
  dsu: "union-find", //                              412  (same structure, different name)
  "shortest paths": "shortest-path", //              293
  matrices: "matrix", //                             137

  // --- Judgment calls: our line, drawn by us. CF publishes no mapping to any
  // topic taxonomy, and reasonable people would draw these elsewhere. -------

  // CF's "implementation" means "no clever algorithm — just carefully code what
  // the statement describes". That is precisely what our `simulation` topic is.
  implementation: "simulation", //                  3001

  // CF lumps DFS, BFS and flood fill under ONE tag. We file it under DFS
  // because the tag names DFS.
  // COST: `breadth-first-search` gets zero Codeforces coverage, and a pure BFS
  // problem is filed as DFS.
  "dfs and similar": "depth-first-search", //       1061

  // Divide and conquer is recursion with a merge step, and `recursion` is the
  // only topic we have that can host it.
  "divide and conquer": "recursion", //              358

  // THE WEAKEST ROW IN THIS TABLE. CF's "hashing" means polynomial/rolling
  // hashing — a string technique. Our `hash-table` means dictionary lookup.
  // Different techniques that share an underlying idea (a hash function turning
  // a comparison into O(1)).
  // Mapped anyway because leaving it out gives `hash-table` zero Codeforces
  // problems, and the engine cannot recommend from an empty topic.
  hashing: "hash-table", //                          237

  // SECOND WEAKEST. Suffix arrays and suffix automata are NOT tries. They are
  // the same "string index structure" family, and `trie` is the only topic we
  // have in that family.
  "string suffix structures": "trie", //             101
};

// An unmapped tag is skipped but THE PROBLEM IS STILL IMPORTED. A solve recorded
// against no topic still blocks the engine from recommending it again; dropping the
// problem would lose the solve entirely, which is strictly worse.
export function mapTagsToSlugs(
  tags: string[],
  unmapped: UnmappedTagCounter
): string[] {
  const slugs = new Set<string>();

  for (const tag of tags) {
    if (IGNORED_TAGS.has(tag)) continue;

    const slug = TAG_TO_TOPIC_SLUG[tag];
    if (slug === undefined) {
      unmapped.record(tag);
      continue;
    }
    slugs.add(slug);
  }

  // A Set because two Codeforces tags can map to one slug, and a duplicate pair would
  // violate ProblemTopic's compound primary key. Sorted so writes are deterministic.
  return [...slugs].sort();
}
