import { describe, expect, it } from "vitest";
import {
  buildStagingDbCopyScript,
  buildStagingDbCreateRequest,
  findLinkedDatabases,
  findSharedDataServices,
  parseDbUrl,
  planStagingEnvRewrite,
  stagingDbEngine
} from "./staging-db-plan";

const PROD_UUID = "rvnaxwtpmms9ghbrill9c0me";
const STG_UUID = "stg0db0uuid0000000000000";
const bonsaiDb = {
  uuid: PROD_UUID,
  name: "postgresql-database-bonsai-virtual-feedback",
  database_type: "standalone-postgresql",
  image: "postgres:18-alpine",
  internal_db_url: `postgres://postgres:prodpass@${PROD_UUID}:5432/postgres`,
  destination: { uuid: "dest-1", server: { uuid: "srv-1" } }
};
const otherDb = { ...bonsaiDb, uuid: "zzzzzzzzzzzzzzzzzzzzzzzz", name: "other", internal_db_url: "postgres://postgres:x@zzzzzzzzzzzzzzzzzzzzzzzz:5432/postgres" };

describe("stagingDbEngine", () => {
  it("maps Coolify database types to create endpoints", () => {
    expect(stagingDbEngine("standalone-postgresql")).toBe("postgresql");
    expect(stagingDbEngine("standalone-mysql")).toBe("mysql");
    expect(stagingDbEngine("standalone-mariadb")).toBe("mariadb");
    expect(stagingDbEngine("standalone-mongodb")).toBe("mongodb");
    expect(stagingDbEngine("standalone-redis")).toBe("redis");
    expect(stagingDbEngine("standalone-clickhouse")).toBeNull();
  });
});

describe("parseDbUrl", () => {
  it("reads user, password, host, port and database", () => {
    expect(parseDbUrl(`postgres://postgres:p%40ss@${PROD_UUID}:5432/postgres`)).toEqual({ user: "postgres", password: "p@ss", host: PROD_UUID, port: "5432", database: "postgres" });
    expect(parseDbUrl("redis://default:secret@abc:6379/0")?.password).toBe("secret");
    expect(parseDbUrl("not a url")).toBeNull();
  });
});

describe("findLinkedDatabases", () => {
  it("finds platform databases the production app points at, ignoring preview variables", () => {
    const envs = [
      { key: "DATABASE_URL", value: bonsaiDb.internal_db_url, is_preview: false },
      { key: "DATABASE_URL", value: otherDb.internal_db_url, is_preview: true }
    ];
    expect(findLinkedDatabases(envs, [bonsaiDb, otherDb]).map((db) => db.uuid)).toEqual([PROD_UUID]);
  });
  it("finds host-style configuration too, once per database", () => {
    const envs = [
      { key: "DB_HOST", value: PROD_UUID, is_preview: false },
      { key: "DATABASE_URL", value: bonsaiDb.internal_db_url, is_preview: false }
    ];
    expect(findLinkedDatabases(envs, [bonsaiDb])).toHaveLength(1);
  });
});

describe("findSharedDataServices", () => {
  it("names external data services by their variables or hosts", () => {
    const envs = [
      { key: "NEXT_PUBLIC_SANITY_PROJECT_ID", value: "abc", is_preview: false },
      { key: "DATABASE_URL", value: "postgres://u:p@ep-cool-1.eu-central-1.aws.neon.tech/db", is_preview: false },
      { key: "SUPABASE_URL", value: "https://x.supabase.co", is_preview: false },
      { key: "MONGO_URL", value: "mongodb+srv://u:p@cluster0.abcd.mongodb.net/app", is_preview: false },
      { key: "NEXT_PUBLIC_SANITY_DATASET", value: "production", is_preview: false }
    ];
    expect(findSharedDataServices(envs)).toEqual(["Sanity", "Neon", "Supabase", "MongoDB Atlas"]);
  });
  it("says nothing for a platform database", () => {
    expect(findSharedDataServices([{ key: "DATABASE_URL", value: bonsaiDb.internal_db_url, is_preview: false }])).toEqual([]);
  });
});

describe("buildStagingDbCreateRequest", () => {
  const placement = { projectUuid: "p1", environmentName: "stage", environmentUuid: "env-stage" };
  it("creates the same engine and image in the staging environment, never public", () => {
    expect(buildStagingDbCreateRequest({ production: bonsaiDb, placement, name: "staging-postgresql-database-bonsai-virtual-feedback" })).toEqual({
      ok: true,
      path: "/api/v1/databases/postgresql",
      body: {
        name: "staging-postgresql-database-bonsai-virtual-feedback",
        project_uuid: "p1",
        environment_name: "stage",
        environment_uuid: "env-stage",
        server_uuid: "srv-1",
        destination_uuid: "dest-1",
        image: "postgres:18-alpine",
        is_public: false,
        instant_deploy: true
      }
    });
  });
  it("refuses engines it cannot copy and missing placement", () => {
    expect(buildStagingDbCreateRequest({ production: { ...bonsaiDb, database_type: "standalone-clickhouse" }, placement, name: "s" })).toEqual({ ok: false, reason: "unsupported_engine" });
    expect(buildStagingDbCreateRequest({ production: { ...bonsaiDb, destination: undefined }, placement, name: "s" })).toEqual({ ok: false, reason: "no_server" });
  });
});

describe("planStagingEnvRewrite", () => {
  const mapping = {
    fromUuid: PROD_UUID,
    toUuid: STG_UUID,
    fromUrl: bonsaiDb.internal_db_url,
    toUrl: `postgres://postgres:stagepass@${STG_UUID}:5432/postgres`
  };
  it("points every production database reference at the staging database", () => {
    const rows = [
      { key: "DATABASE_URL", value: bonsaiDb.internal_db_url, is_literal: true, is_multiline: false },
      { key: "DIRECT_URL", value: `postgresql://postgres:prodpass@${PROD_UUID}:5432/postgres?schema=public`, is_literal: false, is_multiline: false },
      { key: "DB_HOST", value: PROD_UUID },
      { key: "DB_PASSWORD", value: "prodpass" },
      { key: "API_URL", value: "https://api.example.com" }
    ];
    expect(planStagingEnvRewrite(rows, [mapping])).toEqual([
      { key: "DATABASE_URL", value: mapping.toUrl, is_preview: false, is_literal: true, is_multiline: false },
      { key: "DIRECT_URL", value: `postgresql://postgres:stagepass@${STG_UUID}:5432/postgres?schema=public`, is_preview: false, is_literal: false, is_multiline: false },
      { key: "DB_HOST", value: STG_UUID, is_preview: false, is_literal: false, is_multiline: false },
      { key: "DB_PASSWORD", value: "stagepass", is_preview: false, is_literal: false, is_multiline: false }
    ]);
  });
  it("never replaces a password in a variable that isn't a password", () => {
    expect(planStagingEnvRewrite([{ key: "GREETING", value: "prodpass" }], [mapping])).toEqual([]);
  });
});

describe("buildStagingDbCopyScript", () => {
  it("streams postgres production into staging with the server's own tools and stops on errors", () => {
    const script = buildStagingDbCopyScript({ engine: "postgresql", source: PROD_UUID, target: STG_UUID });
    expect(script).toContain("set -uo pipefail");
    expect(script).toContain("pg_dump --clean --if-exists --no-owner --no-acl");
    expect(script).toContain("psql -v ON_ERROR_STOP=1");
    expect(script).toContain(`SRC='${PROD_UUID}'`);
    expect(script).toContain(`DST='${STG_UUID}'`);
    expect(script).toContain("COPY_RESULT=");
  });
  it("covers mysql, mariadb and mongodb, and skips redis", () => {
    expect(buildStagingDbCopyScript({ engine: "mysql", source: PROD_UUID, target: STG_UUID })).toMatch(/mysqldump|mariadb-dump/);
    expect(buildStagingDbCopyScript({ engine: "mariadb", source: PROD_UUID, target: STG_UUID })).toMatch(/mariadb-dump/);
    expect(buildStagingDbCopyScript({ engine: "mongodb", source: PROD_UUID, target: STG_UUID })).toContain("mongorestore --archive --drop");
    expect(buildStagingDbCopyScript({ engine: "redis", source: PROD_UUID, target: STG_UUID })).toContain("COPY_RESULT=skipped");
  });
  it("refuses container names that aren't Coolify uuids (no shell injection)", () => {
    expect(() => buildStagingDbCopyScript({ engine: "postgresql", source: "x; rm -rf /", target: STG_UUID })).toThrow();
    expect(() => buildStagingDbCopyScript({ engine: "postgresql", source: PROD_UUID, target: PROD_UUID })).toThrow();
  });
  it("never writes to the production container", () => {
    const script = buildStagingDbCopyScript({ engine: "postgresql", source: PROD_UUID, target: STG_UUID });
    const writes = script.split("\n").filter((line) => /psql -v ON_ERROR_STOP|mongorestore|mariadb -u|mysql -u/.test(line));
    expect(writes.every((line) => line.includes('"$DST"'))).toBe(true);
  });
});
