"use client";

import Link from "next/link";
import { Plate } from "./plate";

// The shared frame for /login and /register: Plate I on one side, the form on the
// other. Both pages carry the plate because it is the first thing a visitor sees and
// it shows the product's actual output rather than a marketing illustration.

export function AuthShell({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <main className="grid min-h-svh grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      {/* --- the plate --- */}
      <section
        className="border-rule bg-surface hidden items-center justify-center border-r p-10 lg:flex"
        aria-label="Plate I — The Spread"
      >
        <Plate className="max-h-[88svh] w-full max-w-[34rem]" />
      </section>

      {/* --- the form --- */}
      <section className="flex flex-col justify-center px-6 py-12 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <p className="t-eyebrow">Trainer</p>
          <h1 className="t-display mt-3">{title}</h1>
          <p className="t-body-sm text-quiet mt-2">{intro}</p>

          <div className="mt-8">{children}</div>

          <p className="t-body-sm text-quiet mt-8">{footer}</p>
        </div>
      </section>
    </main>
  );
}

// One link style, defined once so the two auth pages cannot drift.
export function AuthLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-ink underline underline-offset-4 hover:no-underline">
      {children}
    </Link>
  );
}
