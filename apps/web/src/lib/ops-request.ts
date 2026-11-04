/**
 * Where a machine-token request may come from (security finding S-05).
 *
 * Every legitimate user of the ops tokens runs inside the Jongo container: the
 * worker, the backup/restore/staging jobs it starts, and the in-container
 * loops. They call the app on 127.0.0.1. So a machine token is accepted only
 * on a direct local request; through the public proxy it is ignored, and a
 * leaked token is useless from the internet.
 *
 * A request counts as direct and local when:
 *   - it carries no X-Real-IP (Traefik always sets it on proxied requests and
 *     overwrites any value a client sends), and
 *   - any X-Forwarded-For entries are loopback (Next.js fills it with the
 *     socket address when nothing upstream set it), and
 *   - its Host is 127.0.0.1, localhost or [::1] (Traefik only routes the
 *     public hostnames here).
 *
 * OPS_TOKEN_ALLOW_REMOTE=true restores remote use, for a worker running in a
 * separate container or an operator script run from outside. Keep it off.
 *
 * Edge-safe: used by middleware, so no Node APIs.
 */

type HeaderSource = { get(name: string): string | null };

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
  return value.split(":")[0];
}

export function isDirectLocalRequest(headers: HeaderSource): boolean {
  if ((headers.get("x-real-ip") ?? "").trim()) return false;
  if ((headers.get("forwarded") ?? "").trim()) return false;
  const forwardedFor = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (forwardedFor.some((entry) => !LOOPBACK.has(entry))) return false;
  return LOOPBACK.has(hostnameOf(headers.get("host") ?? ""));
}

export function remoteOpsTokenAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return (env.OPS_TOKEN_ALLOW_REMOTE ?? "").trim().toLowerCase() === "true";
}

/** May a machine token be honoured on this request at all? */
export function opsTokenOriginAllowed(headers: HeaderSource, env?: Record<string, string | undefined>): boolean {
  return isDirectLocalRequest(headers) || remoteOpsTokenAllowed(env);
}
