// ---------------------------------------------------------------------------
// CODEFORCES TAG -> Topic.slug
//
// Codeforces tags its problems with its own vocabulary ("dp", "dsu",
// "sortings"). Our canonical topic list lives in prisma/seed.ts and uses our
// own slugs ("dynamic-programming", "union-find", "sorting"). This file is the
// translation layer, and it is deliberately DATA rather than logic: it gets
// edited in response to the unmapped-tag log below, not reasoned about from
// first principles.
//
// It is a separate file from client.ts because it has two callers (catalog sync
// and user sync) and because a table you edit from real logs should not be
// buried inside a file full of HTTP plumbing.
//
// THE TABLE WAS BUILT FROM THE REAL PROBLEMSET, NOT FROM MEMORY. Every tag and
// count below came from one call to problemset.problems: 38 distinct tags
// across 11,051 rated problems. Guessing the vocabulary would have produced
// "sorting" (CF says "sortings"), "dynamic programming" (CF says "dp") and
// "union find" (CF says "dsu") — three silent misses.
//
// MODULE 5 NOTE: UnmappedTagCounter used to be defined in this file. It moved
// to lib/unmappedTagCounter.ts once LeetCode became a second caller — it has no
// provider-specific behaviour, and the LeetCode module importing it from HERE
// would have coupled the two providers together for no reason.
// ---------------------------------------------------------------------------

import { UnmappedTagCounter } from "../../lib/unmappedTagCounter";

// Dropped BY NAME rather than falling through the unmapped path. "*special" is
// Codeforces' marker for problems with unusual judging, not a subject area, so
// it is not a gap in our table and must never appear in the "improve this"
// log — otherwise every run would report the same 371 non-actionable hits and
// the log would stop being read.
const IGNORED_TAGS: ReadonlySet<string> = new Set(["*special"]);

// The counts in the comments are occurrences among rated problems at the time
// the table was written. They are here so the next person can see at a glance
// which rows actually matter.
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

  // --- Judgment calls -------------------------------------------------------
  //
  // These are OUR LINE, drawn by us, in exactly the same spirit as the
  // Codeforces rating cutoffs in architecture.md 2.2 and the difficulty
  // thresholds in engine/mastery.ts. Codeforces publishes no mapping to
  // anybody's topic taxonomy; reasonable people would draw these elsewhere.

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

// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY *NOT* MAPPED, AND WHY IT MATTERS
//
// Two big tags are left unmapped on purpose, and they are big enough that
// skipping them is a real decision rather than an oversight:
//
//   data structures   2011 occurrences
//   brute force       1964 occurrences
//
// "data structures" spans heaps, sets, BITs, stacks and segment trees at once,
// so any single slug is wrong for most of its problems. "brute force" on
// Codeforces usually means iterative enumeration, which is not our `recursion`
// and not our `backtracking`.
//
// Measured both ways against the real problemset before deciding:
//
//   this table (both unmapped)                 -> 676 problems (6.1%) with no topic, 25,663 links
//   + brute force->recursion, ds->segment-tree -> 435 problems (3.9%) with no topic, 29,574 links
//
// Mapping them recovers 241 problems' visibility at the cost of ~3,900 links
// that are wrong more often than right. THE ASYMMETRY DECIDES IT: an unmapped
// tag costs visibility on one problem, but a WRONG tag corrupts a topic's
// mastery score for every user who touches it — and the mastery score is the
// product. Skipping wins.
//
// The rest are genuinely absent from our 32-topic list and would need a new
// Topic row, not a mapping: geometry (420), games (298), interactive (284),
// probabilities (268), flows (160), fft (112), graph matchings (104),
// ternary search (69), meet-in-the-middle (51), 2-sat (41), expression parsing
// (35), chinese remainder theorem (25), schedules (15), communication (4).
// "interactive" is a problem FORMAT rather than a subject and should never be
// mapped.
//
// MEASURED COVERAGE: 21 of our 32 topics get Codeforces problems. The eleven
// that get none — arrays, sliding-window, prefix-sum, stack, queue, linked-list,
// backtracking, binary-search-tree, heap, breadth-first-search, segment-tree —
// are all LeetCode-shaped, and Module 5 fills them. That is safe rather than
// broken: engine/recommend.ts guards its exploratory stage with
// `if (candidate) add(...)`, so a topic with no candidates contributes nothing.
// ---------------------------------------------------------------------------

// Translate one problem's Codeforces tags into our topic slugs.
//
// THE RULE THAT MATTERS, and it is a correctness rule rather than a nicety:
// an unmapped tag is SKIPPED, but the PROBLEM IS STILL IMPORTED. A solve
// recorded against no topic still counts as a solve, still blocks the engine
// from recommending that problem again, and still shows in the user's history.
// Losing the solve entirely — which is what dropping the problem would do — is
// strictly the worse failure.
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

  // A Set because two Codeforces tags can map to the same slug, and
  // ProblemTopic has a compound primary key that a duplicate pair would
  // violate. Sorted so the write order is deterministic and two runs produce
  // identical batches.
  return [...slugs].sort();
}
