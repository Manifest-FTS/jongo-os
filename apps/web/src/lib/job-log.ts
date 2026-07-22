import { openSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Open a log file for a detached background job.
 *
 * Detached jobs previously used `stdio: "ignore"`, which discarded all output —
 * when a backup silently failed there was nothing to diagnose. Writing to a file
 * keeps the job detached while preserving its output.
 *
 * Returns a file descriptor, or "ignore" if the log location is not writable so
 * that logging can never prevent a job from starting.
 */
export function openJobLog(name: string): number | "ignore" {
  const dir = process.env.JONGO_JOB_LOG_DIR?.trim() || path.join(os.tmpdir(), "jongo-jobs");
  try {
    mkdirSync(dir, { recursive: true });
    return openSync(path.join(dir, `${name}.log`), "a");
  } catch {
    return "ignore";
  }
}

/** Where the logs live, for surfacing in error messages. */
export function jobLogDir(): string {
  return process.env.JONGO_JOB_LOG_DIR?.trim() || path.join(os.tmpdir(), "jongo-jobs");
}
