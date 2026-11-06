/** Low-level Coolify API access and shared parsing helpers (split out of lib/coolify.ts; import from "@/lib/coolify"). */
import { recordCoolifyEndpointCall } from "@/lib/diagnostics";
import { CoolifyRateLimitError, CoolifyHttpError, noteRateLimited, rateLimitCooldownRemaining } from "./coolify-rate-limit";

export type SiteType = "wordpress" | "database" | "service" | "generic";

export type SiteOverview = {
  id: string;
  name: string;
  deployTargetId: string;
  status: "healthy" | "degraded" | "error" | "unknown";
  productionStatus: "healthy" | "degraded" | "error" | "unknown";
  stagingStatus: "healthy" | "degraded" | "error" | "unknown";
  siteType: SiteType;
  coolifyProjectId?: string;
  coolifyProjectName?: string;
  coolifyEnvironmentId?: string;
  coolifyEnvironmentName?: string;
  resourceType?: string;
  /** The domain Coolify actually serves this on. Empty when none is set. */
  primaryDomain?: string;
  /** Every domain Coolify has, in its own order; primaryDomain is the first. */
  domains?: string[];
  /** The repository Coolify deploys this app from, as Coolify stores it ("owner/repo" or a URL). */
  gitRepository?: string;
  gitBranch?: string;
};

export type CoolifyProjectRecord = {
  id: string;
  name: string;
  numericId?: string;
};

export function statusFromRaw(value: unknown): SiteOverview["status"] {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();

  // Prioritize explicit failure/degraded signals before healthy checks.
  if (
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("crash") ||
    normalized.includes("unhealthy")
  ) {
    return "error";
  }

  if (
    normalized.includes("degraded") ||
    normalized.includes("building") ||
    normalized.includes("pending") ||
    normalized.includes("warning") ||
    normalized.includes("stopped") ||
    normalized.includes("exited") ||
    normalized.includes("sleep")
  ) {
    return "degraded";
  }

  if (normalized.includes("running") || normalized.includes("success") || normalized.includes("healthy")) {
    return "healthy";
  }

  // restarting / unknown / empty raw status → unknown
  return "unknown";
}

export function ensureArray(input: unknown): Record<string, unknown>[] {
  if (!Array.isArray(input)) return [];
  return input.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

export function normalizeArrayPayload(input: unknown): Record<string, unknown>[] {
  const arrayPayload = ensureArray(input);

  if (arrayPayload.length > 0) {
    return arrayPayload;
  }

  if (typeof input !== "object" || input === null) {
    return [];
  }

  const candidateObject = input as Record<string, unknown>;
  const arrayKeys = ["data", "items", "results", "applications", "services", "deployments"];

  for (const key of arrayKeys) {
    const value = candidateObject[key];
    if (Array.isArray(value)) {
      return ensureArray(value);
    }
  }

  return [];
}

export function estimateResponseCount(input: unknown): number | undefined {
  if (Array.isArray(input)) {
    return input.length;
  }

  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const candidate = input as Record<string, unknown>;
  for (const key of [
    "data",
    "items",
    "results",
    "applications",
    "services",
    "deployments",
    "databases",
    "projects",
    "environments",
    "resources"
  ]) {
    const value = candidate[key];
    if (Array.isArray(value)) {
      return value.length;
    }
  }

  return undefined;
}

export function stringValue(obj: Record<string, unknown>, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return fallback;
}

export function normalizeProjectRecords(input: unknown): CoolifyProjectRecord[] {
  const seen = new Set<string>();

  return normalizeArrayPayload(input)
    .map((project, index): CoolifyProjectRecord | null => {
      const id = stringValue(project, ["uuid", "id", "project_uuid", "project_id"], `project-${index + 1}`);
      const name = stringValue(project, ["name", "project_name", "display_name"], id);
      const numericId = stringValue(project, ["id"], "") || undefined;

      if (!id || seen.has(id)) {
        return null;
      }

      seen.add(id);
      return { id, name, numericId };
    })
    .filter((project): project is CoolifyProjectRecord => Boolean(project));
}

export async function coolifyFetch(path: string): Promise<unknown> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const timeoutMs = Number(process.env.COOLIFY_TIMEOUT_MS ?? 8000);

  if (!baseUrl || !token) {
    throw new Error("Missing Coolify API environment variables.");
  }

  // Coolify allows 200 requests/minute per token. Once that is hit, every
  // further call is wasted and keeps the limiter pinned, so stop until the
  // window rolls over. Callers get a distinguishable error rather than one they
  // might mistake for "this resource does not exist".
  const cooldown = rateLimitCooldownRemaining();
  if (cooldown > 0) {
    throw new CoolifyRateLimitError(cooldown);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let statusCode: number | undefined;
  let callLogged = false;

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      signal: controller.signal
    });

    statusCode = response.status;

    if (!response.ok) {
      recordCoolifyEndpointCall({
        path,
        statusCode,
        success: false,
        durationMs: Date.now() - startedAt,
        error: `Hosting request failed (${response.status})`
      });
      callLogged = true;
      if (response.status === 429) {
        const waited = noteRateLimited(Number(response.headers.get("retry-after")));
        throw new CoolifyRateLimitError(waited);
      }
      throw new CoolifyHttpError(response.status, path);
    }

    const payload = await response.json();
    recordCoolifyEndpointCall({
      path,
      statusCode,
      success: true,
      responseCount: estimateResponseCount(payload),
      durationMs: Date.now() - startedAt
    });
    callLogged = true;

    return payload;
  } catch (error) {
    if (!callLogged) {
      recordCoolifyEndpointCall({
        path,
        statusCode,
        success: false,
        durationMs: Date.now() - startedAt,
        error
      });
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveCoolifyProjectEndpointId(projectId: string): Promise<string> {
  if (!projectId) {
    return projectId;
  }

  try {
    await coolifyFetch(`/api/v1/projects/${projectId}`);
    return projectId;
  } catch {
    if (/^\d+$/.test(projectId)) {
      return projectId;
    }

    const projectsPayload = await coolifyFetch("/api/v1/projects");
    const projects = normalizeProjectRecords(projectsPayload);
    const normalizedProjectId = projectId.trim().toLowerCase();

    const matchedProject = projects.find((project) => {
      if (project.id.trim().toLowerCase() === normalizedProjectId) {
        return true;
      }

      return Boolean(project.numericId && project.numericId.trim().toLowerCase() === normalizedProjectId);
    });

    return matchedProject?.numericId || matchedProject?.id || projectId;
  }
}

export type CoolifyActionResult = {
  mode: "live" | "mock";
  ok: boolean;
  message: string;
  reason?:
    | "credentials_missing"
    | "auto_provision_unsupported"
    | "request_sent"
    | "environment_ready"
    | "environment_created"
    | "environment_deleted"
    | "service_created"
    | "resource_deleted"
    | "resource_already_absent"
    | "forbidden"
    | "environment_create_failed"
    | "server_choice_needed";
  /** Servers an admin can pick from when the right one is not known. */
  serverChoices?: Array<{ uuid: string; name: string }>;
  /** HTTP status from Coolify, when the failure came from a rejected request. */
  status?: number;
  /** UUID returned by Coolify when this action creates a resource. */
  resourceUuid?: string;
  /** What that resource is, so deploy/remove use the right endpoints. */
  resourceKind?: "application" | "service";
  /** Provisioning attempt diagnostics for staged create/delete flows. */
  attempts?: Array<{
    path: string;
    method: "POST" | "PATCH" | "PUT" | "DELETE";
    ok: boolean;
    status?: number;
    error?: string;
  }>;
};

export type StagingEnvironmentResolution = {
  projectEndpointId: string;
  stagingEnvironmentId?: string;
  stagingEnvironmentName?: string;
  created: boolean;
};

export async function coolifyMutate(
  path: string,
  method: "POST" | "DELETE" | "PATCH" | "PUT",
  body?: Record<string, unknown>
): Promise<boolean> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const timeoutMs = Number(process.env.COOLIFY_TIMEOUT_MS ?? 8000);

  if (!baseUrl || !token) {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type CoolifyMutateResponse = {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
};

/**
 * Same as coolifyMutate, but preserves status and response body.
 * Coolify answers 422 for a bad payload shape and 409 for a domain conflict;
 * both are indistinguishable from a transport failure through a bare boolean.
 */
export async function coolifyMutateWithResponse(
  path: string,
  method: "POST" | "DELETE" | "PATCH" | "PUT",
  body?: Record<string, unknown>
): Promise<CoolifyMutateResponse> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const timeoutMs = Number(process.env.COOLIFY_TIMEOUT_MS ?? 8000);

  if (!baseUrl || !token) {
    return { ok: false, error: "credentials_missing" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }

    return { ok: response.ok, status: response.status, body: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "request_failed" };
  } finally {
    clearTimeout(timer);
  }
}

export function toHttpsUrl(input: string): string | undefined {
  const candidate = input.trim();
  if (!candidate) {
    return undefined;
  }

  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) {
      return undefined;
    }
    return `https://${parsed.hostname}`;
  } catch {
    try {
      const parsed = new URL(`https://${candidate.replace(/^https?:\/\//i, "")}`);
      if (!parsed.hostname) {
        return undefined;
      }
      return `https://${parsed.hostname}`;
    } catch {
      return undefined;
    }
  }
}

export function normalizeCoolifyDomains(input: string | string[]): string[] {
  const rawValues = Array.isArray(input)
    ? input
    : input
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const raw of rawValues) {
    const value = toHttpsUrl(raw);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

export function extractCoolifyDomainCandidates(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const entry of value) {
      if (typeof entry === "string") {
        values.push(entry);
        continue;
      }

      if (typeof entry === "object" && entry !== null) {
        const record = entry as Record<string, unknown>;
        const urlCandidate = stringValue(record, ["url", "fqdn", "domain", "name"], "");
        if (urlCandidate) {
          values.push(urlCandidate);
        }
      }
    }
    return values;
  }

  return [];
}

export function extractStagingDomainList(target: Record<string, unknown>): string[] {
  const nestedChildren = [
    ...ensureArray(target.applications ?? []),
    ...ensureArray(target.databases ?? []),
    ...ensureArray(target.services ?? [])
  ];

  const nestedCandidates = nestedChildren.flatMap((entry) => {
    const record = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    return [
      ...extractCoolifyDomainCandidates(record.fqdn),
      ...extractCoolifyDomainCandidates(record.staging_fqdn),
      ...extractCoolifyDomainCandidates(record.domain),
      ...extractCoolifyDomainCandidates(record.domains),
      ...extractCoolifyDomainCandidates(record.url),
      ...extractCoolifyDomainCandidates(record.urls)
    ];
  });

  const candidates = [
    ...extractCoolifyDomainCandidates(target.fqdn),
    ...extractCoolifyDomainCandidates(target.staging_fqdn),
    ...extractCoolifyDomainCandidates(target.domain),
    ...extractCoolifyDomainCandidates(target.domains),
    ...extractCoolifyDomainCandidates(target.url),
    ...extractCoolifyDomainCandidates(target.urls),
    ...nestedCandidates
  ];

  return normalizeCoolifyDomains(candidates);
}

export function buildStagingResourceName(sourceName: string): string {
  const generatedSlugPattern = /(?:wordpress|mysql|mariadb|service|app)(?:-[a-z0-9]+)*-[a-z0-9]{10,}$/i;
  const trimmed = sourceName.trim();
  if (!trimmed) {
    return "staging-service";
  }

  if (/^staging[-.]/i.test(trimmed)) {
    return trimmed;
  }

  if (generatedSlugPattern.test(trimmed)) {
    return "staging-app";
  }

  return `staging-${trimmed}`;
}
