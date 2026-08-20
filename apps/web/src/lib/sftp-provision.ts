/**
 * SFTP account provisioning — the decisions, none of the I/O.
 *
 * See docs/sftp-access-architecture.md for why this targets a single SFTPGo
 * instance with virtual users rather than a container or a host account per
 * site. Everything here is pure so the parts that are easy to get quietly wrong
 * — which directory a client is confined to, what a username may contain — are
 * testable without an SFTP server.
 */

import { randomBytes } from "node:crypto";

/** Where the host's Docker volumes are mounted inside the SFTP container. */
export const SFTP_VOLUME_ROOT = "/srv/volumes";

/** WordPress runs as uid/gid 33, so uploads must land as 33:33 to be usable. */
export const SFTP_UID = 33;
export const SFTP_GID = 33;

/**
 * Unambiguous alphabet: these credentials get pasted into FileZilla by hand and
 * read off a screen, so O/0 and I/l/1 are excluded.
 */
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateSftpPassword(length = 20): string {
  if (length < 16) throw new Error("SFTP password must be at least 16 characters.");
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
  }
  return out;
}

/**
 * A username that identifies the site at a glance.
 *
 * Derived from the site slug and suffixed with part of the resource uuid: slugs
 * are unique per organization, not globally, and SFTPGo usernames are global.
 * Two clients with a "portfolio" site must not collide — the first would own the
 * name and the second would be handed access to the wrong volume.
 */
export function buildSftpUsername(input: { siteSlug?: string | null; resourceUuid: string }): string {
  const base =
    String(input.siteSlug ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/g, "") || "site";
  const suffix = String(input.resourceUuid).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (!suffix) throw new Error("A resource uuid is required to build a unique SFTP username.");
  return `${base}-${suffix}`;
}

/**
 * The directory the account is confined to.
 *
 * The WordPress root, matching what managed hosts give: a client who cannot
 * reach wp-content/themes cannot do the work they asked for access to do.
 * Narrowing to uploads only is a matter of appending to this path — see the
 * architecture note on what that trades away.
 */
export function buildSftpHomePath(resourceUuid: string): string {
  const uuid = String(resourceUuid ?? "").trim();
  if (!/^[a-z0-9]+$/i.test(uuid)) {
    // This becomes a filesystem path inside the SFTP container. A value with a
    // slash or "…/.." in it would point the account at another site's files, or
    // at the volume root holding all of them.
    throw new Error("Refusing to build an SFTP home path from a non-alphanumeric resource uuid.");
  }
  return `${SFTP_VOLUME_ROOT}/${uuid}_wordpress-files/_data`;
}

export type SftpUserPayload = Record<string, unknown>;

/**
 * The SFTPGo user record.
 *
 * `permissions` is keyed by path: "/" is the account's own root, which SFTPGo
 * resolves relative to home_dir. There is no way to express a path above it,
 * which is what confines the session.
 */
export function buildSftpUserPayload(input: {
  username: string;
  password: string;
  homePath: string;
}): SftpUserPayload {
  return {
    username: input.username,
    password: input.password,
    home_dir: input.homePath,
    uid: SFTP_UID,
    gid: SFTP_GID,
    status: 1,
    permissions: {
      "/": ["*"]
    },
    // SFTPGo also speaks FTP, WebDAV and HTTP. This account is for file access
    // over SFTP only; leaving the others enabled would widen the exposure of a
    // credential well beyond what the dashboard describes.
    filters: {
      denied_protocols: ["FTP", "DAV", "HTTP"]
    }
  };
}

/** Connection details for the UI. Never includes the password. */
export type SftpConnectionInfo = {
  host: string;
  port: number;
  username: string;
  protocol: "sftp";
  uri: string;
};

export function buildConnectionInfo(input: {
  host: string;
  port: number;
  username: string;
}): SftpConnectionInfo {
  return {
    host: input.host,
    port: input.port,
    username: input.username,
    protocol: "sftp",
    // The form FileZilla, Cyberduck and the `sftp` CLI all accept.
    uri: `sftp://${input.username}@${input.host}:${input.port}`
  };
}
