import { describe, expect, it } from "vitest";
import {
  SFTP_GID,
  SFTP_UID,
  SFTP_VOLUME_ROOT,
  buildConnectionInfo,
  buildSftpHomePath,
  buildSftpUserPayload,
  buildSftpUsername,
  generateSftpPassword
} from "./sftp-provision";

describe("buildSftpHomePath", () => {
  it("points at that resource's files volume and nothing else", () => {
    expect(buildSftpHomePath("w59vqzik68ytf7u4jwh6qxis")).toBe(
      `${SFTP_VOLUME_ROOT}/w59vqzik68ytf7u4jwh6qxis_wordpress-files/_data`
    );
  });

  it("refuses a uuid that could escape into another site's files", () => {
    // Each of these would resolve outside the intended volume — the worst
    // possible outcome for a feature whose whole promise is isolation.
    for (const bad of ["../other", "a/../..", "abc/def", "..", "", "  ", "a b"]) {
      expect(() => buildSftpHomePath(bad)).toThrow(/non-alphanumeric/i);
    }
  });

  it("never resolves above the volume root", () => {
    const home = buildSftpHomePath("abc123");
    expect(home.startsWith(`${SFTP_VOLUME_ROOT}/`)).toBe(true);
    expect(home).not.toContain("..");
  });
});

describe("buildSftpUsername", () => {
  it("is readable and identifies the site", () => {
    expect(buildSftpUsername({ siteSlug: "fucarino-com", resourceUuid: "a11fc6a0lsu1xsm9fm2swz5u" })).toBe(
      "fucarino-com-a11fc6a0"
    );
  });

  it("cannot collide when two organizations both have a site with the same slug", () => {
    const a = buildSftpUsername({ siteSlug: "portfolio", resourceUuid: "aaaaaaaa1111" });
    const b = buildSftpUsername({ siteSlug: "portfolio", resourceUuid: "bbbbbbbb2222" });
    expect(a).not.toBe(b);
  });

  it("still produces a usable name when the slug is missing or unprintable", () => {
    expect(buildSftpUsername({ siteSlug: null, resourceUuid: "abcd1234" })).toBe("site-abcd1234");
    expect(buildSftpUsername({ siteSlug: "!!!", resourceUuid: "abcd1234" })).toBe("site-abcd1234");
  });

  it("refuses to build a name with no uuid to disambiguate it", () => {
    expect(() => buildSftpUsername({ siteSlug: "x", resourceUuid: "!!!" })).toThrow(/resource uuid/i);
  });
});

describe("generateSftpPassword", () => {
  it("is long, unique and free of characters that get misread", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const p = generateSftpPassword();
      expect(p).toHaveLength(20);
      expect(p).not.toMatch(/[oO0Il1]/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });

  it("refuses a length short enough to be worth guessing", () => {
    expect(() => generateSftpPassword(8)).toThrow(/at least 16/i);
  });
});

describe("buildSftpUserPayload", () => {
  const payload = buildSftpUserPayload({
    username: "demo-abc123",
    password: "secret",
    homePath: "/srv/volumes/abc123_wordpress-files/_data"
  }) as any;

  it("writes files as the uid WordPress runs as, or the site cannot manage them", () => {
    expect(payload.uid).toBe(SFTP_UID);
    expect(payload.gid).toBe(SFTP_GID);
    expect(SFTP_UID).toBe(33);
  });

  it("grants permissions only at the account's own root", () => {
    expect(Object.keys(payload.permissions)).toEqual(["/"]);
  });

  it("is SFTP-only — the same credential must not also open FTP or WebDAV", () => {
    expect(payload.filters.denied_protocols).toEqual(expect.arrayContaining(["FTP", "DAV", "HTTP"]));
  });
});

describe("buildConnectionInfo", () => {
  it("produces a URI FileZilla, Cyberduck and the sftp CLI all accept", () => {
    expect(buildConnectionInfo({ host: "5.78.216.68", port: 2222, username: "demo-abc123" })).toEqual({
      host: "5.78.216.68",
      port: 2222,
      username: "demo-abc123",
      protocol: "sftp",
      uri: "sftp://demo-abc123@5.78.216.68:2222"
    });
  });

  it("does not carry the password", () => {
    const info = buildConnectionInfo({ host: "h", port: 22, username: "u" }) as Record<string, unknown>;
    expect(Object.keys(info)).not.toContain("password");
  });
});
