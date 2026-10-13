#!/usr/bin/env node
/**
 * Copies production databases into their staging copies (dump streamed into
 * restore on the database host; production is only read). Spawned detached by
 * lib/staging-databases.ts with a payload file of { id, script } items whose
 * scripts come from lib/staging-db-plan.ts (tested there) and hold no secrets:
 * credentials are read from the containers on the host.
 *
 * Usage: node scripts/staging-db-copy.mjs --payload <file>
 * Reports each result to /api/ops/staging-db-record (report-to-app.mjs).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { postToApp } from "./report-to-app.mjs";

function firstEnvValue(keys) {
  for (const key of keys) {
    const value = (process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] || "").trim() : "";
}
function normalizePrivateKey(v) { return v.replace(/\r\n/g, "\n").replace(/\\n/g, "\n").trim(); }

const payloadPath = argValue("--payload");
let items = [];
try {
  items = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
} catch (e) {
  console.error(`ERROR: cannot read payload: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
} finally {
  try { fs.rmSync(payloadPath, { force: true }); } catch { /* ignore */ }
}

const sshHost = firstEnvValue(["STAGING_SYNC_SSH_HOST", "COOLIFY_SSH_HOST"]);
const sshUser = firstEnvValue(["STAGING_SYNC_SSH_USER"]) || "root";
const sshStrict = (process.env.STAGING_SYNC_SSH_STRICT_HOST_KEY_CHECKING || "accept-new").trim();
const sshKnownHosts = (process.env.STAGING_SYNC_SSH_USER_KNOWN_HOSTS_FILE || "").trim();
let sshKeyPath = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_PATH", "COOLIFY_SSH_PRIVATE_KEY_PATH"]);
const sshKeyRaw = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY", "COOLIFY_SSH_PRIVATE_KEY"]);
const sshKeyB64 = firstEnvValue(["STAGING_SYNC_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_B64", "COOLIFY_SSH_PRIVATE_KEY_BASE64"]);

let cleanupDir = "";
async function report(id, result, error, tables) {
  const res = await postToApp("/api/ops/staging-db-record", { stagingDatabaseId: id, result, error: error || null, tables: tables ?? null });
  console.log(`recorded ${id} -> ${res.status} via ${res.base ?? "none"}${res.error ? ` (${res.error})` : ""}`);
}

try {
  if (!sshHost) {
    for (const item of items) await report(item.id, "fail", "host_not_configured");
    process.exit(1);
  }
  if (!sshKeyPath && (sshKeyRaw || sshKeyB64)) {
    const decoded = normalizePrivateKey(sshKeyB64 ? Buffer.from(sshKeyB64, "base64").toString("utf8") : sshKeyRaw);
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), "staging-db-key-"));
    sshKeyPath = path.join(cleanupDir, "id_ed25519");
    fs.writeFileSync(sshKeyPath, `${decoded}\n`, { encoding: "utf8", mode: 0o600 });
  }

  for (const item of items) {
    const args = [];
    if (sshKeyPath) args.push("-i", sshKeyPath, "-o", "IdentitiesOnly=yes");
    if (sshStrict) args.push("-o", `StrictHostKeyChecking=${sshStrict}`);
    if (sshKnownHosts) args.push("-o", `UserKnownHostsFile=${sshKnownHosts}`);
    args.push(`${sshUser}@${sshHost}`, "bash", "-s");
    const started = Date.now();
    const r = spawnSync("ssh", args, { input: item.script, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60 * 60 * 1000 });
    const out = `${r.stdout || ""}`;
    const result = (out.match(/^COPY_RESULT=(.*)$/m)?.[1] || "").trim();
    const detail = (out.match(/^COPY_ERROR=(.*)$/m)?.[1] || "").trim();
    const tables = Number((out.match(/^TABLES=(\d+)$/m)?.[1]) ?? NaN);
    console.log(`[staging-db-copy] ${item.id}: ${result || "no result"} in ${Math.round((Date.now() - started) / 1000)}s`);
    if (result === "ok" || result === "skipped") {
      await report(item.id, result, null, Number.isFinite(tables) ? tables : null);
    } else {
      const reason = result.startsWith("fail:") ? result.slice(5) : r.error ? `ssh: ${r.error.message}` : `exit ${r.status}`;
      await report(item.id, "fail", [reason, detail].filter(Boolean).join(" — ").slice(0, 500), null);
    }
  }
} finally {
  if (cleanupDir) { try { fs.rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* ignore */ } }
}
