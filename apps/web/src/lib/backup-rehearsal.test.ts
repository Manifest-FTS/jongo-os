import { describe, expect, it } from "vitest";
import {
  orderDueRehearsals,
  describeRehearsalOutcome,
  DEFAULT_REHEARSAL_INTERVAL_DAYS
} from "./backup-rehearsal";

const now = new Date("2026-08-05T12:00:00.000Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

const candidate = (over: Partial<Parameters<typeof orderDueRehearsals>[0][number]> = {}) => ({
  resourceUuid: "uuid-1",
  slug: "site-1",
  backupId: "backup-1",
  snapshotId: "snap-1",
  lastVerifiedAt: daysAgo(30),
  ...over
});

describe("orderDueRehearsals", () => {
  it("includes a resource that has never been rehearsed", () => {
    const due = orderDueRehearsals([candidate({ lastVerifiedAt: null })], { now });
    expect(due).toHaveLength(1);
  });

  it("excludes a resource rehearsed within the interval", () => {
    const due = orderDueRehearsals([candidate({ lastVerifiedAt: daysAgo(1) })], { now });
    expect(due).toHaveLength(0);
  });

  it("includes a resource once the interval has elapsed", () => {
    const due = orderDueRehearsals([candidate({ lastVerifiedAt: daysAgo(DEFAULT_REHEARSAL_INTERVAL_DAYS) })], { now });
    expect(due).toHaveLength(1);
  });

  it("sorts never-rehearsed ahead of long-ago-rehearsed", () => {
    const due = orderDueRehearsals(
      [
        candidate({ resourceUuid: "old", lastVerifiedAt: daysAgo(90) }),
        candidate({ resourceUuid: "never", lastVerifiedAt: null })
      ],
      { now }
    );
    expect(due.map((c) => c.resourceUuid)).toEqual(["never", "old"]);
  });

  it("sorts least-recently-verified first", () => {
    const due = orderDueRehearsals(
      [
        candidate({ resourceUuid: "b", lastVerifiedAt: daysAgo(10) }),
        candidate({ resourceUuid: "a", lastVerifiedAt: daysAgo(40) })
      ],
      { now }
    );
    expect(due.map((c) => c.resourceUuid)).toEqual(["a", "b"]);
  });

  it("drops candidates with nothing restorable to rehearse", () => {
    // A site with no restorable backup is a real problem, but it belongs to the
    // backup pipeline; reporting it as a failed rehearsal would blame the wrong
    // thing and make the verified/unverified signal untrustworthy.
    expect(orderDueRehearsals([candidate({ backupId: null })], { now })).toHaveLength(0);
    expect(orderDueRehearsals([candidate({ snapshotId: "  " })], { now })).toHaveLength(0);
  });

  it("drops candidates with no resource uuid", () => {
    expect(orderDueRehearsals([candidate({ resourceUuid: "" })], { now })).toHaveLength(0);
  });

  it("honours a custom interval", () => {
    const due = orderDueRehearsals([candidate({ lastVerifiedAt: daysAgo(3) })], { now, intervalDays: 2 });
    expect(due).toHaveLength(1);
  });

  it("falls back to the default for a nonsensical interval", () => {
    const due = orderDueRehearsals([candidate({ lastVerifiedAt: daysAgo(1) })], { now, intervalDays: 0 });
    expect(due).toHaveLength(0);
  });

  it("treats an unparseable timestamp as never rehearsed", () => {
    const due = orderDueRehearsals([candidate({ lastVerifiedAt: "not a date" })], { now });
    expect(due).toHaveLength(1);
  });
});

describe("describeRehearsalOutcome", () => {
  const ok = { snapshotRestored: true, dumpsFound: 2, dumpsReplayed: 2, tablesAfter: 40 };

  it("passes a backup that read back, replayed and holds tables", () => {
    const verdict = describeRehearsalOutcome(ok);
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe("verified");
  });

  it("fails when the snapshot cannot be read from offsite storage", () => {
    const verdict = describeRehearsalOutcome({ ...ok, snapshotRestored: false });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("snapshot_unreadable");
  });

  it("passes a files-only backup with nothing to replay", () => {
    // Files-only resources are legitimate. Failing them would train people to
    // ignore the signal.
    const verdict = describeRehearsalOutcome({ ...ok, dumpsFound: 0, dumpsReplayed: 0, tablesAfter: 0 });
    expect(verdict.pass).toBe(true);
    expect(verdict.reason).toBe("no_dumps");
  });

  it("fails when only some dumps replayed", () => {
    const verdict = describeRehearsalOutcome({ ...ok, dumpsReplayed: 1 });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("replay_failed");
    expect(verdict.message).toContain("1 of 2");
  });

  // The regression the whole rehearsal exists to catch.
  it("fails when the dumps replayed but produced no tables", () => {
    const verdict = describeRehearsalOutcome({ ...ok, tablesAfter: 0 });
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe("restored_empty");
    expect(verdict.message).toContain("empty database");
  });

  it("does not accept a clean replay as proof on its own", () => {
    // "Exited 0" was exactly the assumption that let an empty restore look
    // healthy, so it must not be sufficient here either.
    expect(describeRehearsalOutcome({ ...ok, tablesAfter: 0 }).pass).toBe(false);
  });
});
