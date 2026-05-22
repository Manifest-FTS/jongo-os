type DataFlowSource = "db" | "coolify" | "hybrid" | "mock";

type CoolifyEndpointCall = {
  at: string;
  path: string;
  method: "GET";
  statusCode?: number;
  success: boolean;
  responseCount?: number;
  durationMs: number;
  error?: string;
};

type CoolifyInventoryResult = {
  at: string;
  mode: "live" | "mock";
  source: DataFlowSource;
  success: boolean;
  sitesCount: number;
  deploymentsCount: number;
  projectsCount: number;
  environmentsCount: number;
  note?: string;
};

type RepositoryCall = {
  at: string;
  operation: "listClientWorkspaces" | "listSiteDirectory";
  source: DataFlowSource;
  recordCount: number;
  dbCount: number;
  coolifyCount: number;
  mockCount: number;
  scopeApplied: boolean;
  viewerUserIdPresent: boolean;
  viewerUserIdIsUuid: boolean;
  bootstrapGlobalAccess: boolean;
  fallbackUsed: boolean;
  note?: string;
};

type RuntimeDiagnosticsState = {
  updatedAt: string;
  lastSuccessfulCoolifyInventoryFetchAt?: string;
  lastNonEmptyCoolifyInventoryFetchAt?: string;
  coolifyEndpointCalls: CoolifyEndpointCall[];
  coolifyInventoryHistory: CoolifyInventoryResult[];
  repositoryCalls: RepositoryCall[];
  directoryBackupPostureCache: {
    hits: number;
    misses: number;
    inFlightJoins: number;
    stores: number;
    errors: number;
    lastEventAt?: string;
  };
};

const MAX_COOLIFY_ENDPOINT_CALLS = 80;
const MAX_INVENTORY_HISTORY = 40;
const MAX_REPOSITORY_CALLS = 80;

const state: RuntimeDiagnosticsState = {
  updatedAt: new Date(0).toISOString(),
  coolifyEndpointCalls: [],
  coolifyInventoryHistory: [],
  repositoryCalls: [],
  directoryBackupPostureCache: {
    hits: 0,
    misses: 0,
    inFlightJoins: 0,
    stores: 0,
    errors: 0
  }
};

function trim<T>(input: T[], max: number): T[] {
  if (input.length <= max) {
    return input;
  }

  return input.slice(input.length - max);
}

function safeErrorMessage(error: unknown): string | undefined {
  if (!error) {
    return undefined;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, 240);
}

function touch() {
  state.updatedAt = new Date().toISOString();
}

export function recordCoolifyEndpointCall(input: {
  path: string;
  statusCode?: number;
  success: boolean;
  responseCount?: number;
  durationMs: number;
  error?: unknown;
}) {
  state.coolifyEndpointCalls.push({
    at: new Date().toISOString(),
    path: input.path,
    method: "GET",
    statusCode: input.statusCode,
    success: input.success,
    responseCount: input.responseCount,
    durationMs: input.durationMs,
    error: safeErrorMessage(input.error)
  });

  state.coolifyEndpointCalls = trim(state.coolifyEndpointCalls, MAX_COOLIFY_ENDPOINT_CALLS);
  touch();
}

export function recordCoolifyInventoryResult(input: {
  mode: "live" | "mock";
  source: DataFlowSource;
  success: boolean;
  sitesCount: number;
  deploymentsCount: number;
  projectsCount: number;
  environmentsCount: number;
  note?: string;
}) {
  const at = new Date().toISOString();

  state.coolifyInventoryHistory.push({
    at,
    mode: input.mode,
    source: input.source,
    success: input.success,
    sitesCount: input.sitesCount,
    deploymentsCount: input.deploymentsCount,
    projectsCount: input.projectsCount,
    environmentsCount: input.environmentsCount,
    note: input.note
  });

  state.coolifyInventoryHistory = trim(state.coolifyInventoryHistory, MAX_INVENTORY_HISTORY);

  if (input.success) {
    state.lastSuccessfulCoolifyInventoryFetchAt = at;
    if (input.sitesCount > 0) {
      state.lastNonEmptyCoolifyInventoryFetchAt = at;
    }
  }

  touch();
}

export function recordRepositoryCall(input: Omit<RepositoryCall, "at">) {
  state.repositoryCalls.push({
    ...input,
    at: new Date().toISOString()
  });

  state.repositoryCalls = trim(state.repositoryCalls, MAX_REPOSITORY_CALLS);
  touch();
}

export function recordDirectoryBackupPostureCacheEvent(
  event: "hit" | "miss" | "in_flight_join" | "store" | "error"
) {
  const counters = state.directoryBackupPostureCache;
  if (event === "hit") counters.hits += 1;
  if (event === "miss") counters.misses += 1;
  if (event === "in_flight_join") counters.inFlightJoins += 1;
  if (event === "store") counters.stores += 1;
  if (event === "error") counters.errors += 1;
  counters.lastEventAt = new Date().toISOString();
  touch();
}

export function getRuntimeDiagnosticsSnapshot() {
  return {
    updatedAt: state.updatedAt,
    envPresence: {
      databaseUrl: Boolean(process.env.DATABASE_URL),
      nextauthSecret: Boolean(process.env.NEXTAUTH_SECRET),
      coolifyApiBaseUrl: Boolean(process.env.COOLIFY_API_BASE_URL),
      coolifyApiToken: Boolean(process.env.COOLIFY_API_TOKEN),
      bootstrapAdminEmail: Boolean(process.env.BOOTSTRAP_ADMIN_EMAIL),
      ownershipSyncToken: Boolean(process.env.OWNERSHIP_SYNC_TOKEN)
    },
    lastSuccessfulCoolifyInventoryFetchAt: state.lastSuccessfulCoolifyInventoryFetchAt,
    lastNonEmptyCoolifyInventoryFetchAt: state.lastNonEmptyCoolifyInventoryFetchAt,
    coolifyEndpointCalls: [...state.coolifyEndpointCalls],
    coolifyInventoryHistory: [...state.coolifyInventoryHistory],
    repositoryCalls: [...state.repositoryCalls],
    directoryBackupPostureCache: { ...state.directoryBackupPostureCache }
  };
}
