import { describe, expect, it } from "vitest";
import { parseForgottenSnapshotIds, parseForgottenSnapshotIdsFromBase64 } from "./restic-forget";

/**
 * Captured verbatim from restic 0.16.4 against the production repository: a
 * forget run that kept the only snapshot and removed nothing. This is the exact
 * shape that the previous text-scraping implementation misread as a removal.
 */
const KEPT_NOTHING_REMOVED = JSON.stringify([
  {
    tags: null,
    host: "jongo-open-source",
    paths: ["/var/backups/jongo/jongo-open-source/db-o4g2cpls648gnz0f1he7be7c.sql"],
    keep: [
      {
        time: "2026-07-25T09:48:44.930563206Z",
        hostname: "jongo-open-source",
        tags: ["jongo-backup", "site=oreu338s6akv34il5gwwj0wb"],
        id: "2ae64053fd1d96195e82581ae494a95f53630f59ebb0efbb7f62c5e2241562ee",
        short_id: "2ae64053"
      }
    ],
    remove: null,
    reasons: []
  }
]);

describe("parseForgottenSnapshotIds", () => {
  it("returns nothing when restic kept everything", () => {
    // The regression: a fresh snapshot appearing under `keep` must never be
    // reported as forgotten, or every new backup is marked unrestorable.
    expect(parseForgottenSnapshotIds(KEPT_NOTHING_REMOVED)).toEqual([]);
  });

  it("returns only the removed snapshots when both lists are present", () => {
    const json = JSON.stringify([
      {
        keep: [{ short_id: "aaaaaaaa" }],
        remove: [{ short_id: "bbbbbbbb" }, { short_id: "cccccccc" }]
      }
    ]);
    expect(parseForgottenSnapshotIds(json)).toEqual(["bbbbbbbb", "cccccccc"]);
  });

  it("collects removals across every group", () => {
    const json = JSON.stringify([
      { keep: [], remove: [{ short_id: "aaaaaaaa" }] },
      { keep: [], remove: [{ short_id: "bbbbbbbb" }] }
    ]);
    expect(parseForgottenSnapshotIds(json)).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });

  it("falls back to truncating the full id when short_id is absent", () => {
    const json = JSON.stringify([
      { remove: [{ id: "ddddddddeeeeeeeeffffffff00000000" }] }
    ]);
    expect(parseForgottenSnapshotIds(json)).toEqual(["dddddddd"]);
  });

  it("de-duplicates ids", () => {
    const json = JSON.stringify([
      { remove: [{ short_id: "aaaaaaaa" }] },
      { remove: [{ short_id: "aaaaaaaa" }] }
    ]);
    expect(parseForgottenSnapshotIds(json)).toEqual(["aaaaaaaa"]);
  });

  it("returns nothing rather than guessing on unusable input", () => {
    // Every one of these must be empty: a wrong id marks a good backup
    // unrestorable, which is far worse than a stale catalogue row.
    expect(parseForgottenSnapshotIds("")).toEqual([]);
    expect(parseForgottenSnapshotIds("not json at all")).toEqual([]);
    expect(parseForgottenSnapshotIds("null")).toEqual([]);
    expect(parseForgottenSnapshotIds(undefined)).toEqual([]);
    expect(parseForgottenSnapshotIds({ remove: [{ short_id: "aaaaaaaa" }] })).toEqual([]);
    expect(parseForgottenSnapshotIds(JSON.stringify([{ remove: "aaaaaaaa" }]))).toEqual([]);
  });

  it("never treats restic's human-readable table as data", () => {
    const human = [
      "Applying Policy: keep 7 daily, 4 weekly, 6 monthly snapshots",
      "keep 1 snapshots:",
      "ID        Time                 Host",
      "2ae64053  2026-07-25 09:48:44  jongo-open-source",
      "1 snapshots"
    ].join("\n");
    expect(parseForgottenSnapshotIds(human)).toEqual([]);
  });
});

describe("parseForgottenSnapshotIdsFromBase64", () => {
  it("decodes the wire format the backup script emits", () => {
    const json = JSON.stringify([{ remove: [{ short_id: "bbbbbbbb" }] }]);
    const encoded = Buffer.from(json, "utf8").toString("base64");
    expect(parseForgottenSnapshotIdsFromBase64(encoded)).toEqual(["bbbbbbbb"]);
  });

  it("survives an empty or corrupt payload", () => {
    expect(parseForgottenSnapshotIdsFromBase64("")).toEqual([]);
    expect(parseForgottenSnapshotIdsFromBase64(null)).toEqual([]);
    expect(parseForgottenSnapshotIdsFromBase64("!!!not-base64!!!")).toEqual([]);
  });

  it("round-trips the real kept-nothing-removed payload", () => {
    const encoded = Buffer.from(KEPT_NOTHING_REMOVED, "utf8").toString("base64");
    expect(parseForgottenSnapshotIdsFromBase64(encoded)).toEqual([]);
  });
});
