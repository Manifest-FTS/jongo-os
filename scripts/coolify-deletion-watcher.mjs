#!/usr/bin/env node
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

  const base = normalizeBaseUrl(process.env.NEXTAUTH_URL);
  if (base) return `${base}/api/ops/coolify-deletion-watch`;

  const port = (process.env.PORT || "3000").trim() || "3000";
  return `http://127.0.0.1:${port}/api/ops/coolify-deletion-watch`;
}

const intervalSeconds = toPositiveInt(process.env.COOLIFY_DELETION_WATCH_INTERVAL_SECONDS, 60);
const watchUrl = resolveWatchUrl();
const opsToken = (process.env.BACKUP_RECONCILE_TOKEN || process.env.OWNERSHIP_SYNC_TOKEN || "").trim();

if (!opsToken) {
  // Exit rather than loop: without the token every tick would 401 forever, and a
  // warning a minute is worse than a clear refusal now.
  log("Neither BACKUP_RECONCILE_TOKEN nor OWNERSHIP_SYNC_TOKEN is set; the watch endpoint would reject every tick. Exiting.");
  process.exit(0);
}

async function tick() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(watchUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opsToken}` },
      body: "{}",
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      log(`tick failed: HTTP ${response.status} ${payload?.error ?? ""}`);
      return;
    }

    // Quiet on the common case. A line a minute saying "nothing changed" is how a
    // log stops being read.
    if (payload?.status && payload.status !== "ok") {
      log(`${payload.status}: ${payload.reason ?? ""}`);
      return;
    }
    if (payload?.flagged || payload?.cleared || (payload?.confirmed?.length ?? 0) > 0) {
      log(
        `live=${payload.liveCount} apps=${payload.linkedApps} flagged=${payload.flagged} cleared=${payload.cleared} ` +
          `confirmed=${JSON.stringify(payload.confirmed ?? [])} reported=${JSON.stringify(payload.reported ?? [])}`
      );
    }
  } catch (error) {
    log(`tick failed: ${error?.name === "AbortError" ? "timed out" : error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
}

log(`ticking ${watchUrl} every ${intervalSeconds}s`);
await tick();
setInterval(() => {
  tick().catch((error) => log(`tick threw: ${error?.message || error}`));
}, intervalSeconds * 1000);
