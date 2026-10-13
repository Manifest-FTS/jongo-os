/**
 * Staging databases for apps: which production databases an app uses, the
 * request that creates each staging copy, how the staging app's variables are
 * pointed at it, and the shell script that streams production into it.
 * Pure: lib/staging-databases.ts does the I/O; every decision is tested here.
 *
 * Production is only ever read: every write in the copy script targets the
 * staging container ("$DST").
 */

type Row = Record<string, unknown>;

export type StagingDbEngine = "postgresql" | "mysql" | "mariadb" | "mongodb" | "redis";

export type PlatformDatabase = {
  uuid: string;
  name: string;
  database_type: string;
  image?: string | null;
  internal_db_url?: string | null;
  destination?: { uuid?: string | null; server?: { uuid?: string | null } | null } | null;
};

const ENGINES: Record<string, StagingDbEngine> = {
  "standalone-postgresql": "postgresql",
  "standalone-mysql": "mysql",
  "standalone-mariadb": "mariadb",
  "standalone-mongodb": "mongodb",
  "standalone-redis": "redis"
};

export function stagingDbEngine(databaseType: string | null | undefined): StagingDbEngine | null {
  return ENGINES[String(databaseType ?? "").trim()] ?? null;
}

export type ParsedDbUrl = { user: string; password: string; host: string; port: string; database: string };

export function parseDbUrl(value: string | null | undefined): ParsedDbUrl | null {
  const match = String(value ?? "").match(/^[a-z][a-z0-9+.-]*:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#]+)(?::(\d+))?(?:\/([^?#]*))?/i);
  if (!match) return null;
  const decode = (part?: string) => {
    try {
      return decodeURIComponent(part ?? "");
    } catch {
      return part ?? "";
    }
  };
  return { user: decode(match[1]), password: decode(match[2]), host: match[3], port: match[4] ?? "", database: decode(match[5]) };
}

function liveRows(rows: Row[]): Row[] {
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.is_preview !== true && String(row?.key ?? "").trim());
}

function valueOf(row: Row): string {
  return typeof row.value === "string" ? row.value : typeof row.real_value === "string" ? row.real_value : "";
}

function containsToken(haystack: string, token: string): boolean {
  if (!token) return false;
  return new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(haystack);
}

/** Platform databases the production app's (non-preview) variables point at. */
export function findLinkedDatabases(envRows: Row[], databases: PlatformDatabase[]): PlatformDatabase[] {
  const values = liveRows(envRows).map(valueOf);
  return databases.filter((db) => db.uuid && values.some((value) => containsToken(value, db.uuid)));
}

const SERVICE_KEYS: Array<[RegExp, string]> = [
  [/SANITY/, "Sanity"],
  [/SUPABASE/, "Supabase"],
  [/NEON/, "Neon"],
  [/PLANETSCALE/, "PlanetScale"],
  [/TURSO/, "Turso"],
  [/ATLAS/, "MongoDB Atlas"],
  [/UPSTASH/, "Upstash"],
  [/FIREBASE/, "Firebase"]
];
const SERVICE_HOSTS: Array<[RegExp, string]> = [
  [/\.neon\.tech\b/i, "Neon"],
  [/\.supabase\.(co|com)\b/i, "Supabase"],
  [/\.mongodb\.net\b/i, "MongoDB Atlas"],
  [/\.psdb\.cloud\b/i, "PlanetScale"],
  [/\.turso\.io\b/i, "Turso"],
  [/\.upstash\.io\b/i, "Upstash"],
  [/\.rds\.amazonaws\.com\b/i, "Amazon RDS"],
  [/\.sanity\.io\b/i, "Sanity"]
];

/** Data services outside the platform that staging will share with production. */
export function findSharedDataServices(envRows: Row[]): string[] {
  const found: string[] = [];
  const add = (name: string) => {
    if (!found.includes(name)) found.push(name);
  };
  for (const row of liveRows(envRows)) {
    const key = String(row.key).toUpperCase();
    const value = valueOf(row);
    for (const [pattern, name] of SERVICE_KEYS) if (pattern.test(key)) add(name);
    for (const [pattern, name] of SERVICE_HOSTS) if (pattern.test(value)) add(name);
  }
  return found;
}

export type StagingDbPlacement = { projectUuid: string; environmentName: string; environmentUuid: string };

export function buildStagingDbCreateRequest(input: {
  production: PlatformDatabase;
  placement: StagingDbPlacement;
  name: string;
}): { ok: true; path: string; body: Record<string, unknown> } | { ok: false; reason: "unsupported_engine" | "no_server" | "no_placement" } {
  const engine = stagingDbEngine(input.production.database_type);
  if (!engine) return { ok: false, reason: "unsupported_engine" };
  const serverUuid = input.production.destination?.server?.uuid?.trim() ?? "";
  if (!serverUuid) return { ok: false, reason: "no_server" };
  const { placement } = input;
  if (!placement.projectUuid || !(placement.environmentUuid || placement.environmentName)) return { ok: false, reason: "no_placement" };
  const destinationUuid = input.production.destination?.uuid?.trim() ?? "";
  return {
    ok: true,
    path: `/api/v1/databases/${engine}`,
    body: {
      name: input.name.slice(0, 255),
      project_uuid: placement.projectUuid,
      environment_name: placement.environmentName,
      environment_uuid: placement.environmentUuid,
      server_uuid: serverUuid,
      ...(destinationUuid ? { destination_uuid: destinationUuid } : {}),
      ...(input.production.image ? { image: input.production.image } : {}),
      // Never reachable from outside; credentials are generated by Coolify.
      is_public: false,
      instant_deploy: true
    }
  };
}

export type StagingDbMapping = { fromUuid: string; toUuid: string; fromUrl: string; toUrl: string };

export type EnvWrite = { key: string; value: string; is_preview: false; is_literal: boolean; is_multiline: boolean };

function replaceAll(haystack: string, needle: string, replacement: string): string {
  return needle ? haystack.split(needle).join(replacement) : haystack;
}

/**
 * The staging app's variables that must change so it uses the staging
 * database: full connection URLs, `:password@host` pairs in differently
 * shaped URLs, bare host values, and password / user / database-name
 * variables that hold the production value. Only changed rows are returned.
 */
export function planStagingEnvRewrite(rows: Row[], mappings: StagingDbMapping[]): EnvWrite[] {
  const writes: EnvWrite[] = [];
  for (const row of liveRows(rows)) {
    const key = String(row.key).trim();
    const original = valueOf(row);
    let value = original;
    for (const mapping of mappings) {
      const from = parseDbUrl(mapping.fromUrl);
      const to = parseDbUrl(mapping.toUrl);
      value = replaceAll(value, mapping.fromUrl, mapping.toUrl);
      if (from && to && from.password) {
        value = replaceAll(value, `:${from.password}@${mapping.fromUuid}`, `:${to.password}@${mapping.toUuid}`);
        value = replaceAll(value, `:${encodeURIComponent(from.password)}@${mapping.fromUuid}`, `:${encodeURIComponent(to.password)}@${mapping.toUuid}`);
      }
      value = value.replace(new RegExp(`(^|[^a-z0-9])${mapping.fromUuid}(?=[^a-z0-9]|$)`, "gi"), `$1${mapping.toUuid}`);
      if (from && to && value === original) {
        const upper = key.toUpperCase();
        if (/(PASSWORD|PASS|PWD)$/.test(upper) && from.password && value === from.password) value = to.password;
        else if (/(USER|USERNAME)$/.test(upper) && from.user && value === from.user && to.user) value = to.user;
        else if (/(_DB|DATABASE|DB_NAME|DATABASE_NAME)$/.test(upper) && from.database && value === from.database && to.database) value = to.database;
      }
    }
    if (value !== original) {
      writes.push({ key, value, is_preview: false, is_literal: row.is_literal === true, is_multiline: row.is_multiline === true });
    }
  }
  return writes;
}

const CONTAINER = /^[a-z0-9]{20,32}$/;

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Bash run on the database host: waits for the staging container, then
 * streams production's dump straight into it (nothing written to disk).
 * Prints COPY_RESULT=ok|skipped|fail:<reason> and TABLES=<n>.
 */
export function buildStagingDbCopyScript(input: { engine: StagingDbEngine; source: string; target: string }): string {
  if (!CONTAINER.test(input.source) || !CONTAINER.test(input.target)) throw new Error("Database containers must be Coolify uuids.");
  if (input.source === input.target) throw new Error("Source and target must differ.");

  const head = [
    "set -uo pipefail",
    `SRC=${q(input.source)}`,
    `DST=${q(input.target)}`,
    `ERRF=$(mktemp)`,
    `read_env() { docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2>/dev/null | awk -F= -v k="$2" '$1==k{print substr($0,index($0,"=")+1)}' | tail -n 1; }`,
    `fail() { echo "COPY_RESULT=fail:$1"; echo "COPY_ERROR=$(tail -c 300 "$ERRF" 2>/dev/null | tr '\\n' ' ')"; rm -f "$ERRF"; exit 0; }`,
    `running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }`,
    `running "$SRC" || fail source_not_running`
  ];

  if (input.engine === "redis") {
    return [...head.slice(0, 2), "echo COPY_RESULT=skipped", "echo TABLES=0"].join("\n");
  }

  const waitFor = (ping: string) => [
    "ready=0",
    "for i in $(seq 1 90); do",
    `  if running "$DST" && ${ping} >/dev/null 2>&1; then ready=1; break; fi`,
    "  sleep 2",
    "done",
    `[ "$ready" = 1 ] || fail target_not_ready`
  ];

  let body: string[];
  if (input.engine === "postgresql") {
    body = [
      `SU=$(read_env "$SRC" POSTGRES_USER); [ -n "$SU" ] || SU=postgres`,
      `SP=$(read_env "$SRC" POSTGRES_PASSWORD)`,
      `SD=$(read_env "$SRC" POSTGRES_DB); [ -n "$SD" ] || SD="$SU"`,
      `TU=$(read_env "$DST" POSTGRES_USER); [ -n "$TU" ] || TU=postgres`,
      `TP=$(read_env "$DST" POSTGRES_PASSWORD)`,
      `TD=$(read_env "$DST" POSTGRES_DB); [ -n "$TD" ] || TD="$TU"`,
      ...waitFor(`docker exec -e PGPASSWORD="$TP" "$DST" pg_isready -q -U "$TU" -d "$TD"`),
      // --clean --if-exists makes the copy replace whatever staging had (sync).
      `docker exec -e PGPASSWORD="$SP" "$SRC" pg_dump --clean --if-exists --no-owner --no-acl -U "$SU" -d "$SD" 2>>"$ERRF" | docker exec -i -e PGPASSWORD="$TP" "$DST" psql -v ON_ERROR_STOP=1 -q -U "$TU" -d "$TD" >/dev/null 2>>"$ERRF" || fail restore_failed`,
      `TABLES=$(docker exec -e PGPASSWORD="$TP" "$DST" psql -tA -U "$TU" -d "$TD" -c "select count(*) from information_schema.tables where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema')" 2>/dev/null | tr -d '[:space:]')`
    ];
  } else if (input.engine === "mysql" || input.engine === "mariadb") {
    body = [
      `SP=$(read_env "$SRC" MARIADB_ROOT_PASSWORD); [ -n "$SP" ] || SP=$(read_env "$SRC" MYSQL_ROOT_PASSWORD)`,
      `SD=$(read_env "$SRC" MARIADB_DATABASE); [ -n "$SD" ] || SD=$(read_env "$SRC" MYSQL_DATABASE)`,
      `TP=$(read_env "$DST" MARIADB_ROOT_PASSWORD); [ -n "$TP" ] || TP=$(read_env "$DST" MYSQL_ROOT_PASSWORD)`,
      `TD=$(read_env "$DST" MARIADB_DATABASE); [ -n "$TD" ] || TD=$(read_env "$DST" MYSQL_DATABASE)`,
      `[ -n "$SD" ] && [ -n "$TD" ] || fail no_database_name`,
      // mysql:8 images ship no mariadb client and mariadb images may lack mysqldump.
      `SBIN=$(docker exec "$SRC" sh -c 'command -v mariadb-dump || command -v mysqldump' 2>/dev/null | head -1)`,
      `TBIN=$(docker exec "$DST" sh -c 'command -v mariadb || command -v mysql' 2>/dev/null | head -1)`,
      `[ -n "$SBIN" ] && [ -n "$TBIN" ] || fail client_missing`,
      ...waitFor(`docker exec -e MYSQL_PWD="$TP" "$DST" "$TBIN" -uroot -e "select 1"`),
      `docker exec -e MYSQL_PWD="$SP" "$SRC" "$SBIN" --single-transaction --quick --default-character-set=utf8mb4 --routines --triggers --events -uroot "$SD" 2>>"$ERRF" | docker exec -i -e MYSQL_PWD="$TP" "$DST" "$TBIN" -uroot "$TD" >/dev/null 2>>"$ERRF" || fail restore_failed`,
      `TABLES=$(docker exec -e MYSQL_PWD="$TP" "$DST" "$TBIN" -N -B -uroot -e "select count(*) from information_schema.tables where table_type='BASE TABLE' and table_schema='$TD'" 2>/dev/null | tr -d '[:space:]')`
    ];
  } else {
    body = [
      `SU=$(read_env "$SRC" MONGO_INITDB_ROOT_USERNAME)`,
      `SP=$(read_env "$SRC" MONGO_INITDB_ROOT_PASSWORD)`,
      `TU=$(read_env "$DST" MONGO_INITDB_ROOT_USERNAME)`,
      `TP=$(read_env "$DST" MONGO_INITDB_ROOT_PASSWORD)`,
      ...waitFor(`docker exec "$DST" sh -c 'command -v mongorestore'`),
      `sleep 5`,
      `docker exec "$SRC" mongodump --archive --authenticationDatabase admin -u "$SU" -p "$SP" 2>>"$ERRF" | docker exec -i "$DST" mongorestore --archive --drop --authenticationDatabase admin -u "$TU" -p "$TP" >/dev/null 2>>"$ERRF" || fail restore_failed`,
      `TABLES=`
    ];
  }

  return [...head, ...body, `rm -f "$ERRF"`, "echo COPY_RESULT=ok", `echo "TABLES=\${TABLES:-}"`].join("\n");
}
