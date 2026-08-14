// ---------------------------------------------------------------------------
// UNMAPPED TAG COUNTER — provider-agnostic.
//
// MOVED HERE IN MODULE 5. It was written in providers/codeforces/tags.ts and
// lived there quite correctly while there was one provider. Now there are two,
// and the alternatives were both worse:
//
//   - providers/leetcode/tags.ts imports from providers/codeforces/tags.ts.
//     That makes LeetCode depend on Codeforces for no reason and breaks
//     CLAUDE.md's "one module per provider" isolation rule the moment somebody
//     deletes or rewrites the Codeforces module.
//   - Duplicate the class. Twenty-five lines of identical bookkeeping in two
//     places, which then drift.
//
// So it moves to lib/, which is where things with no provider opinion live.
// This is the SECOND-CALLER TEST from CLAUDE.md applied literally: it did not
// deserve extraction with one caller, and it does with two. Nothing about the
// code changed — only where it sits.
//
// WHAT IT IS FOR. Both providers tag their problems with their own vocabulary,
// and neither publishes a mapping to ours. The mapping tables are therefore
// built from REAL DATA rather than from memory: run an import, read the log of
// tags we had no row for, decide which ones deserve a row, repeat. This class
// is that feedback loop.
// ---------------------------------------------------------------------------

export class UnmappedTagCounter {
  private readonly counts = new Map<string, number>();

  record(tag: string): void {
    this.counts.set(tag, (this.counts.get(tag) ?? 0) + 1);
  }

  // Sorted by frequency: the most common unmapped tag is the one worth adding
  // a topic for next.
  toSortedEntries(): { tag: string; count: number }[] {
    return [...this.counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  // Reported ONCE PER RUN with counts, never once per problem. A log line per
  // occurrence would be 11,000 lines of "unmapped tag: geometry" for the
  // Codeforces catalog, which is not a log anybody reads — and a log nobody
  // reads is the same as no log at all.
  log(label: string): void {
    const entries = this.toSortedEntries();
    if (entries.length === 0) {
      console.log(`[${label}] no unmapped tags`);
      return;
    }
    console.log(`[${label}] unmapped tags (${entries.length} distinct):`);
    for (const { tag, count } of entries) {
      console.log(`    ${String(count).padStart(6)}  ${tag}`);
    }
  }
}
