import { Provider } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { parseProblemUrl } from "./problemUrl";

const parsed = (input: string) => {
  const result = parseProblemUrl(input);
  if (!result.ok) throw new Error(`expected ${input} to parse, got ${result.failure}`);
  return result.parsed;
};

const failure = (input: string) => {
  const result = parseProblemUrl(input);
  if (result.ok) throw new Error(`expected ${input} to be rejected`);
  return result.failure;
};

describe("Codeforces URLs this accepts", () => {
  it("reads the problemset form", () => {
    expect(parsed("https://codeforces.com/problemset/problem/1234/A")).toEqual({
      provider: Provider.CODEFORCES,
      externalId: "1234A",
    });
  });

  it("reads the contest form", () => {
    expect(parsed("https://codeforces.com/contest/1234/problem/A").externalId).toBe(
      "1234A"
    );
  });

  it("reads the gym form", () => {
    expect(parsed("https://codeforces.com/gym/100001/problem/A").externalId).toBe(
      "100001A"
    );
  });

  it("uppercases a lowercase index so it matches the stored id", () => {
    expect(parsed("https://codeforces.com/contest/1234/problem/a").externalId).toBe(
      "1234A"
    );
  });

  it("accepts a purely numeric index", () => {
    // Contest 921 numbers its problems 01-14 and the catalog stores them as 92101-92114.
    // An index pattern requiring a leading letter makes those rows unreachable.
    expect(parsed("https://codeforces.com/contest/921/problem/01").externalId).toBe(
      "92101"
    );
    expect(parsed("https://codeforces.com/contest/921/problem/14").externalId).toBe(
      "92114"
    );
  });

  it("accepts a multi-character index", () => {
    expect(parsed("https://codeforces.com/contest/1234/problem/D10").externalId).toBe(
      "1234D10"
    );
    expect(parsed("https://codeforces.com/contest/1234/problem/A1").externalId).toBe(
      "1234A1"
    );
  });
});

describe("LeetCode URLs this accepts", () => {
  it("reads the bare problem form", () => {
    expect(parsed("https://leetcode.com/problems/two-sum/")).toEqual({
      provider: Provider.LEETCODE,
      externalId: "two-sum",
    });
  });

  it("ignores trailing segments", () => {
    expect(parsed("https://leetcode.com/problems/two-sum/description/").externalId).toBe(
      "two-sum"
    );
    expect(parsed("https://leetcode.com/problems/two-sum/solutions/123").externalId).toBe(
      "two-sum"
    );
  });

  it("lowercases a mixed-case slug", () => {
    expect(parsed("https://leetcode.com/problems/Two-Sum").externalId).toBe("two-sum");
  });
});

describe("what the parser tolerates around a URL", () => {
  it("strips a www prefix", () => {
    expect(parsed("https://www.codeforces.com/contest/1234/problem/A").externalId).toBe(
      "1234A"
    );
    expect(parsed("https://www.leetcode.com/problems/two-sum").externalId).toBe(
      "two-sum"
    );
  });

  it("accepts a bare host with no scheme", () => {
    expect(parsed("codeforces.com/contest/1234/problem/A").externalId).toBe("1234A");
  });

  it("accepts http as well as https", () => {
    expect(parsed("http://codeforces.com/contest/1234/problem/A").externalId).toBe(
      "1234A"
    );
  });

  it("trims surrounding whitespace", () => {
    expect(parsed("  https://leetcode.com/problems/two-sum/  ").externalId).toBe(
      "two-sum"
    );
  });

  it("ignores a query string and a fragment", () => {
    expect(
      parsed("https://leetcode.com/problems/two-sum/?envType=list#solution").externalId
    ).toBe("two-sum");
    expect(
      parsed("https://codeforces.com/contest/1234/problem/A?locale=ru").externalId
    ).toBe("1234A");
  });
});

describe("URLs this rejects", () => {
  it("reports acmsguru separately, because those problems are unimportable", () => {
    expect(failure("https://codeforces.com/problemsets/acmsguru/problem/99999/101")).toBe(
      "ACMSGURU"
    );
  });

  it("rejects an unrelated host", () => {
    expect(failure("https://atcoder.jp/contests/abc300/tasks/abc300_a")).toBe(
      "UNRECOGNIZED"
    );
    expect(failure("https://example.com/problems/two-sum")).toBe("UNRECOGNIZED");
  });

  it("rejects a non-numeric Codeforces contest id", () => {
    expect(failure("https://codeforces.com/contest/abcd/problem/A")).toBe("UNRECOGNIZED");
  });

  it("rejects an index longer than four characters", () => {
    expect(failure("https://codeforces.com/contest/1234/problem/ABCDE")).toBe(
      "UNRECOGNIZED"
    );
  });

  it("rejects a Codeforces path with no problem segment", () => {
    expect(failure("https://codeforces.com/contest/1234")).toBe("UNRECOGNIZED");
    expect(failure("https://codeforces.com/problemset")).toBe("UNRECOGNIZED");
    expect(failure("https://codeforces.com/")).toBe("UNRECOGNIZED");
  });

  it("rejects a LeetCode slug carrying characters the catalog never stores", () => {
    expect(failure("https://leetcode.com/problems/two_sum")).toBe("UNRECOGNIZED");
    expect(failure("https://leetcode.com/problems/two sum")).toBe("UNRECOGNIZED");
  });

  it("rejects a LeetCode path with no slug", () => {
    expect(failure("https://leetcode.com/problems/")).toBe("UNRECOGNIZED");
    expect(failure("https://leetcode.com/contest/weekly-380")).toBe("UNRECOGNIZED");
  });

  it("rejects input that is not a URL at all", () => {
    expect(failure("")).toBe("UNRECOGNIZED");
    expect(failure("   ")).toBe("UNRECOGNIZED");
    expect(failure("two-sum")).toBe("UNRECOGNIZED");
  });
});
