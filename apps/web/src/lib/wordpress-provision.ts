/**
 * Creating a WordPress site in Coolify from Jongo.
 *
 * Jongo could never create infrastructure: `POST /api/organizations/:id/sites`
 * only ever wrote a database row, and the Coolify uuid field on the form was a
 * lookup for a resource you had already made by hand. Adding an app therefore
 * appeared to do nothing in Coolify, because nothing ever called it.
 *
 * This builds the request. It is separated from the HTTP call so the parts that
 * are easy to get quietly wrong — the resource name, and refusing to proceed on
 * incomplete placement — are testable without a Coolify to talk to.
 *
 * The service TYPE is one of Coolify's own one-click templates. Every WordPress
 * app on this platform is `wordpress-with-mariadb`, and matching that matters
 * beyond taste: lib/coolify.ts keys capability detection off the same string,
 * so a site created as something else would be classified differently by the
 * backup and staging code that has to recognise it later.
 */

export const WORDPRESS_SERVICE_TYPE = "wordpress-with-mariadb";

export type WordPressProvisionInput = {
  /** Operator-supplied app name. */
  name: string;
  /** Coolify project the app belongs to. */
  projectUuid?: string | null;
  /** Server it runs on. */
  serverUuid?: string | null;
  /** Environment name; production unless told otherwise. */
  environmentName?: string | null;
  /** Resolved environment uuid when known — Coolify accepts either. */
  environmentUuid?: string | null;
  /** Optional Coolify destination (docker network). */
  destinationUuid?: string | null;
  /** Deploy immediately. A site that is created but not started looks broken. */
  instantDeploy?: boolean;
};

export type WordPressProvisionRequest =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: "name_required" | "project_required" | "server_required"; message: string };

export function buildWordPressServiceRequest(input: WordPressProvisionInput): WordPressProvisionRequest {
  const name = normalizeServiceName(input.name);
  if (!name) {
    return { ok: false, reason: "name_required", message: "A name is required to create the app." };
  }

  const projectUuid = trimmed(input.projectUuid);
  if (!projectUuid) {
    // Refuse rather than let Coolify pick. Creating a customer's site in the
    // wrong project is tedious to unpick and easy to not notice.
    return {
      ok: false,
      reason: "project_required",
      message: "No Coolify project is linked to this client, so there is nowhere to create the app."
    };
  }

  const serverUuid = trimmed(input.serverUuid);
  if (!serverUuid) {
    return {
      ok: false,
      reason: "server_required",
      message: "Could not determine which Coolify server to create the app on."
    };
  }

  const body: Record<string, unknown> = {
    type: WORDPRESS_SERVICE_TYPE,
    name,
    project_uuid: projectUuid,
    server_uuid: serverUuid,
    environment_name: trimmed(input.environmentName) || "production",
    // Default true: an app that exists but was never started reads to the owner
    // as a failed creation, and they retry — producing a second resource.
    instant_deploy: input.instantDeploy !== false
  };

  const environmentUuid = trimmed(input.environmentUuid);
  if (environmentUuid) body.environment_uuid = environmentUuid;

  const destinationUuid = trimmed(input.destinationUuid);
  if (destinationUuid) body.destination_uuid = destinationUuid;

  return { ok: true, body };
}

/**
 * Coolify resource names become container names and appear in domains, so they
 * are restricted to what is safe in both: lowercase, alphanumeric and dashes.
 */
export function normalizeServiceName(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

function trimmed(value: string | null | undefined): string {
  return String(value ?? "").trim();
}
