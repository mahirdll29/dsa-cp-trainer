import prisma from "../src/lib/prisma";

// The canonical topic list. Slugs are the stable identifier the provider importers
// map their own tag vocabularies onto; names are for display.
const TOPICS = [
  { name: "Arrays", slug: "arrays" },
  { name: "Strings", slug: "strings" },
  { name: "Hash Table", slug: "hash-table" },
  { name: "Two Pointers", slug: "two-pointers" },
  { name: "Sliding Window", slug: "sliding-window" },
  { name: "Prefix Sum", slug: "prefix-sum" },
  { name: "Binary Search", slug: "binary-search" },
  { name: "Sorting", slug: "sorting" },
  { name: "Stack", slug: "stack" },
  { name: "Queue", slug: "queue" },
  { name: "Linked List", slug: "linked-list" },
  { name: "Recursion", slug: "recursion" },
  { name: "Backtracking", slug: "backtracking" },
  { name: "Trees", slug: "trees" },
  { name: "Binary Search Tree", slug: "binary-search-tree" },
  { name: "Heap", slug: "heap" },
  { name: "Graphs", slug: "graphs" },
  { name: "Breadth First Search", slug: "breadth-first-search" },
  { name: "Depth First Search", slug: "depth-first-search" },
  { name: "Shortest Path", slug: "shortest-path" },
  { name: "Union Find", slug: "union-find" },
  { name: "Dynamic Programming", slug: "dynamic-programming" },
  { name: "Greedy", slug: "greedy" },
  { name: "Bit Manipulation", slug: "bit-manipulation" },
  { name: "Math", slug: "math" },
  { name: "Number Theory", slug: "number-theory" },
  { name: "Combinatorics", slug: "combinatorics" },
  { name: "Trie", slug: "trie" },
  { name: "Segment Tree", slug: "segment-tree" },
  { name: "Matrix", slug: "matrix" },
  { name: "Simulation", slug: "simulation" },
  { name: "Constructive Algorithms", slug: "constructive-algorithms" },
];

async function main() {
  // upsert on slug, not create: the seed must be safe to re-run.
  for (const topic of TOPICS) {
    await prisma.topic.upsert({
      where: { slug: topic.slug },
      update: { name: topic.name }, // allows renaming a topic for display
      create: topic,
    });
  }

  const count = await prisma.topic.count();
  console.log(`Seeded topics. Topic rows in database: ${count}`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
