/**
 * Address for the app to call its own machine-token endpoints.
 *
 * Always the local server: machine tokens are honoured only on direct local
 * requests (lib/ops-request.ts), and a public address can move — the old
 * jongo.manifest-fts.com started answering 503 while the app itself was fine.
 */
export function localAppUrl(path: string): string {
  const port = (process.env.PORT || "3000").trim() || "3000";
  return `http://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`;
}

const STAGING_SYNC_PATH = "/api/ops/staging-sync-automation";

/**
 * The staging content-sync endpoint. STAGING_SYNC_AUTOMATION_URL used to name
 * this app's own public address; when it points at this same endpoint it is
 * called locally instead. Only a genuinely different service is called remotely.
 */
export function stagingSyncAutomationUrl(): string {
  const configured = (process.env.STAGING_SYNC_AUTOMATION_URL || "").trim();
  if (!configured) return localAppUrl(STAGING_SYNC_PATH);
  try {
    if (new URL(configured).pathname.replace(/\/+$/, "") === STAGING_SYNC_PATH) return localAppUrl(STAGING_SYNC_PATH);
  } catch {
    return localAppUrl(STAGING_SYNC_PATH);
  }
  return configured;
}
