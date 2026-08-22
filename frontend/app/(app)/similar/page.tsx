"use client";

import { SimilarFinder } from "@/components/similar-finder";

// Paste a problem, get problems built on the same ideas. The ranking is topic overlap
// weighted by rarity and it happens entirely on the server - this page submits a URL
// and renders the order it gets back.

export default function SimilarPage() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
      <h1 className="t-display">Adjacent</h1>
      <p className="t-body-sm text-quiet mt-1 max-w-prose">
        Paste a problem you have just worked through and get the ones built on the same
        ideas. A shared rare topic counts for far more than a shared common one, which
        is the whole difference between a ranking and a list.
      </p>

      <div className="mt-6">
        <SimilarFinder />
      </div>
    </main>
  );
}
