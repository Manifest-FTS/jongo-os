/**
 * Which Coolify calls "deploy this resource", in the order to try them. Pure.
 *
 * Coolify 4.3 moved every action endpoint to POST. The GET forms still exist
 * but only answer 405 "This endpoint has changed to a POST request", and
 * POST .../start answers 400 "Service is already running" for a running
 * service. Jongo tried GET first and "start" as its only POST, so every deploy
 * of a running service failed: promote to production reported
 * "Coolify deploy failed (405)" after production's content had already been
 * replaced.
 *
 * Order:
 *   1. POST restart: a service (WordPress, compose). Restarting is what a
 *      promote or a redeploy needs, and it also starts a stopped service. An
 *      application uuid gets 404 here and falls through.
 *   2. POST deploy?uuid=: an application (queues a build) or, failing 1, a
 *      service Coolify can start.
 *   3. The GET forms, for Coolify versions from before the change.
 */

export type DeployRequest = { method: "GET" | "POST"; path: string };

export function deployRequestPlan(uuid: string): DeployRequest[] {
  const id = encodeURIComponent(uuid);
  return [
    { method: "POST", path: `/api/v1/services/${id}/restart` },
    { method: "POST", path: `/api/v1/deploy?uuid=${id}` },
    { method: "GET", path: `/api/v1/services/${id}/start` },
    { method: "GET", path: `/api/v1/deploy?uuid=${id}` }
  ];
}

/** Worth waiting for and retrying the same call once: Coolify's rate limit. */
export function isRetryableDeployStatus(status: number): boolean {
  return status === 429;
}

/** Seconds to wait before that retry: Retry-After when sane, else 15, capped at 30. */
export function deployRetryDelaySeconds(retryAfterHeader: string | null): number {
  const parsed = Number(retryAfterHeader);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(30, Math.ceil(parsed));
  return 15;
}
