/** Creating and removing staging environments and copies (split out of lib/coolify.ts; import from "@/lib/coolify"). */
import { resolveStagingServerUuid, type ServerResolution } from "./coolify-server-resolve";
import { encodeComposeForCoolify } from "./compose-encoding";
import { retryOnceAfterRateLimit } from "./rate-limit-retry";
import { extractCreatedResourceUuid } from "./staging-capability-refresh";
import { CoolifyActionResult, StagingEnvironmentResolution, buildStagingResourceName, coolifyFetch, coolifyMutate, coolifyMutateWithResponse, ensureArray, resolveCoolifyProjectEndpointId, stringValue, toHttpsUrl } from "./coolify-core";
import { getCoolifyAppStagingCapability } from "./coolify-staging-capability";

export function isLikelyStagingEnvironmentName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized.includes("stag") || normalized.includes("preview") || normalized === "dev";
}

export async function ensureCoolifyStagingEnvironment(projectId: string): Promise<CoolifyActionResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    return {
      mode: "mock",
      ok: false,
      message: "Hosting credentials missing. Staging can't be created right now.",
      reason: "credentials_missing"
    };
  }

  try {
    const projectEndpointId = await resolveCoolifyProjectEndpointId(projectId);
    const projectPayload = await coolifyFetch(`/api/v1/projects/${projectEndpointId}`);
    const projectObj = projectPayload && typeof projectPayload === "object" && !Array.isArray(projectPayload)
      ? (projectPayload as Record<string, unknown>)
      : {};
    const environments = ensureArray(projectObj.environments ?? []);

    const existingStagingEnv = environments.find((env) => {
      const name = stringValue(env as Record<string, unknown>, ["name", "environment_name"], "");
      return isLikelyStagingEnvironmentName(name);
    });

    if (existingStagingEnv) {
      return {
        mode: "live",
        ok: true,
        message: "Staging environment already exists.",
        reason: "environment_ready"
      };
    }

    const created = await coolifyMutateWithResponse(
      `/api/v1/projects/${encodeURIComponent(projectEndpointId)}/environments`,
      "POST",
      { name: "staging" }
    );

    if (created.ok) {
      return {
        mode: "live",
        ok: true,
        message: "Staging environment created.",
        reason: "environment_created"
      };
    }

    // POST /projects/{uuid}/environments exists and requires api.ability:write.
    // Reporting every failure as "unsupported" hides the actual cause (403 for a
    // read-only token, 403 from the instance allowed_ips list, 422 for payload).
    const detail = (() => {
      const body = created.body as Record<string, unknown> | undefined;
      if (body?.errors && typeof body.errors === "object") {
        return JSON.stringify(body.errors);
      }
      return typeof body?.message === "string" ? body.message : created.error;
    })();

    return {
      mode: "live",
      ok: false,
      message: `Creating the staging environment was rejected (HTTP ${created.status ?? "n/a"})${detail ? `: ${detail}` : "."}`,
      reason: created.status === 403 ? "forbidden" : "environment_create_failed",
      status: created.status
    };
  } catch (error) {
    return {
      mode: "live",
      ok: false,
      message: `Staging environment creation failed: ${error instanceof Error ? error.message : "unknown error"}`,
      reason: "environment_create_failed"
    };
  }
}

export async function deleteCoolifyStagingEnvironment(projectId: string): Promise<CoolifyActionResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    return {
      mode: "mock",
      ok: false,
      message: "Hosting credentials missing. Staging can't be removed right now.",
      reason: "credentials_missing"
    };
  }

  try {
    const projectEndpointId = await resolveCoolifyProjectEndpointId(projectId);
    const projectPayload = await coolifyFetch(`/api/v1/projects/${projectEndpointId}`);
    const projectObj = projectPayload && typeof projectPayload === "object" && !Array.isArray(projectPayload)
      ? (projectPayload as Record<string, unknown>)
      : {};
    const environments = ensureArray(projectObj.environments ?? []);

    const stagingEnv = environments.find((env) => {
      const name = stringValue(env as Record<string, unknown>, ["name", "environment_name"], "");
      return isLikelyStagingEnvironmentName(name);
    }) as Record<string, unknown> | undefined;

    if (!stagingEnv) {
      return {
        mode: "live",
        ok: true,
        message: "There is no staging environment to delete.",
        reason: "environment_ready"
      };
    }

    const envUuid = stringValue(stagingEnv, ["uuid"], "");
    const envId = stringValue(stagingEnv, ["id"], "");
    if (!envUuid && !envId) {
      return {
        mode: "live",
        ok: false,
        message: "The staging environment could not be identified exactly, so it was not deleted.",
        reason: "auto_provision_unsupported"
      };
    }

    const deletePaths: string[] = [];
    if (envUuid) {
      deletePaths.push(`/api/v1/projects/${encodeURIComponent(projectEndpointId)}/environments/${encodeURIComponent(envUuid)}`);
    }
    if (envId) {
      deletePaths.push(`/api/v1/projects/${encodeURIComponent(projectEndpointId)}/environments/${encodeURIComponent(envId)}`);
    }

    let deleted = false;
    for (const path of deletePaths) {
      deleted = await coolifyMutate(path, "DELETE");
      if (deleted) {
        break;
      }
    }

    if (deleted) {
      return {
        mode: "live",
        ok: true,
        message: "Staging environment deleted.",
        reason: "environment_deleted"
      };
    }
  } catch {
    // Fall through to unsupported result.
  }

  return {
    mode: "live",
    ok: false,
    message: "The staging environment could not be deleted just now. Try again in a minute.",
    reason: "auto_provision_unsupported"
  };
}

export async function provisionCoolifyStagingFromProduction(
  appUuid: string,
  preferredStagingDomain?: string,
  projectId?: string,
  options: { serverUuid?: string | null } = {}
): Promise<CoolifyActionResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    return {
      mode: "mock",
      ok: false,
      message: "Hosting credentials missing. Staging can't be set up right now.",
      reason: "credentials_missing"
    };
  }

  const normalizedPreferredDomain = preferredStagingDomain ? toHttpsUrl(preferredStagingDomain) : undefined;
  // Filled when several servers exist and none is known, so the admin can pick one in Jongo.
  let serverChoices: Array<{ uuid: string; name: string }> | undefined;
  const provisioningAttempts: Array<{
    path: string;
    method: "POST" | "PATCH" | "PUT" | "DELETE";
    ok: boolean;
    status?: number;
    error?: string;
  }> = [];

  const resolveProvisioningResource = async (): Promise<{
    kind: "service" | "application" | "unknown";
    uuid: string;
  }> => {
    try {
      const servicePayload = await coolifyFetch(`/api/v1/services/${encodeURIComponent(appUuid)}`);
      if (servicePayload && typeof servicePayload === "object" && !Array.isArray(servicePayload)) {
        const service = servicePayload as Record<string, unknown>;
        return {
          kind: "service",
          uuid: stringValue(service, ["uuid", "id"], "") || appUuid
        };
      }
    } catch {
      // Continue to application lookup.
    }

    try {
      const applicationPayload = await coolifyFetch(`/api/v1/applications/${encodeURIComponent(appUuid)}`);
      if (applicationPayload && typeof applicationPayload === "object" && !Array.isArray(applicationPayload)) {
        const application = applicationPayload as Record<string, unknown>;
        return {
          kind: "application",
          uuid: stringValue(application, ["uuid", "id"], "") || appUuid
        };
      }
    } catch {
      // Fall through.
    }

    return { kind: "unknown", uuid: appUuid };
  };

  const provisioningResource = await resolveProvisioningResource();

  // Strict throughout provisioning: the relaxed rule's lone-candidate fallback
  // adopted another app's staging copy as this one's (see staging-target-match
  // tests). Provisioning creates or recognises only this app's own copy.
  const existingCapability = await getCoolifyAppStagingCapability(appUuid, projectId, {
    relaxedTargetMatch: false
  });
  if (existingCapability.detected && existingCapability.applicationUuid) {
    return {
      mode: "live",
      ok: true,
      message: "Staging copy already exists.",
      reason: "environment_ready"
    };
  }

  const verifyStagingTarget = async (): Promise<boolean> => {
    const capability = await getCoolifyAppStagingCapability(appUuid, projectId, {
      relaxedTargetMatch: false
    });
    if (capability.detected && capability.applicationUuid) {
      return true;
    }

    for (const retryDelayMs of [500, 1000, 2000, 4000]) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      const retriedCapability = await getCoolifyAppStagingCapability(appUuid, projectId, {
        relaxedTargetMatch: false
      });
      if (retriedCapability.detected && retriedCapability.applicationUuid) {
        return true;
      }
    }

    return false;
  };

  const resolveStagingEnvironment = async (): Promise<StagingEnvironmentResolution | null> => {
    if (!projectId) {
      return null;
    }

    try {
      const projectEndpointId = await resolveCoolifyProjectEndpointId(projectId);
      const projectPayload = await coolifyFetch(`/api/v1/projects/${projectEndpointId}`);
      const projectObj = projectPayload && typeof projectPayload === "object" && !Array.isArray(projectPayload)
        ? (projectPayload as Record<string, unknown>)
        : {};
      let environments = ensureArray(projectObj.environments ?? []);

      let stagingEnvironment = environments.find((env) => {
        const name = stringValue(env as Record<string, unknown>, ["name", "environment_name"], "");
        return isLikelyStagingEnvironmentName(name);
      }) as Record<string, unknown> | undefined;

      let created = false;
      if (!stagingEnvironment) {
        const createResult = await coolifyMutateWithResponse(
          `/api/v1/projects/${encodeURIComponent(projectEndpointId)}/environments`,
          "POST",
          { name: "staging" }
        );
        provisioningAttempts.push({
          path: `/api/v1/projects/${encodeURIComponent(projectEndpointId)}/environments`,
          method: "POST",
          ok: createResult.ok,
          status: createResult.status,
          error: createResult.error
        });

        if (createResult.ok) {
          created = true;
          const refreshedProjectPayload = await coolifyFetch(`/api/v1/projects/${projectEndpointId}`);
          const refreshedProjectObj = refreshedProjectPayload && typeof refreshedProjectPayload === "object" && !Array.isArray(refreshedProjectPayload)
            ? (refreshedProjectPayload as Record<string, unknown>)
            : {};
          environments = ensureArray(refreshedProjectObj.environments ?? []);
          stagingEnvironment = environments.find((env) => {
            const name = stringValue(env as Record<string, unknown>, ["name", "environment_name"], "");
            return isLikelyStagingEnvironmentName(name);
          }) as Record<string, unknown> | undefined;
        }
      }

      return {
        projectEndpointId,
        stagingEnvironmentId: stagingEnvironment
          ? stringValue(stagingEnvironment, ["uuid", "id"], "") || undefined
          : undefined,
        stagingEnvironmentName: stagingEnvironment
          ? stringValue(stagingEnvironment, ["name", "environment_name"], "") || undefined
          : undefined,
        created
      };
    } catch {
      return null;
    }
  };

  const createServiceFromSource = async (stagingEnvironment: StagingEnvironmentResolution): Promise<{
    created: boolean;
    resourceUuid?: string;
  }> => {
    if (!stagingEnvironment.stagingEnvironmentId || !stagingEnvironment.stagingEnvironmentName) {
      return { created: false };
    }

    let sourceService: Record<string, unknown> | null = null;
    try {
      const sourceServiceUuid = provisioningResource.kind === "service"
        ? provisioningResource.uuid
        : appUuid;
      const payload = await coolifyFetch(`/api/v1/services/${encodeURIComponent(sourceServiceUuid)}`);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        sourceService = payload as Record<string, unknown>;
      }
    } catch {
      sourceService = null;
    }

    if (!sourceService) {
      return { created: false };
    }

    // Coolify stopped exposing server_uuid on services and id on servers, which
    // silently broke this. See lib/coolify-server-resolve.ts for the rationale
    // and the tests; the decision itself is kept pure and out of this closure.
    let serverResolution: ServerResolution = { uuid: "", source: "unresolved" };
    const resolveServerUuid = async (): Promise<string> => {
      let servers: Array<Record<string, unknown>> = [];
      try {
        servers = ensureArray(await coolifyFetch("/api/v1/servers"));
      } catch {
        servers = [];
      }
      serverResolution = resolveStagingServerUuid({ service: sourceService, servers, chosenServerUuid: options.serverUuid });
      serverChoices = serverResolution.choices;
      return serverResolution.uuid;
    };

    const resolveDestinationUuid = async (serverUuid: string): Promise<string> => {
      const directDestinationUuid =
        stringValue(sourceService!, ["destination_uuid"], "") ||
        (typeof sourceService!.destination === "object" && sourceService!.destination !== null
          ? stringValue(sourceService!.destination as Record<string, unknown>, ["uuid"], "")
          : "");
      if (directDestinationUuid) {
        return directDestinationUuid;
      }

      const destinationId = stringValue(sourceService!, ["destination_id"], "");
      if (!destinationId || !serverUuid) {
        return "";
      }

      try {
        const serverPayload = await coolifyFetch(`/api/v1/servers/${encodeURIComponent(serverUuid)}`);
        if (!serverPayload || typeof serverPayload !== "object" || Array.isArray(serverPayload)) {
          return "";
        }

        const serverObj = serverPayload as Record<string, unknown>;
        const destinations = ensureArray(serverObj.destinations ?? serverObj.destination ?? []);
        const matched = destinations.find((destination) => stringValue(destination, ["id"], "") === destinationId);
        if (!matched) {
          return "";
        }

        return stringValue(matched, ["uuid"], "");
      } catch {
        return "";
      }
    };

    const resolvedProjectId =
      projectId ||
      stringValue(sourceService, ["project_uuid", "project_id", "project"], "");

    const serverUuid = await resolveServerUuid();
    const destinationUuid = await resolveDestinationUuid(serverUuid);
    const serviceType = stringValue(sourceService, ["service_type", "type"], "");
    const dockerComposeRaw = stringValue(sourceService, ["docker_compose_raw"], "");
    const sourceName = stringValue(sourceService, ["name"], "service");
    const preferredServiceNameSeed = normalizedPreferredDomain
      ? (() => {
          try {
            const host = new URL(normalizedPreferredDomain).hostname;
            return host.split(".")[0] || "";
          } catch {
            return "";
          }
        })()
      : "";

    if (!serverUuid || !resolvedProjectId) {
      // Record WHY. Returning false with no attempt logged is what made this
      // look like the toggle simply did nothing.
      provisioningAttempts.push({
        path: "/api/v1/services",
        method: "POST",
        ok: false,
        error: !serverUuid
          ? serverResolution.reason ?? "Could not determine which server to create the staging copy on."
          : "Could not determine which project the staging copy belongs to."
      });
      return { created: false };
    }

    const baseBody: Record<string, unknown> = {
      name: buildStagingResourceName(preferredServiceNameSeed || sourceName),
      project_uuid: resolvedProjectId,
      environment_name: stagingEnvironment.stagingEnvironmentName,
      environment_uuid: stagingEnvironment.stagingEnvironmentId,
      server_uuid: serverUuid,
      instant_deploy: false
    };

    if (destinationUuid) {
      baseBody.destination_uuid = destinationUuid;
    }

    if (normalizedPreferredDomain) {
      // Intentionally omitting urls during creation.
      // Domain assignment is orchestrated separately to ensure deterministic convergence.
    }

    const candidateBodies: Record<string, unknown>[] = [];
    if (dockerComposeRaw) {
      // Coolify hands compose back as raw YAML but refuses it on the way in
      // unless base64 encoded, so posting it verbatim always 422'd and staging
      // fell through to the one-click template — a fresh service rather than a
      // copy of production.
      candidateBodies.push({
        ...baseBody,
        docker_compose_raw: encodeComposeForCoolify(dockerComposeRaw)
      });
    }
    if (serviceType) {
      candidateBodies.push({
        ...baseBody,
        type: serviceType
      });
    }

    if (candidateBodies.length === 0) {
      provisioningAttempts.push({
        path: "/api/v1/services",
        method: "POST",
        ok: false,
        error:
          "This app has no service type or compose file to copy, so staging can't be created for it yet."
      });
      return { created: false };
    }

    for (const body of candidateBodies) {
      const createResult = await coolifyMutateWithResponse("/api/v1/services", "POST", body);
      provisioningAttempts.push({
        path: "/api/v1/services",
        method: "POST",
        ok: createResult.ok,
        status: createResult.status,
        error: createResult.error
      });
      if (!createResult.ok) {
        continue;
      }

      return {
        created: true,
        resourceUuid: extractCreatedResourceUuid(createResult.body)
      };
    }

    return { created: false };
  };

  /**
   * Apps (Next.js, Sanity, Dockerfile, …): Coolify has no clone endpoint for
   * applications, so staging is a new application in the staging environment
   * built from the same repo, source and build settings, with production's
   * environment variables (lib/staging-app-copy.ts decides the request).
   */
  const createApplicationFromSource = async (stagingEnvironment: StagingEnvironmentResolution): Promise<{ created: boolean; resourceUuid?: string }> => {
    if (!stagingEnvironment.stagingEnvironmentId && !stagingEnvironment.stagingEnvironmentName) return { created: false };
    let source: Record<string, unknown> | null = null;
    try {
      const payload = await coolifyFetch(`/api/v1/applications/${encodeURIComponent(provisioningResource.uuid || appUuid)}`);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) source = payload as Record<string, unknown>;
    } catch {
      source = null;
    }
    if (!source) return { created: false };

    const { buildStagingAppCopyRequest, stagingEnvVarsToCopy } = await import("./staging-app-copy");
    const destination = typeof source.destination === "object" && source.destination !== null ? (source.destination as Record<string, unknown>) : {};
    const destinationServer = typeof destination.server === "object" && destination.server !== null ? (destination.server as Record<string, unknown>) : {};
    let servers: Array<Record<string, unknown>> = [];
    try {
      servers = ensureArray(await coolifyFetch("/api/v1/servers"));
    } catch {
      servers = [];
    }
    const serverResolution = resolveStagingServerUuid({
      service: {
        server_uuid: stringValue(destinationServer, ["uuid"], ""),
        server_id: stringValue(destination, ["server_id"], "")
      },
      servers,
      chosenServerUuid: options.serverUuid
    });
    serverChoices = serverResolution.choices;

    const githubApps = stringValue(source, ["source_type"], "").endsWith("GithubApp") ? ensureArray(await coolifyFetch("/api/v1/github-apps").catch(() => [])) : [];
    const privateKeys = source.private_key_id ? ensureArray(await coolifyFetch("/api/v1/security/keys").catch(() => [])) : [];
    const seed = normalizedPreferredDomain
      ? (() => {
          try {
            return new URL(normalizedPreferredDomain).hostname.split(".")[0] || "";
          } catch {
            return "";
          }
        })()
      : "";
    const request = buildStagingAppCopyRequest({
      source,
      githubApps,
      privateKeys,
      placement: {
        projectUuid: projectId || "",
        serverUuid: serverResolution.uuid,
        environmentName: stagingEnvironment.stagingEnvironmentName ?? "",
        environmentUuid: stagingEnvironment.stagingEnvironmentId ?? "",
        destinationUuid: stringValue(destination, ["uuid"], "")
      },
      name: buildStagingResourceName(seed || stringValue(source, ["name"], "app")),
      domain: normalizedPreferredDomain ?? null
    });
    if (!request.ok) {
      provisioningAttempts.push({
        path: "/api/v1/applications",
        method: "POST",
        ok: false,
        error: request.reason === "no_placement" ? serverResolution.reason ?? "Could not determine where to create the staging app." : `Can't copy this app for staging (${request.reason}).`
      });
      return { created: false };
    }

    const created = await coolifyMutateWithResponse(request.path, "POST", request.body);
    provisioningAttempts.push({ path: request.path, method: "POST", ok: created.ok, status: created.status, error: created.error });
    const createdUuid = created.ok ? extractCreatedResourceUuid(created.body) : undefined;
    if (!createdUuid) return { created: false };

    // Production's variables, so the staging build behaves like production.
    try {
      const envs = ensureArray(await coolifyFetch(`/api/v1/applications/${encodeURIComponent(provisioningResource.uuid || appUuid)}/envs`));
      const data = stagingEnvVarsToCopy(envs);
      if (data.length) {
        const copied = await coolifyMutateWithResponse(`/api/v1/applications/${encodeURIComponent(createdUuid)}/envs/bulk`, "PATCH", { data });
        provisioningAttempts.push({ path: `/api/v1/applications/${createdUuid}/envs/bulk`, method: "PATCH", ok: copied.ok, status: copied.status, error: copied.error });
      }
    } catch {
      provisioningAttempts.push({ path: `/api/v1/applications/${createdUuid}/envs/bulk`, method: "PATCH", ok: false, error: "Could not copy environment variables." });
    }
    return { created: true, resourceUuid: createdUuid };
  };

  if (provisioningResource.kind === "application") {
    const stagingEnvironment = await resolveStagingEnvironment();
    if (stagingEnvironment) {
      const copied = await createApplicationFromSource(stagingEnvironment);
      if (copied.created) {
        return {
          mode: "live",
          ok: true,
          message: "Staging copy created. Its first build starts now.",
          reason: "service_created",
          resourceUuid: copied.resourceUuid,
          resourceKind: "application",
          attempts: provisioningAttempts
        };
      }
    }
  }

  const resourceUuid = encodeURIComponent(provisioningResource.uuid || appUuid);
  const serviceCandidateRequests: Array<{ path: string; body?: Record<string, unknown> }> = [
    {
      path: `/api/v1/services/${resourceUuid}/staging`,
      body: normalizedPreferredDomain
        ? { fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : undefined
    },
    {
      path: `/api/v1/services/${resourceUuid}/clone`,
      body: normalizedPreferredDomain
        ? { environment: "staging", fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : { environment: "staging" }
    },
    {
      path: `/api/v1/services/${resourceUuid}/duplicate`,
      body: normalizedPreferredDomain
        ? { environment: "staging", fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : { environment: "staging" }
    }
  ];
  const applicationCandidateRequests: Array<{ path: string; body?: Record<string, unknown> }> = [
    {
      path: `/api/v1/applications/${resourceUuid}/staging`,
      body: normalizedPreferredDomain
        ? { fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : undefined
    },
    {
      path: `/api/v1/applications/${resourceUuid}/clone`,
      body: normalizedPreferredDomain
        ? { environment: "staging", fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : { environment: "staging" }
    },
    {
      path: `/api/v1/applications/${resourceUuid}/duplicate`,
      body: normalizedPreferredDomain
        ? { environment: "staging", fqdn: normalizedPreferredDomain, domain: normalizedPreferredDomain }
        : { environment: "staging" }
    }
  ];

  const fallbackUuid = encodeURIComponent(appUuid);
  const fallbackCandidateRequests = provisioningResource.uuid !== appUuid
    ? [
        ...serviceCandidateRequests.map((request) => ({
          ...request,
          path: request.path.replace(resourceUuid, fallbackUuid)
        })),
        ...applicationCandidateRequests.map((request) => ({
          ...request,
          path: request.path.replace(resourceUuid, fallbackUuid)
        }))
      ]
    : [];

  const candidateRequests: Array<{ path: string; body?: Record<string, unknown> }> = provisioningResource.kind === "service"
    ? [...serviceCandidateRequests, ...applicationCandidateRequests, ...fallbackCandidateRequests]
    : provisioningResource.kind === "application"
      ? [...applicationCandidateRequests, ...serviceCandidateRequests, ...fallbackCandidateRequests]
      : [...serviceCandidateRequests, ...applicationCandidateRequests, ...fallbackCandidateRequests];

  for (const request of candidateRequests) {
    const result = await retryOnceAfterRateLimit(
      () => coolifyMutateWithResponse(request.path, "POST", request.body)
    );
    provisioningAttempts.push({
      path: request.path,
      method: "POST",
      ok: result.ok,
      status: result.status,
      error: result.error
    });
    if (result.ok) {
      const verified = await verifyStagingTarget();
      return {
        mode: "live",
        ok: true,
        message: verified
          ? "Staging setup started."
          : "Staging setup was accepted and is still finishing.",
        reason: "request_sent",
        resourceUuid: extractCreatedResourceUuid(result.body),
        attempts: provisioningAttempts
      };
    }
  }

  const stagingEnvironment = await resolveStagingEnvironment();
  if (stagingEnvironment?.created) {
    const verifiedAfterCreate = await verifyStagingTarget();
    if (verifiedAfterCreate) {
      return {
        mode: "live",
        ok: true,
        message: "Staging environment created.",
        reason: "environment_created",
        attempts: provisioningAttempts
      };
    }
  }

  if (stagingEnvironment) {
    const createdFromSource = await createServiceFromSource(stagingEnvironment);
    if (createdFromSource.created) {
      return {
        mode: "live",
        ok: true,
        message: "Staging copy created.",
        reason: "service_created",
        resourceUuid: createdFromSource.resourceUuid,
        attempts: provisioningAttempts
      };
    }
  }

  if (projectId) {
    const ensuredEnvironment = await ensureCoolifyStagingEnvironment(projectId);
    if (ensuredEnvironment.ok && await verifyStagingTarget()) {
      return ensuredEnvironment;
    }
  }

  if (serverChoices?.length) {
    return {
      mode: "live",
      ok: false,
      message: "Choose which server the staging copy should run on, then try again.",
      reason: "server_choice_needed",
      serverChoices,
      attempts: provisioningAttempts
    };
  }

  return {
    mode: "live",
    ok: false,
    message: "Staging isn't available for this kind of app yet.",
    reason: "auto_provision_unsupported",
    attempts: provisioningAttempts
  };
}

export async function destroyCoolifyApplication(
  appUuid: string,
  resourceKind?: "application" | "service" | "database" | "unknown"
): Promise<CoolifyActionResult> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;

  if (!baseUrl || !token) {
    return {
      mode: "mock",
      ok: false,
      message: "Hosting credentials missing. Staging can't be removed right now."
    };
  }

  const orderedKinds: Array<"application" | "service" | "database"> = resourceKind === "application"
    ? ["application", "service", "database"]
    : resourceKind === "service"
      ? ["service", "application", "database"]
      : resourceKind === "database"
        ? ["database", "application", "service"]
        : ["application", "service", "database"];

  const deletePathsByKind: Record<"application" | "service" | "database", string[]> = {
    application: [
      `/api/v1/applications/${encodeURIComponent(appUuid)}`,
      `/api/v1/resources/${encodeURIComponent(appUuid)}`
    ],
    service: [
      `/api/v1/services/${encodeURIComponent(appUuid)}`,
      `/api/v1/resources/${encodeURIComponent(appUuid)}`
    ],
    database: [
      `/api/v1/databases/${encodeURIComponent(appUuid)}`,
      `/api/v1/resources/${encodeURIComponent(appUuid)}`
    ]
  };

  for (const kind of orderedKinds) {
    for (const path of deletePathsByKind[kind]) {
      const result = await retryOnceAfterRateLimit(
        () => coolifyMutateWithResponse(path, "DELETE")
      );
      if (!result.ok) {
        continue;
      }

      return {
        mode: "live",
        ok: true,
        message: "Staging copy removed.",
        reason: "resource_deleted"
      };
    }
  }

  // Some deployments expose delete semantics via POST action routes.
  const actionPaths = [
    `/api/v1/services/${encodeURIComponent(appUuid)}/delete`,
    `/api/v1/applications/${encodeURIComponent(appUuid)}/delete`
  ];

  for (const path of actionPaths) {
    const result = await retryOnceAfterRateLimit(
      () => coolifyMutateWithResponse(path, "POST")
    );
    if (result.ok) {
      return {
        mode: "live",
        ok: true,
        message: "Staging copy removed.",
        reason: "resource_deleted"
      };
    }
  }

  const probePaths = [
    `/api/v1/applications/${encodeURIComponent(appUuid)}`,
    `/api/v1/services/${encodeURIComponent(appUuid)}`,
    `/api/v1/databases/${encodeURIComponent(appUuid)}`
  ];

  for (const path of probePaths) {
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        }
      });

      if (response.status === 404) {
        return {
          mode: "live",
          ok: true,
          message: "The staging copy was already removed.",
          reason: "resource_already_absent"
        };
      }
    } catch {
      // Ignore probe errors and continue.
    }
  }

  return {
    mode: "live",
    ok: false,
    message: "The staging copy could not be removed just now. Use Remove old staging copy to try again.",
    reason: "auto_provision_unsupported"
  };
}
