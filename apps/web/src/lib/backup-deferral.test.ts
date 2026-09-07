import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DEFERRAL_HOURS,
  decideDeferral,
  resolveMaxDeferralHours
} from "./backup-deferral";

const NOW = new Date("2026-09-07T12:00:00.000Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

describe("decideDeferral", () => {
  it("defers when the last success is recent", () => {
    const decision = decideDeferral({ lastSuccessAt: hoursAgo(2), now: NOW });
    expect(decision.action).toBe("defer");
  });

  it("defers right up to the limit", () => {
    const decision = decideDeferral({ lastSuccessAt: hoursAgo(DEFAULT_MAX_DEFERRAL_HOURS), now: NOW });
    expect(decision.action).toBe("defer");
  });

  it("escalates once past the limit, so a stale repo lock cannot hide forever", () => {
    const decision = decideDeferral({ lastSuccessAt: hoursAgo(DEFAULT_MAX_DEFERRAL_HOURS + 1), now: NOW });
    expect(decision.action).toBe("escalate");
    if (decision.action === "escalate") {
      expect(decision.reason).toContain("27h");
      expect(decision.reason).toContain("limit 26h");
    }
  });

  it("escalates when the app has never had a successful backup", () => {
    // The dangerous case to hide: deferring protects an existing restore
    // point, and here there is none.
    for (const value of [null, undefined, ""]) {
      const decision = decideDeferral({ lastSuccessAt: value as never, now: NOW });
      expect(decision.action).toBe("escalate");
      if (decision.action === "escalate") {
        expect(decision.hoursSinceSuccess).toBeNull();
        expect(decision.reason).toContain("no successful backup");
      }
    }
  });

  it("escalates on an unparseable timestamp rather than treating it as fresh", () => {
    const decision = decideDeferral({ lastSuccessAt: "not a date", now: NOW });
    expect(decision.action).toBe("escalate");
  });

  it("treats a future timestamp as fresh instead of alerting on clock skew", () => {
    const decision = decideDeferral({ lastSuccessAt: new Date(NOW.getTime() + 60_000), now: NOW });
    expect(decision.action).toBe("defer");
    expect(decision.hoursSinceSuccess).toBe(0);
  });

  it("honours a custom limit", () => {
    expect(decideDeferral({ lastSuccessAt: hoursAgo(5), now: NOW, maxDeferralHours: 4 }).action).toBe("escalate");
    expect(decideDeferral({ lastSuccessAt: hoursAgo(3), now: NOW, maxDeferralHours: 4 }).action).toBe("defer");
  });

  it("ignores a nonsensical limit and uses the default", () => {
    for (const bad of [0, -5, Number.NaN]) {
      const decision = decideDeferral({ lastSuccessAt: hoursAgo(2), now: NOW, maxDeferralHours: bad });
      expect(decision.action).toBe("defer");
    }
    // ...and the default really is the boundary being applied.
    expect(decideDeferral({ lastSuccessAt: hoursAgo(30), now: NOW, maxDeferralHours: 0 }).action).toBe("escalate");
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(decideDeferral({ lastSuccessAt: hoursAgo(2).toISOString(), now: NOW }).action).toBe("defer");
  });
});

describe("resolveMaxDeferralHours", () => {
  it("reads a valid override", () => {
    expect(resolveMaxDeferralHours("48")).toBe(48);
    expect(resolveMaxDeferralHours(" 12 ")).toBe(12);
  });

  it("falls back for anything unusable", () => {
    for (const bad of ["", "  ", "abc", "0", "-3", null, undefined]) {
      expect(resolveMaxDeferralHours(bad)).toBe(DEFAULT_MAX_DEFERRAL_HOURS);
    }
  });
});
