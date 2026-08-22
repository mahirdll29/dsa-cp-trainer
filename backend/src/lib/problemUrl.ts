import { Provider } from "@prisma/client";
import { toExternalId as toCodeforcesExternalId } from "../providers/codeforces/mapping";
import { toExternalId as toLeetcodeExternalId } from "../providers/leetcode/mapping";

// Turns a pasted problem link into the (provider, externalId) pair the catalog uniques
// on. The two toExternalId functions above are IMPORTED rather than reimplemented: a
// string built here that spelled an id differently would miss a row that exists and
// report it as absent.

export type ParsedProblemUrl = { provider: Provider; externalId: string };

// ACMSGURU is its own outcome because those problems are not merely absent, they are
// unimportable - codeforces/mapping.ts drops every problem with no contestId.
export type UrlParseFailure = "UNRECOGNIZED" | "ACMSGURU";

export type UrlParseResult =
  | { ok: true; parsed: ParsedProblemUrl }
  | { ok: false; failure: UrlParseFailure };

const CONTEST_ID = /^\d+$/;

// Digits alone are a REAL index: contest 921 numbers its problems 01-14, and the
// catalog stores them as 92101-92114. Requiring a leading letter would make those rows
// permanently unreachable and nothing would report it.
const PROBLEM_INDEX = /^[A-Za-z0-9]{1,4}$/;

const TITLE_SLUG = /^[a-z0-9-]+$/;

function toUrl(input: string): URL | null {
  const trimmed = input.trim();
  try {
    return new URL(trimmed);
  } catch {
    // A bare host has no scheme, so the constructor above throws on it.
    try {
      return new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  }
}

function codeforcesPath(segments: string[]): UrlParseResult {
  if (segments[0] === "problemsets" && segments[1] === "acmsguru") {
    return { ok: false, failure: "ACMSGURU" };
  }

  let contestId: string | undefined;
  let index: string | undefined;

  if (segments[0] === "problemset" && segments[1] === "problem") {
    [contestId, index] = segments.slice(2, 4);
  } else if (
    (segments[0] === "contest" || segments[0] === "gym") &&
    segments[2] === "problem"
  ) {
    contestId = segments[1];
    index = segments[3];
  }

  if (!contestId || !index) return { ok: false, failure: "UNRECOGNIZED" };
  if (!CONTEST_ID.test(contestId) || !PROBLEM_INDEX.test(index)) {
    return { ok: false, failure: "UNRECOGNIZED" };
  }

  return {
    ok: true,
    parsed: {
      provider: Provider.CODEFORCES,
      externalId: toCodeforcesExternalId(Number(contestId), index.toUpperCase()),
    },
  };
}

function leetcodePath(segments: string[]): UrlParseResult {
  // Trailing segments are ignored, so /problems/two-sum/description/ and
  // /problems/two-sum/solutions/123 both resolve to the problem itself.
  if (segments[0] !== "problems" || !segments[1]) {
    return { ok: false, failure: "UNRECOGNIZED" };
  }

  const slug = segments[1].toLowerCase();
  if (!TITLE_SLUG.test(slug)) return { ok: false, failure: "UNRECOGNIZED" };

  return {
    ok: true,
    parsed: { provider: Provider.LEETCODE, externalId: toLeetcodeExternalId(slug) },
  };
}

export function parseProblemUrl(input: string): UrlParseResult {
  const url = toUrl(input);
  if (!url) return { ok: false, failure: "UNRECOGNIZED" };

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  // The query string and fragment are never read: URL keeps them out of pathname.
  const segments = url.pathname.split("/").filter(Boolean);

  if (host === "codeforces.com") return codeforcesPath(segments);
  if (host === "leetcode.com") return leetcodePath(segments);

  return { ok: false, failure: "UNRECOGNIZED" };
}
