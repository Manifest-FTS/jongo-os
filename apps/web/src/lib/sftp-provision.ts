/**
 * SFTP account provisioning — the decisions, none of the I/O.
 *
 * See docs/sftp-access-architecture.md for why this targets a single SFTPGo
 * instance with virtual users rather than a container or a host account per
 * site. Everything here is pure so the parts that are easy to get quietly wrong
 * — which directory a client is confined to, what a username may contain — are
 * testable without an SFTP server.
 */

import { createHash, randomBytes } from "node:crypto";

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
  publicKeys?: string[];
}): SftpUserPayload {
  return {
    username: input.username,
    password: input.password,
    public_keys: input.publicKeys ?? [],
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

/** At most this many SSH keys per account: one per person or computer is plenty. */
export const MAX_SFTP_PUBLIC_KEYS = 5;

const SSH_KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com"
]);

export type PublicKeyCheck =
  | { ok: true; key: string; type: string; fingerprint: string; comment: string }
  | { ok: false; message: string };

/**
 * Accept one OpenSSH public key line ("ssh-ed25519 AAAA… name"). The key's
 * own blob must name the same type, so random base64 or a private key pasted
 * by mistake is refused rather than stored.
 */
export function checkSshPublicKey(input: string): PublicKeyCheck {
  const line = String(input ?? "").trim();
  if (/PRIVATE KEY/.test(line)) {
    return { ok: false, message: "That's a private key. Paste the public key instead (the .pub file) and keep the private key to yourself." };
  }
  const parts = line.split(/\s+/);
  if (parts.length < 2 || !SSH_KEY_TYPES.has(parts[0]) || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) {
    return { ok: false, message: "That doesn't look like an SSH public key. It should start with ssh-ed25519, ssh-rsa or ecdsa-sha2." };
  }
  const blob = Buffer.from(parts[1], "base64");
  const typeLength = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const embedded = blob.subarray(4, 4 + typeLength).toString("utf8");
  if (embedded !== parts[0] || blob.length < 4 + typeLength + 16) {
    return { ok: false, message: "That SSH key is damaged or incomplete. Copy the whole line from the .pub file." };
  }
  if (parts[0] === "ssh-rsa" && blob.length < 270) {
    return { ok: false, message: "That RSA key is too short. Use an ed25519 key, or RSA with at least 2048 bits." };
  }
  const comment = parts.slice(2).join(" ").replace(/[^\w.@ -]+/g, "").slice(0, 80).trim();
  return {
    ok: true,
    key: comment ? `${parts[0]} ${parts[1]} ${comment}` : `${parts[0]} ${parts[1]}`,
    type: parts[0],
    fingerprint: sshFingerprint(parts[1]),
    comment
  };
}

/** The SHA256 fingerprint OpenSSH prints (ssh-keygen -lf). */
export function sshFingerprint(base64Blob: string): string {
  const digest = createHash("sha256").update(Buffer.from(base64Blob, "base64")).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}

/** A WordPress app's files are what SFTP opens; other app types have no such folder. */
export function sftpSupportedFor(workspace: { siteType?: string | null; resourceType?: string | null }): boolean {
  return workspace.siteType === "wordpress" || workspace.resourceType === "WordPress";
}
