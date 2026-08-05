import { describe, expect, it } from "vitest";
import { decideStaleRun, DEFAULT_STALE_RUN_HOURS } from "./stale-run";

const now = new Date("2026-08-04T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe("decideStaleRun", () => {
  it("leaves a run that has only just started", () => {
    const decision = decideStaleRun({ status: "running", startedAt: hoursAgo(0.5), now });
    expect(decision.abandon).toBe(false);
    expect(decision.reason).toBe("running");
  });

  it("leaves a long but still plausible run alone", () => {
    const decision = decideStaleRun({ status: "running", startedAt: hoursAgo(DEFAULT_STALE_RUN_HOURS - 1), now });
    expect(decision.abandon).toBe(false);
  });

  it("abandons a run that has outlived the timeout", () => {
    const decision = decideStaleRun({ status: "running", startedAt: hoursAgo(DEFAULT_STALE_RUN_HOURS + 1), now });
    expect(decision.abandon).toBe(true);
    expect(decision.reason).toBe("stale");
    expect(decision.ageHours).toBe(DEFAULT_STALE_RUN_HOURS + 1);
  });

  it("abandons exactly at the timeout", () => {
    const decision = decideStaleRun({ status: "running", startedAt: hoursAgo(DEFAULT_STALE_RUN_HOURS), now });
    expect(decision.abandon).toBe(true);
  });

  it("honours a custom timeout", () => {
    const decision = decideStaleRun({ status: "running", startedAt: hoursAgo(3), now, staleAfterHours: 2 });
    expect(decision.abandon).toBe(true);
  });

  it("ignores a non-positive custom timeout rather than abandoning everything", () => {
    const decision = decideStaleRun({ status: "running", startedAt: hoursAgo(1), now, staleAfterHours: 0 });
    expect(decision.abandon).toBe(false);
  });

  it("never touches a finished run", () => {
    for (const status of ["success", "failed", "pruned"]) {
      const decision = decideStaleRun({ status, startedAt: hoursAgo(500), now });
      expect(decision.abandon).toBe(false);
      expect(decision.reason).toBe("not_running");
    }
  });

  it("leaves a running row with no start time alone", () => {
    const decision = decideStaleRun({ status: "running", startedAt: null, now });
    expect(decision.abandon).toBe(false);
    expect(decision.reason).toBe("no_start_time");
  });

  it("leaves a running row with an unparseable start time alone", () => {
    const decision = decideStaleRun({ status: "running", startedAt: "not a date", now });
    expect(decision.abandon).toBe(false);
    expect(decision.reason).toBe("no_start_time");
  });

  it("accepts an ISO string start time", () => {
    const decision = decideStaleRun({ status: "running", startedAt: hoursAgo(10).toISOString(), now });
    expect(decision.abandon).toBe(true);
  });

  it("does not abandon a run whose start time is in the future", () => {
    // Clock skew between the web host and the database must not manufacture
    // failures out of backups that are running perfectly well.
    const decision = decideStaleRun({ status: "running", startedAt: new Date(now.getTime() + 3_600_000), now });
    expect(decision.abandon).toBe(false);
    expect(decision.ageHours).toBe(0);
  });
});
