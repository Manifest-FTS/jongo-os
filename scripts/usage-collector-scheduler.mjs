/**
 * Usage collector scheduler.
 *
 * POSTs /api/ops/usage-collect every USAGE_COLLECT_INTERVAL_MINUTES (default 5).
 * Each call reads every container's cumulative CPU and network counters on the
 * Docker host and folds the difference since the last call into hourly usage.
 * Because the counters are cumulative, a missed tick loses no data — the next
 * one simply covers a longer interval.
 *
 * Mirrors backup-reconcile-scheduler.mjs: same token, same URL resolution, and
 * the same startup retry (the scheduler starts alongside the web server and its
 * first call usually races it).
 */

function normalizeBaseUrl(value) {
  return (value || "").trim().replace(/\/+$/, "");
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveUrl() {
  const direct = (process.env.USAGE_COLLECT_URL || "").trim();
  if (direct) return direct;
  const base = normalizeBaseUrl(process.env.NEXTAUTH_URL);
  if (base) return `${base}/api/ops/usage-collect`;
  const port = (process.env.PORT || "3000").trim() || "3000";
  return `http://127.0.0.1:${port}/api/ops/usage-collect`;
}

async function collectOnce() {
  const token = (process.env.BACKUP_RECONCILE_TOKEN || process.env.OWNERSHIP_SYNC_TOKEN || "").trim();
  if (!token) throw new Error("BACKUP_RECONCILE_TOKEN (or OWNERSHIP_SYNC_TOKEN) is required");

  const response = await fetch(resolveUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    // Do not follow redirects: a 307 here means the middleware sent us to the
    // login page, and following it turns that into an unreadable HTML error.
    redirect: "manual",
    signal: AbortSignal.timeout(300_000)
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `redirected to ${response.headers.get("location") || "another page"} — the middleware is not letting ` +
        "/api/ops/usage-collect through with this token, so nothing is being recorded"
    );
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || payload.ok !== true) {
    const message = payload && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(`usage collect failed: ${message}`);
  }
  if (payload.skipped) {
    console.log(`[usage-collect] skipped: ${payload.reason}`);
    return;
  }
  console.log(
    `[usage-collect] host=${payload.host} containers=${payload.containers} subjects=${payload.subjects}` +
      ` disk=${payload.withDisk ? "yes" : "no"} ${payload.durationMs}ms` +
      (payload.skippedStale ? ` stale=${payload.skippedStale}` : "") +
      (payload.droppedGaps ? ` droppedGaps=${payload.droppedGaps}` : "") +
      (payload.rejectedLines ? ` WARNING rejectedLines=${payload.rejectedLines}` : "")
  );
}

async function runWithSchedule() {
  const minutes = toPositiveInt(process.env.USAGE_COLLECT_INTERVAL_MINUTES, 5);
  console.log(`[usage-collect] scheduler enabled (every ${minutes} minute(s))`);

  const attempts = toPositiveInt(process.env.USAGE_COLLECT_STARTUP_ATTEMPTS, 5);
  const backoffMs = toPositiveInt(process.env.USAGE_COLLECT_STARTUP_BACKOFF_MS, 15000);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await collectOnce();
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === attempts) {
        console.error(`[usage-collect] initial run failed after ${attempts} attempts: ${message}`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  let running = false;
  setInterval(async () => {
    if (running) return; // never stack a second call on a slow one
    running = true;
    try {
      await collectOnce();
    } catch (error) {
      console.error(`[usage-collect] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  }, minutes * 60 * 1000);
}

if (process.argv.includes("--once")) {
  try {
    await collectOnce();
    process.exit(0);
  } catch (error) {
    console.error(`[usage-collect] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else {
  await runWithSchedule();
}
