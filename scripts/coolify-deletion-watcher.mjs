#!/usr/bin/env node
import { pathToFileURL } from "node:url";
/**
 * Ticks the Coolify deletion watch on an interval.
 *
 * Same shape as backup-reconcile-scheduler.mjs and for the same reason: the loop
 * is trivial and belongs in a script, while every decision belongs in TypeScript
 * where it is typed and unit tested. This file must stay dumb — if you find
 * yourself adding logic here, it goes in
 * apps/web/src/lib/coolify-deletion-watch.ts instead.
 *
 * What it enables: Coolify emits no deletion event, so a deleted resource has to
 * be noticed by polling its resource index. Without this process, deletions still
 * sync — just via the reconciler's seven-day archive rather than in minutes.
 */

function log(message) {
  console.log(`[coolify-deletion-watcher] ${message}`);
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeBaseUrl(value) {
  return (value || "").trim().replace(/\/+$/, "");
}

function resolveWatchUrl() {
  const direct = (process.env.COOLIFY_DELETION_WATCH_URL || "").trim();
  if (direct) return direct;
  // Inside the container (the default), call the app directly: machine tokens
  // are only honoured on local requests. A separate worker container uses the
  // public address, which also needs OPS_TOKEN_ALLOW_REMOTE=true on the app.
  const base = normalizeBaseUrl(process.env.NEXTAUTH_URL);
  if (base && (process.env.JONGO_WORKER_MODE || "").trim().toLowerCase() === "external") return `${base}/api/ops/coolify-deletion-watch`;

  const port = (process.env.PORT || "3000").trim() || "3000";
  return `http://127.0.0.1:${port}/api/ops/coolify-deletion-watch`;
}

function resolveOpsToken() {
  return (process.env.BACKUP_RECONCILE_TOKEN || process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
}

/**
 * One pass. Throws on failure so the worker records it; the standalone loop
 * below catches and logs instead.
 */
export async function watchOnce() {
  const opsToken = resolveOpsToken();
  if (!opsToken) throw new Error("Neither BACKUP_RECONCILE_TOKEN nor OWNERSHIP_SYNC_TOKEN is set.");
  const watchUrl = resolveWatchUrl();
  let response;
  try {
    response = await fetch(watchUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opsToken}` },
      body: "{}",
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" || error?.name === "AbortError" ? "timed out" : error?.message || String(error));
  }
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${payload?.error ?? ""}`.trim());
  }

  // Quiet on the common case. A line a minute saying "nothing changed" is how a
  // log stops being read.
  if (payload?.status && payload.status !== "ok") {
    log(`${payload.status}: ${payload.reason ?? ""}`);
    return payload;
  }
  if (payload?.flagged || payload?.cleared || (payload?.confirmed?.length ?? 0) > 0) {
    log(
      `live=${payload.liveCount} apps=${payload.linkedApps} flagged=${payload.flagged} cleared=${payload.cleared} ` +
        `confirmed=${JSON.stringify(payload.confirmed ?? [])} reported=${JSON.stringify(payload.reported ?? [])}`
    );
  }
  return payload;
}

async function tick() {
  try {
    await watchOnce();
  } catch (error) {
    log(`tick failed: ${error?.message || error}`);
  }
}

// Run only when executed directly; the worker imports watchOnce.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!resolveOpsToken()) {
    // Exit rather than loop: without the token every tick would 401 forever, and a
    // warning a minute is worse than a clear refusal now.
    log("Neither BACKUP_RECONCILE_TOKEN nor OWNERSHIP_SYNC_TOKEN is set; the watch endpoint would reject every tick. Exiting.");
    process.exit(0);
  }
  const intervalSeconds = toPositiveInt(process.env.COOLIFY_DELETION_WATCH_INTERVAL_SECONDS, 60);
  log(`ticking ${resolveWatchUrl()} every ${intervalSeconds}s`);
  await tick();
  setInterval(() => {
    tick().catch((error) => log(`tick threw: ${error?.message || error}`));
  }, intervalSeconds * 1000);
}
