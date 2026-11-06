/** Coolify database backup schedules and backup inventory (split out of lib/coolify.ts; import from "@/lib/coolify"). */
import { coolifyFetch, coolifyMutateWithResponse, ensureArray, stringValue } from "./coolify-core";

export type BackupScheduleRecord = {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceType: "database" | "application";
  enabled: boolean;
  frequency?: string;       // cron e.g. "0 2 * * *"
  offsiteEnabled?: boolean;
  retentionAmount?: number;
  retentionDays?: number;
  lastBackupAt?: string;
  lastBackupStatus?: "success" | "failed" | "running" | "unknown";
};

export type BackupExecutionRecord = {
  id: string;
  resourceId?: string;
  resourceName?: string;
  status: "success" | "failed" | "running" | "unknown";
  startedAt?: string;
  finishedAt?: string;
  sizeBytes?: number;
  filename?: string;
  downloadUrl?: string;
  restoreUrl?: string;
};

export type DatabaseBackupCoverageRecord = {
  resourceId: string;
  resourceName: string;
  engine: "postgresql" | "mariadb" | "mysql" | "unknown";
  source: "standalone_database" | "embedded_service";
  hasSchedule: boolean;
  hasSuccessfulExecution: boolean;
  note?: string;
};

export type AppBackupInventory = {
  configured: boolean;
  schedules: BackupScheduleRecord[];
  recentExecutions: BackupExecutionRecord[];
  databaseCoverage: DatabaseBackupCoverageRecord[];
  source: "live" | "unavailable";
  note?: string;
  checkedAt: string;
};

export type BackupScheduleProvisionResult = {
  appUuid: string;
  checkedAt: string;
  attempted: boolean;
  configuredBefore: boolean;
  configuredAfter: boolean;
  targetDatabases: string[];
  updatedDatabases: string[];
  failedDatabases: string[];
  note?:
    | "missing_credentials"
    | "inventory_unavailable"
    | "already_configured"
    | "no_databases_detected"
    | "no_addressable_databases"
    | "service_databases_not_schedulable"
    | "provision_attempted"
    | "provision_failed";
};

// ─── Staging Capability Types ─────────────────────────────────────────────────

export function normalizeBackupSchedule(raw: Record<string, unknown>, resourceId: string, resourceName: string): BackupScheduleRecord {
  const id = stringValue(raw, ["id", "uuid"], resourceId);
  const enabled = raw.enabled === true || raw.is_enabled === true || raw.backup_enabled === true || raw.database_backup_enabled === true;
  const frequency = stringValue(raw, ["frequency", "cron", "schedule", "database_backup_cron", "database_backup_schedule"], "") || undefined;
  const offsiteEnabledRaw = raw.save_s3 ?? raw.save_to_s3 ?? raw.database_backup_save_s3 ?? raw.database_backup_save_to_s3;
  const offsiteEnabled = typeof offsiteEnabledRaw === "boolean"
    ? offsiteEnabledRaw
    : typeof offsiteEnabledRaw === "number"
      ? offsiteEnabledRaw !== 0
      : typeof offsiteEnabledRaw === "string"
        ? ["1", "true", "yes", "on"].includes(offsiteEnabledRaw.trim().toLowerCase())
        : undefined;
  const retentionAmount = typeof raw.database_backup_retention_amount_locally === "number"
    ? raw.database_backup_retention_amount_locally
    : typeof raw.retention_amount === "number" ? raw.retention_amount : undefined;
  const retentionDays = typeof raw.database_backup_retention_days_locally === "number"
    ? raw.database_backup_retention_days_locally
    : typeof raw.retention_days === "number" ? raw.retention_days : undefined;
  const lastBackupAt = stringValue(raw, ["last_backup_at", "latest_backup_at", "last_execution_at"], "") || undefined;

  let lastBackupStatus: BackupScheduleRecord["lastBackupStatus"] | undefined;
  const statusRaw = stringValue(raw, ["last_backup_status", "latest_backup_status", "status"], "").toLowerCase();
  if (statusRaw.includes("success") || statusRaw.includes("complete") || statusRaw.includes("finish")) {
    lastBackupStatus = "success";
  } else if (statusRaw.includes("fail") || statusRaw.includes("error")) {
    lastBackupStatus = "failed";
  } else if (statusRaw.includes("run") || statusRaw.includes("pending") || statusRaw.includes("queue")) {
    lastBackupStatus = "running";
  }

  return {
    id,
    resourceId,
    resourceName,
    resourceType: "database",
    enabled,
    frequency,
    offsiteEnabled,
    retentionAmount,
    retentionDays,
    lastBackupAt,
    lastBackupStatus
  };
}

export function toAbsoluteCoolifyUrl(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value;
  }

  const baseUrl = process.env.COOLIFY_API_BASE_URL?.trim() || "";
  if (!baseUrl) {
    return value;
  }

  return `${baseUrl.replace(/\/+$/, "")}/${value.replace(/^\/+/, "")}`;
}

export function normalizeBackupExecution(raw: Record<string, unknown>, resourceId?: string, resourceName?: string): BackupExecutionRecord {
  const id = stringValue(raw, ["id", "uuid"], `exec-${Date.now()}`);
  const statusRaw = stringValue(raw, ["status", "result", "state", "last_status"], "").toLowerCase();
  const successRaw = raw.success === true || raw.is_successful === true;
  const failureRaw = raw.success === false || raw.is_successful === false;
  let status: BackupExecutionRecord["status"] = "unknown";
  if (successRaw || statusRaw.includes("success") || statusRaw.includes("finish") || statusRaw.includes("complet")) {
    status = "success";
  } else if (failureRaw || statusRaw.includes("fail") || statusRaw.includes("error")) {
    status = "failed";
  } else if (statusRaw.includes("run") || statusRaw.includes("pending") || statusRaw.includes("in_progress")) {
    status = "running";
  }
  const startedAt = stringValue(raw, ["started_at", "created_at", "createdAt"], "") || undefined;
  const finishedAt = stringValue(raw, ["finished_at", "updated_at", "completed_at", "finishedAt"], "") || undefined;
  const sizeBytes = typeof raw.size === "number" ? raw.size : undefined;
  const filename = stringValue(raw, ["filename", "file_name", "dump_file", "backup_file", "path"], "") || undefined;
  const downloadRaw = stringValue(raw, ["download_url", "downloadUrl", "url"], "");
  const restoreRaw = stringValue(raw, ["restore_url", "restoreUrl"], "");
  const downloadUrl = downloadRaw ? toAbsoluteCoolifyUrl(downloadRaw) : undefined;
  const restoreUrl = restoreRaw ? toAbsoluteCoolifyUrl(restoreRaw) : undefined;
  return { id, resourceId, resourceName, status, startedAt, finishedAt, sizeBytes, filename, downloadUrl, restoreUrl };
}

export function extractBackupRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return ensureArray(payload);
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const objectPayload = payload as Record<string, unknown>;
  const candidateKeys = ["data", "items", "results", "backups", "schedules", "snapshots", "executions"];

  for (const key of candidateKeys) {
    const value = objectPayload[key];
    if (Array.isArray(value)) {
      return ensureArray(value);
    }
  }

  return [];
}

export function hasScheduleSignal(raw: Record<string, unknown>): boolean {
  return Boolean(
    raw.enabled === true ||
      raw.is_enabled === true ||
      raw.backup_enabled === true ||
      raw.database_backup_enabled === true ||
      stringValue(raw, ["frequency", "cron", "schedule", "database_backup_cron", "database_backup_schedule"], "")
  );
}

export function hasExecutionSignal(raw: Record<string, unknown>): boolean {
  return Boolean(
    stringValue(raw, ["status", "result", "state", "last_status"], "") ||
      stringValue(raw, ["filename", "file_name", "dump_file", "backup_file", "path"], "") ||
      stringValue(raw, ["finished_at", "completed_at", "started_at", "created_at"], "") ||
      typeof raw.success === "boolean" ||
      typeof raw.is_successful === "boolean"
  );
}

export async function collectDatabaseBackupTelemetry(
  dbId: string,
  dbName: string,
  schedules: BackupScheduleRecord[],
  recentExecutions: BackupExecutionRecord[]
): Promise<void> {
  if (!dbId) {
    return;
  }

  const backupPayload = await coolifyFetch(`/api/v1/databases/${dbId}/backups`);
  const backupRows = extractBackupRows(backupPayload);

  for (const row of backupRows) {
    if (!row || typeof row !== "object") {
      continue;
    }

    const record = row as Record<string, unknown>;
    if (hasScheduleSignal(record)) {
      schedules.push(normalizeBackupSchedule(record, dbId, dbName));
    }

    if (hasExecutionSignal(record)) {
      recentExecutions.push(normalizeBackupExecution(record, dbId, dbName));
    }

    const nestedExecutions = ensureArray(record.executions ?? record.backup_executions ?? record.history ?? record.runs ?? []);
    for (const execution of nestedExecutions.slice(0, 20)) {
      if (!execution || typeof execution !== "object") {
        continue;
      }
      recentExecutions.push(normalizeBackupExecution(execution as Record<string, unknown>, dbId, dbName));
    }
  }
}

export function backupProvisionDefaults(): { cron: string; retentionAmount: number; retentionDays: number } {
  const cron = (process.env.COOLIFY_DEFAULT_BACKUP_CRON || "0 2 * * *").trim() || "0 2 * * *";
  const retentionAmountRaw = Number(process.env.COOLIFY_DEFAULT_BACKUP_RETENTION_AMOUNT || 7);
  const retentionDaysRaw = Number(process.env.COOLIFY_DEFAULT_BACKUP_RETENTION_DAYS || 7);

  return {
    cron,
    retentionAmount: Number.isFinite(retentionAmountRaw) && retentionAmountRaw > 0 ? Math.floor(retentionAmountRaw) : 7,
    retentionDays: Number.isFinite(retentionDaysRaw) && retentionDaysRaw > 0 ? Math.floor(retentionDaysRaw) : 7
  };
}

export async function tryApplyDatabaseBackupSchedule(
  databaseId: string,
  defaults: { cron: string; retentionAmount: number; retentionDays: number }
): Promise<boolean> {
  const payloadBackupsCreate = {
    frequency: defaults.cron,
    enabled: true,
    save_s3: false
  };

  const payloadPrimary = {
    database_backup_enabled: true,
    database_backup_cron: defaults.cron,
    database_backup_retention_amount_locally: defaults.retentionAmount,
    database_backup_retention_days_locally: defaults.retentionDays
  };

  const payloadFallback = {
    backup_enabled: true,
    enabled: true,
    cron: defaults.cron,
    schedule: defaults.cron,
    retention_amount: defaults.retentionAmount,
    retention_days: defaults.retentionDays
  };

  const attempts: Array<{
    path: string;
    method: "POST" | "PATCH" | "PUT";
    body: Record<string, unknown>;
  }> = [
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/backups`, method: "POST", body: payloadBackupsCreate },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}`, method: "PATCH", body: payloadPrimary },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/settings`, method: "PATCH", body: payloadPrimary },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/backups`, method: "POST", body: payloadPrimary },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/backups`, method: "PATCH", body: payloadPrimary },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/backups`, method: "PUT", body: payloadPrimary },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}`, method: "PATCH", body: payloadFallback },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/settings`, method: "PATCH", body: payloadFallback },
    { path: `/api/v1/databases/${encodeURIComponent(databaseId)}/backups`, method: "POST", body: payloadFallback }
  ];

  for (const attempt of attempts) {
    const response = await coolifyMutateWithResponse(attempt.path, attempt.method, attempt.body);
    if (response.ok) {
      return true;
    }
  }

  return false;
}

export async function ensureCoolifyAppBackupSchedules(appUuid: string): Promise<BackupScheduleProvisionResult> {
  const checkedAt = new Date().toISOString();
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  if (!baseUrl || !token) {
    return {
      appUuid,
      checkedAt,
      attempted: false,
      configuredBefore: false,
      configuredAfter: false,
      targetDatabases: [],
      updatedDatabases: [],
      failedDatabases: [],
      note: "missing_credentials"
    };
  }

  const inventoryBefore = await getCoolifyAppBackupInventory(appUuid);
  if (inventoryBefore.source !== "live") {
    return {
      appUuid,
      checkedAt,
      attempted: false,
      configuredBefore: inventoryBefore.configured,
      configuredAfter: inventoryBefore.configured,
      targetDatabases: [],
      updatedDatabases: [],
      failedDatabases: [],
      note: "inventory_unavailable"
    };
  }

  const missingCoverage = inventoryBefore.databaseCoverage.filter((item) => !item.hasSchedule);
  const configuredBefore = inventoryBefore.configured && missingCoverage.length === 0;
  if (configuredBefore) {
    return {
      appUuid,
      checkedAt,
      attempted: false,
      configuredBefore: true,
      configuredAfter: true,
      targetDatabases: [],
      updatedDatabases: [],
      failedDatabases: [],
      note: "already_configured"
    };
  }

  if (inventoryBefore.databaseCoverage.length === 0) {
    return {
      appUuid,
      checkedAt,
      attempted: false,
      configuredBefore: false,
      configuredAfter: inventoryBefore.configured,
      targetDatabases: [],
      updatedDatabases: [],
      failedDatabases: [],
      note: "no_databases_detected"
    };
  }

  // Coolify's API cannot schedule backups for service-EMBEDDED databases (a
  // WordPress site's MariaDB): queryDatabaseByUuidWithinTeam() only iterates
  // STANDALONE_DATABASE_MODELS, so POST /databases/<service-db-uuid>/backups
  // answers 404 "Database not found". Attempting them anyway produced a
  // permanent provision_failed for every WordPress site and masked the real
  // failures. These sites are protected by jongo's own full-site backups
  // (files + database to Backblaze) instead, so skip rather than fail.
  const serviceDatabasesMissing = missingCoverage.filter((item) => item.source === "embedded_service");
  const schedulableMissing = missingCoverage.filter((item) => item.source !== "embedded_service");

  const databaseIds = [...new Set(
    schedulableMissing
      .map((item) => item.resourceId)
      .filter((value) => value && !value.startsWith("service:"))
  )];

  if (databaseIds.length === 0) {
    return {
      appUuid,
      checkedAt,
      attempted: false,
      configuredBefore: inventoryBefore.configured,
      configuredAfter: inventoryBefore.configured,
      targetDatabases: [],
      updatedDatabases: [],
      failedDatabases: [],
      note: serviceDatabasesMissing.length > 0
        ? "service_databases_not_schedulable"
        : "no_addressable_databases"
    };
  }

  const defaults = backupProvisionDefaults();
  const updatedDatabases: string[] = [];
  const failedDatabases: string[] = [];

  for (const databaseId of databaseIds) {
    const ok = await tryApplyDatabaseBackupSchedule(databaseId, defaults);
    if (ok) {
      updatedDatabases.push(databaseId);
    } else {
      failedDatabases.push(databaseId);
    }
  }

  const inventoryAfter = await getCoolifyAppBackupInventory(appUuid);
  // Judge success only on databases Coolify can actually schedule; a leftover
  // service-embedded database is expected, not a failure.
  const missingAfter = inventoryAfter.databaseCoverage.filter(
    (item) => !item.hasSchedule && item.source !== "embedded_service"
  );
  const configuredAfter = missingAfter.length === 0;

  return {
    appUuid,
    checkedAt,
    attempted: true,
    configuredBefore,
    configuredAfter,
    targetDatabases: databaseIds,
    updatedDatabases,
    failedDatabases,
    note: configuredAfter ? "provision_attempted" : "provision_failed"
  };
}

export function normalizeDatabaseEngine(raw: Record<string, unknown>): DatabaseBackupCoverageRecord["engine"] {
  const engineRaw = stringValue(raw, ["database_type", "engine", "type", "resource_type", "service_type", "custom_type", "image", "name"], "").toLowerCase();
  if (engineRaw.includes("postgres")) return "postgresql";
  if (engineRaw.includes("mariadb")) return "mariadb";
  if (engineRaw.includes("mysql")) return "mysql";
  return "unknown";
}

export function detectEmbeddedDatabaseFromService(service: Record<string, unknown>): {
  engine: DatabaseBackupCoverageRecord["engine"];
  note?: string;
} | null {
  const serviceType = stringValue(service, ["service_type", "type"], "").toLowerCase();
  const composeRaw = `${stringValue(service, ["docker_compose", "docker_compose_raw"], "")}`.toLowerCase();

  if (serviceType.includes("wordpress-with-mariadb")) {
    return {
      engine: "mariadb",
      note: "WordPress with embedded MariaDB service. No standalone database schedule detected."
    };
  }

  if (serviceType.includes("wordpress-with-mysql")) {
    return {
      engine: "mysql",
      note: "WordPress with embedded MySQL service. No standalone database schedule detected."
    };
  }

  if (composeRaw.includes("image: mariadb") || composeRaw.includes(" mariadb:")) {
    return {
      engine: "mariadb",
      note: "Embedded MariaDB detected in service compose. No standalone database schedule detected."
    };
  }

  if (composeRaw.includes("image: mysql") || composeRaw.includes(" mysql:")) {
    return {
      engine: "mysql",
      note: "Embedded MySQL detected in service compose. No standalone database schedule detected."
    };
  }

  return null;
}

/**
 * Fetch read-only backup inventory for a Coolify application UUID.
 * Tries to resolve the application's project/environment, then finds associated
 * databases and their backup schedules. Never triggers or modifies anything.
 */
export async function getCoolifyAppBackupInventory(appUuid: string): Promise<AppBackupInventory> {
  const baseUrl = process.env.COOLIFY_API_BASE_URL;
  const token = process.env.COOLIFY_API_TOKEN;
  const checkedAt = new Date().toISOString();

  if (!baseUrl || !token) {
    return {
      configured: false,
      schedules: [],
      recentExecutions: [],
      databaseCoverage: [],
      source: "unavailable",
      note: "missing_credentials",
      checkedAt
    };
  }

  try {
    // Step 1: Fetch the application to find its environment_id
    let appRaw: Record<string, unknown> | null = null;
    let serviceRaw: Record<string, unknown> | null = null;
    let applicationLookupFailed = false;
    try {
      const payload = await coolifyFetch(`/api/v1/applications/${appUuid}`);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        appRaw = payload as Record<string, unknown>;
      }
    } catch {
      applicationLookupFailed = true;
    }

    if (!appRaw) {
      try {
        const payload = await coolifyFetch(`/api/v1/services/${appUuid}`);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          serviceRaw = payload as Record<string, unknown>;
        }
      } catch {
        // Best effort
      }
    }

    const schedules: BackupScheduleRecord[] = [];
    const recentExecutions: BackupExecutionRecord[] = [];
    const databaseCoverageByResourceId = new Map<string, DatabaseBackupCoverageRecord>();
    let backupFetchAttempts = 0;
    let backupFetchFailures = 0;

    // Step 2: Try to get databases in the same project/environment
    const rootResource = appRaw ?? serviceRaw;
    const projectId = rootResource
      ? stringValue(rootResource, ["project_uuid", "project_id", "project"], "")
      : "";
    const environmentId = rootResource
      ? stringValue(rootResource, ["environment_id", "environment_uuid", "environment"], "")
      : "";

    let databases: Record<string, unknown>[] = [];

    // Some Coolify setups attach database metadata directly on the application payload.
    if (appRaw) {
      databases = ensureArray(
        appRaw.databases ??
          appRaw.standalone_postgresqls ??
          appRaw.standalone_mariadbs ??
          appRaw.standalone_mysqls ??
          appRaw.postgresqls ??
          appRaw.mariadbs ??
          appRaw.mysqls ??
          appRaw.database ??
          appRaw.attached_databases ??
          []
      );
    }

    if (databases.length === 0 && serviceRaw) {
      databases = ensureArray(
        serviceRaw.databases ??
          serviceRaw.service_databases ??
          serviceRaw.standalone_postgresqls ??
          serviceRaw.standalone_mariadbs ??
          serviceRaw.standalone_mysqls ??
          serviceRaw.postgresqls ??
          serviceRaw.mariadbs ??
          serviceRaw.mysqls ??
          []
      );
    }

    if (databases.length === 0 && projectId && environmentId) {
      try {
        const envPayload = await coolifyFetch(`/api/v1/projects/${projectId}/environments/${environmentId}`);
        const envObj = envPayload && typeof envPayload === "object" && !Array.isArray(envPayload)
          ? (envPayload as Record<string, unknown>)
          : {};
        databases = ensureArray(
          envObj.databases ??
            envObj.standalone_postgresqls ??
            envObj.standalone_mariadbs ??
            envObj.standalone_mysqls ??
            envObj.postgresqls ??
            envObj.mariadbs ??
            envObj.mysqls ??
            envObj.attached_databases ??
            []
        );
      } catch {
        // Best effort
      }
    }

    // Fallback: some projects expose databases only via the global databases endpoint.
    if (databases.length === 0 && (projectId || environmentId)) {
      try {
        const allDatabasesPayload = await coolifyFetch(`/api/v1/databases`);
        const allDatabases = ensureArray(allDatabasesPayload);

        const projectDatabases = allDatabases.filter((db) => {
          const record = (db && typeof db === "object" ? db : {}) as Record<string, unknown>;
          const dbProject = stringValue(record, ["project_uuid", "project_id", "project"], "");
          return projectId ? dbProject === projectId : false;
        });

        if (projectDatabases.length > 0) {
          databases = projectDatabases;
        } else if (environmentId) {
          const environmentDatabases = allDatabases.filter((db) => {
            const record = (db && typeof db === "object" ? db : {}) as Record<string, unknown>;
            const dbEnv = stringValue(record, ["environment_id", "environment_uuid", "environment"], "");
            return dbEnv === environmentId;
          });
          databases = environmentDatabases;
        }
      } catch {
        // Best effort
      }
    }

    for (const db of databases) {
      const dbId = stringValue(db, ["uuid", "id"], "");
      if (!dbId) {
        continue;
      }

      const dbName = stringValue(db, ["name", "database_name"], dbId);
      const isServiceDatabase = typeof db.service_id === "number" || typeof db.service_id === "string";
      databaseCoverageByResourceId.set(dbId, {
        resourceId: dbId,
        resourceName: dbName,
        engine: normalizeDatabaseEngine(db),
        source: isServiceDatabase ? "embedded_service" : "standalone_database",
        hasSchedule: false,
        hasSuccessfulExecution: false
      });
    }

    if (serviceRaw && databases.length === 0) {
      const embeddedDatabase = detectEmbeddedDatabaseFromService(serviceRaw);
      if (embeddedDatabase) {
        const serviceName = stringValue(serviceRaw, ["name"], appUuid);
        const serviceId = stringValue(serviceRaw, ["uuid", "id"], appUuid);
        const coverageId = `service:${serviceId}:${embeddedDatabase.engine}`;
        databaseCoverageByResourceId.set(coverageId, {
          resourceId: coverageId,
          resourceName: `${serviceName} (${embeddedDatabase.engine})`,
          engine: embeddedDatabase.engine,
          source: "embedded_service",
          hasSchedule: false,
          hasSuccessfulExecution: false,
          note: embeddedDatabase.note
        });
      }
    }

    // Step 3: For each database, attempt to read its backup config
    for (const db of databases.slice(0, 5)) {
      const dbId = stringValue(db, ["uuid", "id"], "");
      const dbName = stringValue(db, ["name", "database_name"], dbId);
      if (!dbId) continue;

      backupFetchAttempts += 1;
      try {
        await collectDatabaseBackupTelemetry(dbId, dbName, schedules, recentExecutions);
      } catch {
        // Backup endpoint unavailable for this database
        backupFetchFailures += 1;
      }
    }

    // Step 4: If this resource is a database site, query it directly.
    if (databases.length === 0 && applicationLookupFailed) {
      backupFetchAttempts += 1;
      try {
        await collectDatabaseBackupTelemetry(appUuid, appUuid, schedules, recentExecutions);
      } catch {
        // Best effort
        backupFetchFailures += 1;
      }
    }

    const dedupedSchedules = new Map<string, BackupScheduleRecord>();
    for (const schedule of schedules) {
      const key = `${schedule.resourceId}:${schedule.id}`;
      if (!dedupedSchedules.has(key)) {
        dedupedSchedules.set(key, schedule);
      }
    }

    const dedupedExecutions = new Map<string, BackupExecutionRecord>();
    for (const execution of recentExecutions) {
      const key = `${execution.resourceId ?? "unknown"}:${execution.id}:${execution.filename ?? ""}`;
      if (!dedupedExecutions.has(key)) {
        dedupedExecutions.set(key, execution);
      }
    }

    const normalizedExecutions = [...dedupedExecutions.values()].sort((left, right) => {
      const rightTs = new Date(right.finishedAt ?? right.startedAt ?? 0).getTime();
      const leftTs = new Date(left.finishedAt ?? left.startedAt ?? 0).getTime();
      return rightTs - leftTs;
    });

    const normalizedSchedules = [...dedupedSchedules.values()];
    for (const schedule of normalizedSchedules) {
      const coverage = databaseCoverageByResourceId.get(schedule.resourceId);
      if (coverage && schedule.enabled) {
        coverage.hasSchedule = true;
      }
    }

    for (const execution of normalizedExecutions) {
      if (!execution.resourceId) {
        continue;
      }
      const coverage = databaseCoverageByResourceId.get(execution.resourceId);
      if (coverage && execution.status === "success") {
        coverage.hasSuccessfulExecution = true;
      }
    }

    const databaseCoverage = [...databaseCoverageByResourceId.values()];
    const configured = normalizedSchedules.some((s) => s.enabled);
    const missingSchedules = databaseCoverage.filter((item) => !item.hasSchedule);
    const hasAnyCoverage = databaseCoverage.length > 0;
    const backupTelemetryEndpointUnavailable =
      backupFetchAttempts > 0 &&
      backupFetchFailures >= backupFetchAttempts &&
      normalizedSchedules.length === 0 &&
      normalizedExecutions.length === 0;

    let note: string | undefined;
    if (backupTelemetryEndpointUnavailable) {
      note = "backup_telemetry_unavailable";
    } else if (normalizedSchedules.length === 0 && normalizedExecutions.length === 0) {
      note = databases.length === 0 ? "no_databases_in_environment" : "backups_not_configured";
    } else if (hasAnyCoverage && missingSchedules.length === databaseCoverage.length) {
      note = "backups_not_configured";
    } else if (hasAnyCoverage && missingSchedules.length > 0) {
      note = "partial_backup_coverage";
    }

    return {
      configured,
      schedules: normalizedSchedules,
      recentExecutions: normalizedExecutions.slice(0, 40),
      databaseCoverage,
      source: "live",
      note,
      checkedAt
    };
  } catch {
    return {
      configured: false,
      schedules: [],
      recentExecutions: [],
      databaseCoverage: [],
      source: "unavailable",
      note: "fetch_error",
      checkedAt
    };
  }
}

// ─── Staging Capability Detection ────────────────────────────────────────────
