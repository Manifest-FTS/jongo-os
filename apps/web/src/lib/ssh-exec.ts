/**
 * Running a shell script on the Coolify host from the web process.
 *
 * The app container has an `ssh` binary and `STAGING_SYNC_SSH_HOST`, but no
 * Docker socket — so anything that needs `docker exec` goes host-first, exactly
 * as scripts/site-backup.mjs already does. The env var names and precedence are
 * deliberately identical to that script's: an operator who configured backups has
 * configured this too, and two different conventions for the same credential is
 * how one of them ends up unset and mysterious.
 *
 * The private key may arrive as a path, raw PEM, or base64. Raw and base64 forms
 * are written to a 0600 temp file for the duration of the call, because ssh
 * refuses a key it considers world-readable and will not take one on stdin.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export type SshRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set when the transport itself never ran (no host, no key, spawn failure). */
  transportError?: string;
};

function firstEnvValue(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

/** True when a host is configured, so callers can skip work that cannot succeed. */
export function isSshHostConfigured(): boolean {
  return Boolean(firstEnvValue(["STAGING_SYNC_SSH_HOST", "COOLIFY_SSH_HOST"]));
}

function normalizePrivateKey(value: string): string {
  // Keys pasted into an env var routinely arrive with escaped newlines; ssh
  // needs real ones or it reports an invalid format.
  return value.replace(/\\n/g, "\n").trim();
}

export async function runHostScript(
  script: string,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<SshRunResult> {
  const host = firstEnvValue(["STAGING_SYNC_SSH_HOST", "COOLIFY_SSH_HOST"]);
  if (!host) {
    return { ok: false, stdout: "", stderr: "", transportError: "SSH host is not configured (STAGING_SYNC_SSH_HOST / COOLIFY_SSH_HOST)." };
  }

  const user = firstEnvValue(["STAGING_SYNC_SSH_USER"]) || "root";
  const strict = (process.env.STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING || "accept-new").trim();
  const knownHosts = (process.env.STAGING_SYNC_SSH_USER_KNOWN_HOSTS_FILE || "").trim();
  const keyPathEnv = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_PATH", "COOLIFY_SSH_PRIVATE_KEY_PATH"]);
  const keyRaw = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY", "COOLIFY_SSH_PRIVATE_KEY"]);
  const keyB64 = firstEnvValue([
    "STAGING_SYNC_SSH_PRIVATE_KEY_B64",
    "COOLIFY_SSH_PRIVATE_KEY_B64",
    "COOLIFY_SSH_PRIVATE_KEY_BASE64"
  ]);

  let keyPath = keyPathEnv;
  let tempDir = "";
  if (!keyPath && (keyRaw || keyB64)) {
    const decoded = keyB64 ? Buffer.from(keyB64, "base64").toString("utf8") : keyRaw;
    const normalized = normalizePrivateKey(decoded);
    if (!normalized) {
      return { ok: false, stdout: "", stderr: "", transportError: "SSH private key was empty after normalization." };
    }
    tempDir = mkdtempSync(path.join(os.tmpdir(), "jongo-ssh-"));
    keyPath = path.join(tempDir, "id_ed25519");
    writeFileSync(keyPath, `${normalized}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(keyPath, 0o600);
  }

  const args: string[] = [];
  if (keyPath) args.push("-i", keyPath, "-o", "IdentitiesOnly=yes");
  if (strict) args.push("-o", `StrictHostKeyChecking=${strict}`);
  if (knownHosts) args.push("-o", `UserKnownHostsFile=${knownHosts}`);
  args.push("-o", "BatchMode=yes", `${user}@${host}`, "bash", "-s");

  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;

  try {
    return await new Promise<SshRunResult>((resolve) => {
      const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let truncated = false;

      const finish = (result: SshRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ ok: false, stdout, stderr, transportError: `SSH command timed out after ${timeoutMs}ms.` });
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length > maxOutputBytes) {
          truncated = true;
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length > 64 * 1024) return;
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        finish({ ok: false, stdout, stderr, transportError: `ssh could not be started: ${error.message}` });
      });

      child.on("close", (code) => {
        finish({
          ok: code === 0 && !truncated,
          stdout,
          stderr,
          ...(truncated ? { transportError: "SSH output exceeded the size limit." } : {})
        });
      });

      child.stdin.on("error", () => {
        // A remote that closed early surfaces via the exit code; writing to a
        // dead pipe must not take the process down.
      });
      child.stdin.end(script, "utf8");
    });
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best effort — a leftover key in the container's tmpdir is preferable
        // to failing a read that already succeeded.
      }
    }
  }
}
