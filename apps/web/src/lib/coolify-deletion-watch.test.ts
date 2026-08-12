import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIRM_MINUTES,
  isDeletionConfirmed,
  shouldTrustPoll
} from "./coolify-deletion-watch";

describe("shouldTrustPoll", () => {
  it("never trusts an empty list", () => {
    // An empty response is what a bad token, a 429, or a truncated body looks
    // like — trusting it would mean "every app was deleted".
    expect(shouldTrustPoll({ currentCount: 0, lastGoodCount: 40 })).toMatchObject({ trust: false });
    expect(shouldTrustPoll({ currentCount: 0, lastGoodCount: null }).trust).toBe(false);
  });

  it("trusts the first poll when there is no baseline", () => {
    expect(shouldTrustPoll({ currentCount: 40, lastGoodCount: null })).toMatchObject({
      trust: true,
      reason: "first_poll"
    });
  });

  it("trusts a stable or growing count", () => {
    expect(shouldTrustPoll({ currentCount: 40, lastGoodCount: 40 }).trust).toBe(true);
    expect(shouldTrustPoll({ currentCount: 45, lastGoodCount: 40 }).trust).toBe(true);
  });

  it("trusts a small drop, which is what one real deletion looks like", () => {
    expect(shouldTrustPoll({ currentCount: 39, lastGoodCount: 40 }).trust).toBe(true);
  });

  it("refuses a collapse, which is far more likely an API fault than reality", () => {
    const verdict = shouldTrustPoll({ currentCount: 10, lastGoodCount: 40 });
    expect(verdict.trust).toBe(false);
    expect(verdict.reason).toContain("40");
  });

  it("respects a custom drop tolerance", () => {
    expect(shouldTrustPoll({ currentCount: 30, lastGoodCount: 40, maxDropFraction: 0.5 }).trust).toBe(true);
  });
});

describe("isDeletionConfirmed", () => {
  const now = new Date("2026-08-10T12:00:00Z");
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it("does not confirm a resource that is present", () => {
    expect(isDeletionConfirmed({ missingSince: null, now })).toMatchObject({
      confirmed: false,
      reason: "not_missing"
    });
  });

  it("waits out the confirmation window", () => {
    // A resource absent from one poll is a blip, not a deletion.
    const verdict = isDeletionConfirmed({ missingSince: minutesAgo(1), now, confirmMinutes: 3 });
    expect(verdict).toMatchObject({ confirmed: false, reason: "within_window", ageMinutes: 1 });
  });

  it("confirms once the window has elapsed", () => {
    const verdict = isDeletionConfirmed({ missingSince: minutesAgo(3), now, confirmMinutes: 3 });
    expect(verdict).toMatchObject({ confirmed: true, reason: "confirmed", ageMinutes: 3 });
  });

  it("accepts an ISO string, which is what the database hands back", () => {
    expect(isDeletionConfirmed({ missingSince: minutesAgo(10).toISOString(), now, confirmMinutes: 3 }).confirmed).toBe(true);
  });

  it("never treats an unreadable timestamp as long ago", () => {
    // Parsing to NaN must not become "missing since the epoch, delete it".
    expect(isDeletionConfirmed({ missingSince: "not a date", now })).toMatchObject({
      confirmed: false,
      reason: "unreadable_timestamp"
    });
  });

  it("never reports a negative age for a clock skewed into the future", () => {
    const verdict = isDeletionConfirmed({ missingSince: new Date(now.getTime() + 60_000), now });
    expect(verdict.ageMinutes).toBe(0);
    expect(verdict.confirmed).toBe(false);
  });

  it("defaults to a minutes-scale window, not the reconciler's days", () => {
    expect(DEFAULT_CONFIRM_MINUTES).toBeLessThanOrEqual(10);
    expect(isDeletionConfirmed({ missingSince: minutesAgo(DEFAULT_CONFIRM_MINUTES), now }).confirmed).toBe(true);
  });
});
