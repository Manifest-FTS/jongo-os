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

/**
 * Resolve host, credentials and the full ssh argv once.
 *
 * Shared by the buffered and streaming runners so there is exactly ONE place
 * that decides which env vars name the key and in what order. Two copies of
 * this precedence is how one of them ends up reading a variable the operator
 * never set.
 *
 * Returns a `tempDir` the caller MUST clean up when the ssh process is done —
 * for the streaming runner that is long after this function returns.
 */
function resolveSshInvocation():
  | { ok: true; args: string[]; tempDir: string }
  | { ok: false; transportError: string } {
  const host = firstEnvValue(["STAGING_SYNC_SSH_HOST", "COOLIFY_SSH_HOST"]);
  if (!host) {
    return { ok: false, transportError: "SSH host is not configured (STAGING_SYNC_SSH_HOST / COOLIFY_SSH_HOST)." };
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
      return { ok: false, transportError: "SSH private key was empty after normalization." };
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

  return { ok: true, args, tempDir };
}

function removeTempDir(tempDir: string): void {
  if (!tempDir) return;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best effort — a leftover key in the container's tmpdir is preferable to
    // failing a read that already succeeded.
  }
}

export async function runHostScript(
  script: string,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {}
): Promise<SshRunResult> {
  const invocation = resolveSshInvocation();
  if (!invocation.ok) {
    return { ok: false, stdout: "", stderr: "", transportError: invocation.transportError };
  }
  const { args, tempDir } = invocation;

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
    removeTempDir(tempDir);
  }
}

export type SshStreamResult =
  | {
      ok: true;
      /** Snapshot bytes, ready to hand to a Response. Cancelling it kills ssh. */
      body: ReadableStream<Uint8Array>;
    }
  | {
      ok: false;
      /** Whatever the remote managed to say before dying, trimmed. */
      stderr: string;
      transportError?: string;
    };

/**
 * Run a host script and STREAM its stdout, rather than buffering it.
 *
 * `runHostScript` caps output at 8 MB because everything else it is used for is
 * a status probe. A site archive is routinely gigabytes, so buffering it would
 * put the whole thing in the web process's heap before a single byte reached the
 * caller. This never holds more than one chunk.
 *
 * The hard part is reporting failure. Once a 200 is on the wire the status code
 * can no longer change, so a restic error at that point can only truncate the
 * download — a corrupt archive that looks like a completed one. To avoid that,
 * this waits for the FIRST BYTE of stdout before resolving `ok: true`: an ssh or
 * restic failure almost always happens during repository open, which is before
 * any tar bytes exist. Failures after that are genuinely unreportable in-band,
 * so the stream errors rather than ending cleanly and the client sees a broken
 * transfer instead of a short file it might trust.
 */
export async function streamHostScript(
  script: string,
  options: { firstByteTimeoutMs?: number } = {}
): Promise<SshStreamResult> {
  const invocation = resolveSshInvocation();
  if (!invocation.ok) {
    return { ok: false, stderr: "", transportError: invocation.transportError };
  }
  const { args, tempDir } = invocation;

  // Generous: restic must reach Backblaze, open the repository and load the
  // index before it can emit a byte, and a cold large repo is not fast.
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? 120_000;

  const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });

  // Terminal state is tracked from the moment the process exists, NOT from
  // inside the ReadableStream. A small snapshot can finish before the stream is
  // ever constructed, and a "close" listener attached after the fact would miss
  // it — leaving a download that never completes and never fails.
  let exitCode: number | null = null;
  let spawnError: Error | null = null;
  let stdoutEnded = false;
  let stderr = "";
  let notifySettled: (() => void) | null = null;

  child.on("close", (code) => {
    exitCode = code ?? 0;
    notifySettled?.();
  });
  child.on("error", (error) => {
    spawnError = error;
    notifySettled?.();
  });
  child.stdout.on("end", () => {
    stdoutEnded = true;
    notifySettled?.();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length > 64 * 1024) return;
    stderr += chunk.toString("utf8");
  });
  child.stdin.on("error", () => {
    // The remote may exit before consuming the script; a dead pipe here must
    // not take the web process down.
  });
  child.stdin.end(script, "utf8");

  const settled = await new Promise<{ ok: boolean; firstChunk?: Buffer; transportError?: string }>((resolve) => {
    let done = false;
    const finish = (result: { ok: boolean; firstChunk?: Buffer; transportError?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, transportError: `Timed out after ${firstByteTimeoutMs}ms waiting for the archive to start.` });
    }, firstByteTimeoutMs);

    child.stdout.once("data", (chunk: Buffer) => {
      // Attaching any "data" listener puts the stream in flowing mode, and
      // `once` removing itself does NOT undo that. Without an explicit pause,
      // every byte emitted between here and the ReadableStream's start() has no
      // listener and is silently discarded — a corrupt archive with no error.
      child.stdout.pause();
      finish({ ok: true, firstChunk: chunk });
    });
    // Reached only when the process ended without ever writing to stdout. That
    // is the case this whole race exists for: restic reports a bad snapshot or
    // an unreachable repository before emitting any tar, so the caller can
    // still send a real status code instead of a truncated archive.
    //
    // Gated on stdout's "end", NOT the process's "close". A stream can still be
    // holding buffered output when the process is reaped, and concluding "no
    // output" from the exit alone would report a perfectly good small archive
    // as a failure. "end" is emitted only after every "data" event, so if there
    // were any bytes at all, the handler above has already won this race.
    notifySettled = () => {
      if (stdoutEnded || spawnError) finish({ ok: false });
    };
  });

  if (!settled.ok) {
    removeTempDir(tempDir);
    return { ok: false, stderr: stderr.trim(), transportError: settled.transportError };
  }

  const firstChunk = settled.firstChunk;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstChunk) controller.enqueue(new Uint8Array(firstChunk));

      child.stdout.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
        // Real backpressure. A fast Backblaze read into a slow client would
        // otherwise queue the entire site in memory — the exact problem
        // streaming exists to avoid. `pull` resumes when the consumer is ready.
        if ((controller.desiredSize ?? 1) <= 0) child.stdout.pause();
      });

      let finished = false;
      const settle = () => {
        // Both conditions matter: the exit code says whether the archive is
        // complete, and "end" says every buffered byte has been handed over.
        // Closing on the exit code alone would drop the tail of a small file.
        if (finished || !stdoutEnded || (exitCode === null && !spawnError)) return;
        finished = true;
        removeTempDir(tempDir);

        if (spawnError) {
          controller.error(spawnError);
          return;
        }
        if (exitCode === 0) {
          controller.close();
          return;
        }
        // Deliberately an error, not a clean close. A non-zero exit part-way
        // means the archive is incomplete, and ending cleanly would hand the
        // user a truncated file that opens fine and is missing data.
        controller.error(new Error(`Archive transfer failed (ssh exit ${exitCode}). ${stderr.trim()}`.trim()));
      };

      notifySettled = settle;
      // The process may already have exited while this stream was being built.
      settle();
    },
    pull() {
      child.stdout.resume();
    },
    cancel() {
      // The browser navigated away or the user hit stop. Without this, restic
      // keeps pulling the whole snapshot out of Backblaze for a download nobody
      // is receiving — which costs egress and holds the host's backup lock.
      notifySettled = null;
      child.kill("SIGKILL");
      removeTempDir(tempDir);
    }
  });

  return { ok: true, body };
}
