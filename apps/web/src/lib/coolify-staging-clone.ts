/**
 * Provisioning a staging copy that is genuinely a CLONE of production.
 *
 * ## What was wrong
 *
 * Staging provisioning used to POST to a list of guessed endpoints —
 * `/applications/{uuid}/staging`, `/clone`, `/duplicate` — with a body of
 * `{ environment, fqdn, domain }`. Two of those routes do not exist in Coolify
 * at all, and the one that does rejected every call, because its validator is
 * an ALLOWLIST:
 *
 *   'destination_uuid' => 'required|string'
 *   $allowedFields = ['destination_uuid', 'name', 'clone_volumes']
 *   $extraFields = array_diff(array_keys($request->all()), $allowedFields)
 *      -> 'Validation failed.'
 *
 * So the request failed twice over: it omitted the one REQUIRED field and sent
 * three FORBIDDEN ones. Every attempt returned 422, which the caller reported
 * as "automatic staging provisioning is unavailable via current Coolify API
 * routes" — making a malformed request look like a missing feature. On this
 * platform that produced an empty staging environment, and the UI honestly
 * reported "Environment created / Target missing".
 *
 * ## Why it is two calls
 *
 * Coolify's clone endpoint has no way to choose the destination ENVIRONMENT —
 * the controller passes only `uuid` and `name` through as overrides, so a clone
 * always lands beside its source, in production. (`clone_application()` itself
 * would honour an `environment_id`, since it merges overrides last; the API
 * simply never exposes it.)
 *
 * The move endpoint is what completes the job:
 *
 *   'environment_uuid' => 'required|string'     // and NOTHING else is allowed
 *   $resource->update(['environment_id' => $newEnvironment->id])
 *
 * So: clone beside production, then move the clone into staging. Both are real,
 * supported, write-scoped routes, and the result is a true copy of production —
 * environment variables, build settings, domains and, with `clone_volumes`, the
 * persistent volume data — rather than a blank app pointed at the same repo.
 *
 * Everything here is pure so the exact request shapes are testable. Given how
 * this broke, the bodies are the part worth pinning down: a single stray key is
 * a 422.
 */

export type StagingCloneKind = "application" | "service" | "database";

/** Coolify's allowlist for the clone endpoint. Anything else is a 422. */
const CLONE_ALLOWED_FIELDS = ["destination_uuid", "name", "clone_volumes"] as const;

/** Coolify's allowlist for the move endpoint. Literally one field. */
const MOVE_ALLOWED_FIELDS = ["environment_uuid"] as const;

export type CoolifyRequest = { path: string; body: Record<string, unknown> };

export type StagingClonePlan =
  | {
      ok: true;
      /** Step one: copy production, beside production. */
      clone: CoolifyRequest;
      /** Step two: move that copy into the staging environment. */
      move: (clonedUuid: string) => CoolifyRequest;
      kind: StagingCloneKind;
    }
  | { ok: false; reason: "missing_destination" | "missing_staging_environment" | "missing_source"; message: string };

function segment(kind: StagingCloneKind): string {
  return kind === "service" ? "services" : kind === "database" ? "databases" : "applications";
}

/**
 * A staging name that is recognisable and stable.
 *
 * Coolify's own default is `clone-of-<name>-<random>`, which is neither. The
 * capability probe matches staging targets by name, so a predictable suffix is
 * what lets a later probe find this copy again.
 */
export function stagingCloneName(productionName: string): string {
  const base = (productionName || "app").trim().replace(/\s+/g, " ").slice(0, 40);
  return base.toLowerCase().endsWith("staging") ? base : `${base} staging`;
}

export function buildStagingClonePlan(input: {
  kind: StagingCloneKind;
  /** UUID of the production resource being copied. */
  sourceUuid: string;
  /** Docker destination the production resource runs on. Required by Coolify. */
  destinationUuid: string;
  /** UUID (not numeric id) of the target staging environment. */
  stagingEnvironmentUuid: string;
  productionName?: string;
  /**
   * Copy persistent volume data too. Defaults to true: a staging copy with the
   * production config but an empty uploads volume is not a copy of production,
   * which is the whole point of cloning rather than creating.
   */
  cloneVolumes?: boolean;
}): StagingClonePlan {
  const sourceUuid = input.sourceUuid?.trim() ?? "";
  const destinationUuid = input.destinationUuid?.trim() ?? "";
  const stagingEnvironmentUuid = input.stagingEnvironmentUuid?.trim() ?? "";

  if (!sourceUuid) {
    return { ok: false, reason: "missing_source", message: "No production resource to clone from." };
  }
  if (!destinationUuid) {
    // Refusing beats sending: Coolify requires this field, so a call without it
    // is a guaranteed 422 that would be misread as "the feature is unavailable".
    return {
      ok: false,
      reason: "missing_destination",
      message: "Could not resolve the server destination of the production app, which Coolify requires to clone it."
    };
  }
  if (!stagingEnvironmentUuid) {
    return {
      ok: false,
      reason: "missing_staging_environment",
      message: "No staging environment to move the clone into."
    };
  }

  const base = segment(input.kind);

  const cloneBody: Record<string, unknown> = {
    destination_uuid: destinationUuid,
    clone_volumes: input.cloneVolumes ?? true
  };
  if (input.productionName) {
    cloneBody.name = stagingCloneName(input.productionName);
  }

  return {
    ok: true,
    kind: input.kind,
    clone: { path: `/api/v1/${base}/${encodeURIComponent(sourceUuid)}/clone`, body: cloneBody },
    move: (clonedUuid: string) => ({
      path: `/api/v1/${base}/${encodeURIComponent(clonedUuid)}/move`,
      body: { environment_uuid: stagingEnvironmentUuid }
    })
  };
}

/**
 * Guard used by the tests, and worth keeping: it encodes the actual rule that
 * broke this, rather than trusting a reviewer to spot one extra key.
 */
export function bodyViolatesAllowlist(
  body: Record<string, unknown>,
  allowed: readonly string[]
): string[] {
  return Object.keys(body).filter((key) => !allowed.includes(key));
}

export const STAGING_CLONE_ALLOWLISTS = {
  clone: CLONE_ALLOWED_FIELDS,
  move: MOVE_ALLOWED_FIELDS
} as const;
