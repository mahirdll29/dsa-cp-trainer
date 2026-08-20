// Both providers tag problems with their own vocabulary and neither publishes a
// mapping to ours, so the mapping tables are built from REAL DATA: run an import,
// read the log of tags we had no row for, decide which deserve one, repeat. This is
// that feedback loop.

export class UnmappedTagCounter {
  private readonly counts = new Map<string, number>();

  record(tag: string): void {
    this.counts.set(tag, (this.counts.get(tag) ?? 0) + 1);
  }

  // Sorted by frequency: the most common unmapped tag is the one worth adding next.
  toSortedEntries(): { tag: string; count: number }[] {
    return [...this.counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  // Once per run with counts, never once per problem: a line per occurrence would be
  // 11,000 lines of "unmapped tag: geometry", and a log nobody reads is no log at all.
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
