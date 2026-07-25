/**
 * Which Coolify server should a newly provisioned staging resource live on?
 *
 * Staging provisioning silently stopped working because this answer became
 * unobtainable. Coolify's API no longer exposes what the old lookup chain
 * depended on:
 *
 *   - GET /services/{uuid} returns no `server_uuid`, and `server_id: 0`
 *   - GET /servers returns entries with a `uuid` but NO `id` field
 *
 * so the fallback ("find the server whose id matches the service's server_id")
 * could never match, the resolver returned "", and the caller bailed out before
 * recording a single provisioning attempt. The toggle appeared to do nothing
 * and left no error behind — 18 apps had staging enabled with only 4 copies
 * actually created.
 *
 * The rule below: use what the service tells us; failing that, if the instance
 * has exactly one server, that is the only possible answer and is safe to use.
 * With several servers and no signal, REFUSE — provisioning a customer's
 * staging copy onto an arbitrary server is worse than not provisioning it, and
 * the caller must surface why instead of failing mute.
 */

export type ServerCandidate = { uuid?: unknown; id?: unknown; name?: unknown };

export type ServerResolution = {
  uuid: string;
  /** How it was determined, for the provisioning log. */
  source: "service_server_uuid" | "service_server_object" | "matched_by_id" | "only_server" | "unresolved";
  /** Set when unresolved, explaining what a human should do. */
  reason?: string;
};

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return String(value).trim();
}

export function resolveStagingServerUuid(input: {
  /** The source service payload from Coolify. */
  service: Record<string, unknown> | null | undefined;
  /** Everything GET /api/v1/servers returned. */
  servers: ServerCandidate[];
}): ServerResolution {
  const service = input.service ?? {};

  const direct = str(service.server_uuid);
  if (direct) return { uuid: direct, source: "service_server_uuid" };

  const nested = service.server;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const uuid = str((nested as Record<string, unknown>).uuid);
    if (uuid) return { uuid, source: "service_server_object" };
  }

  const servers = Array.isArray(input.servers) ? input.servers : [];

  // Only meaningful when BOTH sides actually carry an id. Coolify reports
  // server_id: 0 for services and omits id on servers, and "0" must never be
  // treated as a real identifier that happens to match a missing one.
  const serverId = str(service.server_id);
  if (serverId && serverId !== "0") {
    const matched = servers.find((s) => {
      const id = str(s.id);
      return id !== "" && id === serverId;
    });
    const uuid = matched ? str(matched.uuid) : "";
    if (uuid) return { uuid, source: "matched_by_id" };
  }

  // Unambiguous: one server means there is no choice to get wrong.
  const withUuid = servers.filter((s) => str(s.uuid) !== "");
  if (withUuid.length === 1) {
    return { uuid: str(withUuid[0].uuid), source: "only_server" };
  }

  if (withUuid.length === 0) {
    return {
      uuid: "",
      source: "unresolved",
      reason:
        "Coolify returned no servers, so there is nowhere to create the staging copy. Check the API token's permissions and that at least one server is reachable."
    };
  }

  return {
    uuid: "",
    source: "unresolved",
    reason: `Coolify did not say which of its ${withUuid.length} servers this app runs on, so staging was not created rather than guessing. Create the staging resource in Coolify, or set the server explicitly.`
  };
}
