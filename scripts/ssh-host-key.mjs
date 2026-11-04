/**
 * SSH host-key pinning for every SSH call made from the Jongo container.
 *
 * STAGING_SYNC_SSH_KNOWN_HOSTS holds the hosting server's public host key(s),
 * exactly as `ssh-keyscan` prints them. At startup they are written to a file
 * and two variables every SSH caller already reads are set:
 *
 *   STAGING_SYNC_SSH_USER_KNOWN_HOSTS_FILE = that file
 *   STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING = yes
 *
 * so lib/ssh-exec.ts and the backup, restore, staging and cache scripts all
 * refuse a server that does not present the pinned key, instead of trusting
 * whatever answers first ("accept-new") in every new container.
 *
 * Mutates `env` (process.env at startup) so child processes inherit it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// "<hosts> <key-type> <base64>[ comment]", optionally starting with @marker.
const KNOWN_HOSTS_LINE = /^(@[a-z-]+\s+)?\S+\s+(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/=]{40,}(\s.*)?$/;

export function parseKnownHosts(value) {
  const lines = String(value || "")
    .replace(/\\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const bad = lines.find((line) => !KNOWN_HOSTS_LINE.test(line));
  return { lines, bad };
}

export function pinSshHostKey(env = process.env, { dir = os.tmpdir() } = {}) {
  const sshConfigured = Boolean((env.STAGING_SYNC_SSH_HOST || env.COOLIFY_SSH_HOST || "").trim());
  const raw = (env.STAGING_SYNC_SSH_KNOWN_HOSTS || "").trim();
  if (!raw) return { status: "missing", sshConfigured };

  const { lines, bad } = parseKnownHosts(raw);
  if (lines.length === 0) return { status: "invalid", reason: "it contains no key lines.", sshConfigured };
  if (bad) return { status: "invalid", reason: "a line is not in ssh-keyscan format (host key-type base64).", sshConfigured };

  const file = path.join(dir, "jongo-ssh-known-hosts");
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o644 });
  env.STAGING_SYNC_SSH_USER_KNOWN_HOSTS_FILE = file;
  env.STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING = "yes";
  return { status: "pinned", lines: lines.length, file, sshConfigured };
}
