import { pathToFileURL } from "node:url";

export const DAILY_INTERVAL_MS = 24 * 60 * 60_000;

export function resolveSyncUrl(env = process.env) {
  const url = new URL(env.NAMECHEAP_SYNC_URL?.trim() || `http://127.0.0.1:${env.PORT?.trim() || "3000"}/api/ops/domains-sync-namecheap`);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/api/ops/domains-sync-namecheap" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Invalid Namecheap sync endpoint configuration.");
  }
  return url;
}

/** Never log headers, tokens, redirect locations, or raw endpoint responses. */
export async function syncOnce(env = process.env, fetcher = fetch) {
  const token = env.NAMECHEAP_SYNC_TOKEN?.trim();
  if (!token) throw new Error("NAMECHEAP_SYNC_TOKEN is required.");
  const response = await fetcher(resolveSyncUrl(env), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(720_000)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) throw new Error(`Namecheap sync failed (HTTP ${response.status}).`);
  const count = (key) => Number.isSafeInteger(payload[key]) && payload[key] >= 0 ? payload[key] : 0;
  console.log(`[namecheap-sync] pages=${count("pages")} fetched=${count("fetched")} imported=${count("imported")} updated=${count("updated")} skipped=${count("skipped")}`);
  return payload;
}

export async function runScheduler() {
  if (!process.env.NAMECHEAP_SYNC_TOKEN?.trim()) throw new Error("NAMECHEAP_SYNC_TOKEN is required.");
  resolveSyncUrl();
  // Starts alongside Next: retry the initial call while the server warms up.
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await syncOnce();
      break;
    } catch {
      if (attempt === 5) console.error("[namecheap-sync] Initial sync failed; check endpoint access and configuration.");
      else await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
  // Sequential scheduling prevents local overlaps; the DB lease handles replicas.
  async function tick() {
    try { await syncOnce(); }
    catch { console.error("[namecheap-sync] Daily sync failed; check endpoint access and configuration."); }
    setTimeout(tick, DAILY_INTERVAL_MS);
  }
  setTimeout(tick, DAILY_INTERVAL_MS);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes("--once")) await syncOnce();
    else await runScheduler();
  } catch {
    console.error("[namecheap-sync] Cannot run sync; verify NAMECHEAP_SYNC_TOKEN and endpoint configuration.");
    process.exitCode = 1;
  }
}