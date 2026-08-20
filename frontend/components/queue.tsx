"use client";

import { motion } from "motion/react";
import { bandColorClass, providerTag } from "@/lib/format";
import { REORDER } from "@/lib/motion";
import type { Recommendation } from "@/lib/types";
import { AiAffordance } from "./explain";

// The engine's ranked list, rendered as a ledger. Three rules, all from the engine
// rather than from taste:
//
// 1. THE ORDER IS THE ENGINE'S AND IS NEVER TOUCHED. No sorting, no filtering, no
//    shuffle. Any client-side reordering would throw away the determinism that makes
//    the output testable, explainable and trustworthy.
// 2. The 01, 02, 03 markers encode rank, which is genuine information here - this is
//    a priority sequence, not a set.
// 3. `reason` is a line of the row, not a tooltip. It is also the ONLY explanation
//    available when the AI is off, which is a normal, supported configuration.

function QueueRow({ item, rank }: { item: Recommendation; rank: number }) {
  return (
    // `layout` animates a row to a new position if the list genuinely reorders after a
    // sync. Keyed on problemId so motion can tell a moved row from a replaced one.
    <motion.li layout transition={REORDER} className="border-rule border-b last:border-b-0">
      <div className="flex gap-4 py-4">
        <span className="t-data-xs text-quiet w-6 shrink-0 pt-1 text-right tabular-nums">
          {String(rank).padStart(2, "0")}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="t-body min-w-0 font-medium">
              {/* The title IS the link. A separate "Open" button would be a
                  second control for the same action, and the problem title is
                  the thing a person actually wants to click.
                  rel="noreferrer" because these go to third-party judges. */}
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="hover:underline hover:underline-offset-4"
              >
                {item.title}
                <span className="sr-only"> (opens on {item.provider})</span>
              </a>
            </h3>

            <span className="t-data-xs flex shrink-0 items-center gap-2">
              <span className="text-quiet">{providerTag(item.provider)}</span>
              {/* difficultyRaw IS WHAT IS DISPLAYED — "1600" for Codeforces,
                  "Medium" for LeetCode — because that is the provider's own
                  value and the one the user recognises. difficultyBand is used
                  ONLY to pick the colour. The UI never shows the band and the
                  engine never reads raw; honouring that split is the point of
                  storing both columns. */}
              <span className={bandColorClass(item.difficultyBand)}>
                {item.difficultyRaw}
              </span>
            </span>
          </div>

          <p className="t-body-sm text-ink mt-1">{item.reason}</p>

          {item.topics.length > 0 ? (
            <p className="t-data-xs text-quiet mt-1">{item.topics.join(" · ")}</p>
          ) : null}

          <AiAffordance problemId={item.problemId} variant="explain" />
        </div>
      </div>
    </motion.li>
  );
}

export function Queue({ items }: { items: Recommendation[] }) {
  return (
    <section aria-labelledby="queue-heading">
      <div className="mb-4">
        <h2 id="queue-heading" className="t-display">
          The Queue
        </h2>
        <p className="t-body-sm text-quiet mt-1">
          Ranked by the engine. The same history always produces the same list.
        </p>
        <p className="t-data-xs text-quiet mt-3 tracking-[0.1em] uppercase">
          {items.length} problem{items.length === 1 ? "" : "s"} · priority order
        </p>
      </div>

      <ol className="border-rule border-t">
        {items.map((item, index) => (
          <QueueRow key={item.problemId} item={item} rank={index + 1} />
        ))}
      </ol>
    </section>
  );
}
