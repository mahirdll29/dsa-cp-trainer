import { describe, expect, it } from "vitest";
import { EXHAUSTED_MESSAGE, evaluateHintGate, MAX_HINT_LEVEL } from "./practiceCooldown";

const START = new Date("2026-03-01T12:00:00Z");
const MINUTE = 60_000;

const after = (from: Date, minutes: number) =>
  new Date(from.getTime() + minutes * MINUTE);

describe("which level the gate offers", () => {
  it("offers level 1 when no hint has been issued", () => {
    const gate = evaluateHintGate(START, [], after(START, 10));
    expect(gate).toEqual({ state: "READY", level: 1 });
  });

  it("offers the next level after each issued hint", () => {
    const first = after(START, 10);
    const second = after(first, 10);
    expect(evaluateHintGate(START, [first], after(first, 10))).toEqual({
      state: "READY",
      level: 2,
    });
    expect(evaluateHintGate(START, [first, second], after(second, 15))).toEqual({
      state: "READY",
      level: 3,
    });
  });

  it("is exhausted once all three have been issued, however long the user waits", () => {
    const issued = [START, START, START];
    expect(evaluateHintGate(START, issued, after(START, 10_000))).toEqual({
      state: "EXHAUSTED",
      message: EXHAUSTED_MESSAGE,
    });
  });

  it("stays exhausted past the maximum rather than offering a fourth level", () => {
    const issued = new Array(MAX_HINT_LEVEL + 2).fill(START);
    expect(evaluateHintGate(START, issued, after(START, 10_000)).state).toBe("EXHAUSTED");
  });
});

describe("what the cooldown is measured from", () => {
  it("measures level 1 from the session start", () => {
    expect(evaluateHintGate(START, [], after(START, 9)).state).toBe("COOLDOWN");
    expect(evaluateHintGate(START, [], after(START, 10)).state).toBe("READY");
  });

  it("measures level 2 from the first hint, not from the session start", () => {
    // A session opened hours ago whose first hint landed a minute ago is still on
    // cooldown: the clock restarts on each reveal instead of running down unread.
    const issuedAt = after(START, 180);
    const gate = evaluateHintGate(START, [issuedAt], after(issuedAt, 1));
    expect(gate.state).toBe("COOLDOWN");
  });

  it("measures level 3 from the second hint", () => {
    const first = after(START, 10);
    const second = after(first, 10);
    expect(evaluateHintGate(START, [first, second], after(second, 14)).state).toBe(
      "COOLDOWN"
    );
    expect(evaluateHintGate(START, [first, second], after(second, 15)).state).toBe(
      "READY"
    );
  });
});

describe("the boundary at exactly the cooldown duration", () => {
  it("releases at exactly ten minutes, not a millisecond later", () => {
    const exactly = new Date(START.getTime() + 10 * MINUTE);
    expect(evaluateHintGate(START, [], exactly)).toEqual({ state: "READY", level: 1 });
  });

  it("holds one millisecond short and reports one second remaining", () => {
    const justShort = new Date(START.getTime() + 10 * MINUTE - 1);
    const gate = evaluateHintGate(START, [], justShort);
    expect(gate.state).toBe("COOLDOWN");
    if (gate.state === "COOLDOWN") {
      expect(gate.secondsRemaining).toBe(1);
    }
  });

  it("walks the whole 10 / 10 / 15 schedule on an injected clock", () => {
    const first = new Date(START.getTime() + 10 * MINUTE);
    const second = new Date(first.getTime() + 10 * MINUTE);
    const third = new Date(second.getTime() + 15 * MINUTE);

    expect(evaluateHintGate(START, [], first).state).toBe("READY");
    expect(evaluateHintGate(START, [first], second).state).toBe("READY");
    expect(evaluateHintGate(START, [first, second], third).state).toBe("READY");
    expect(
      evaluateHintGate(START, [first, second], new Date(third.getTime() - 1)).state
    ).toBe("COOLDOWN");
  });
});

describe("what a held gate reports", () => {
  it("always rounds the remaining seconds up, so it never shows zero while holding", () => {
    for (const millisShort of [1, 500, 999, 1000, 60_001]) {
      const now = new Date(START.getTime() + 10 * MINUTE - millisShort);
      const gate = evaluateHintGate(START, [], now);
      expect(gate.state).toBe("COOLDOWN");
      if (gate.state === "COOLDOWN") {
        expect(gate.secondsRemaining).toBeGreaterThan(0);
        expect(gate.secondsRemaining).toBe(Math.ceil(millisShort / 1000));
      }
    }
  });

  it("never reports negative seconds for a clock behind the session start", () => {
    const gate = evaluateHintGate(START, [], new Date(START.getTime() - 5 * MINUTE));
    expect(gate.state).toBe("COOLDOWN");
    if (gate.state === "COOLDOWN") {
      expect(gate.secondsRemaining).toBe(15 * 60);
    }
  });

  it("carries a different fixed message per level and never interpolates the clock", () => {
    const first = after(START, 10);
    const second = after(first, 10);
    const messages = [
      evaluateHintGate(START, [], START),
      evaluateHintGate(START, [first], first),
      evaluateHintGate(START, [first, second], second),
    ].map((gate) => (gate.state === "COOLDOWN" ? gate.message : ""));

    expect(new Set(messages).size).toBe(3);
    for (const message of messages) {
      expect(message).not.toMatch(/\d/);
    }
  });
});
