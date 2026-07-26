import { describe, expect, it } from "vitest";
import { detectDatabaseEnv } from "./database-env-detect";

const env = (pairs: Array<[string, string]>) => pairs.map(([key, value]) => ({ key, value }));

describe("detectDatabaseEnv", () => {
  it("finds an internal Coolify database from a URL (joyfeed-app, live)", () => {
    const r = detectDatabaseEnv(
      env([
        ["POSTGRES_URL", "postgres://u:p@bqijvhpgw7oyffopprd2lgri:5432/postgres"],
        ["PRISMA_DATABASE_URL", "postgres://u:p@bqijvhpgw7oyffopprd2lgri:5432/postgres"]
      ])
    );
    expect(r.kind).toBe("internal");
    expect(r.internalHosts).toEqual(["bqijvhpgw7oyffopprd2lgri"]);
  });

  it("prefers the internal database when an app also talks to an external one (cc-empower-map, live)", () => {
    // Real shape: internal Coolify postgres AND an external Neon host.
    const r = detectDatabaseEnv(
      env([
        ["POSTGRES_URL", "postgres://u:p@ydnuc6ifqktex1ynhcj68ekl:5432/db"],
        ["POSTGRES_URL_NO_SSL", "postgres://u:p@ep-restless-pond-a4zq6zla-pooler.us-east-1.aws.neon.tech/db"],
        ["POSTGRES_HOST", "ep-restless-pond-a4zq6zla-pooler.us-east-1.aws.neon.tech"]
      ])
    );
    expect(r.kind).toBe("internal");
    expect(r.internalHosts).toEqual(["ydnuc6ifqktex1ynhcj68ekl"]);
  });

  it("catches POSTGRES_PRISMA_URL, which the old five-name match missed", () => {
    const r = detectDatabaseEnv(
      env([["POSTGRES_PRISMA_URL", "postgres://u:p@ydnuc6ifqktex1ynhcj68ekl:5432/db?pgbouncer=true"]])
    );
    expect(r.kind).toBe("internal");
  });

  it("catches host-style config with no URL at all", () => {
    // The silent trap: an app wired to an internal database purely through
    // host + credentials had no backups and was told it had no data.
    const r = detectDatabaseEnv(
      env([
        ["POSTGRES_HOST", "ydnuc6ifqktex1ynhcj68ekl"],
        ["POSTGRES_USER", "app"],
        ["POSTGRES_PASSWORD", "secret"],
        ["POSTGRES_DATABASE", "app"]
      ])
    );
    expect(r.kind).toBe("internal");
    expect(r.internalHosts).toEqual(["ydnuc6ifqktex1ynhcj68ekl"]);
  });

  it("treats a Supabase-only app as having external data, not no data (reviiba, live)", () => {
    // reviiba has only these three; it was classified stateless, telling its
    // owner there was nothing to lose while all its data sits in Supabase.
    const r = detectDatabaseEnv(
      env([
        ["NEXT_PUBLIC_SUPABASE_URL", "https://xyz.supabase.co"],
        ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "ey..."],
        ["SUPABASE_SERVICE_ROLE_KEY", "ey..."]
      ])
    );
    expect(r.kind).toBe("external");
  });

  it("reports a hosted provider as external (gexp / jongo-saas, live)", () => {
    const r = detectDatabaseEnv(
      env([["POSTGRES_URL", "postgres://u:p@aws-1-us-east-1.pooler.supabase.com:5432/postgres"]])
    );
    expect(r.kind).toBe("external");
    expect(r.externalHost).toBe("aws-1-us-east-1.pooler.supabase.com");
  });

  it("reports genuinely stateless apps as none", () => {
    const r = detectDatabaseEnv(
      env([
        ["NODE_ENV", "production"],
        ["PORT", "3000"],
        ["NEXT_PUBLIC_SITE_URL", "https://example.com"]
      ])
    );
    expect(r.kind).toBe("none");
  });

  it("does not mistake localhost or a generic name for a backupable resource", () => {
    // "no dot" is not enough: promising a backup of `localhost` guarantees a
    // failed run against a resource that does not exist.
    expect(detectDatabaseEnv(env([["DB_HOST", "localhost"]])).kind).toBe("none");
    expect(detectDatabaseEnv(env([["DB_HOST", "db"]])).kind).toBe("none");
    expect(detectDatabaseEnv(env([["POSTGRES_HOST", "postgres"]])).kind).toBe("none");
  });

  it("ignores Redis, which the backup script cannot dump", () => {
    // Claiming this is backupable would produce an empty capture.
    expect(detectDatabaseEnv(env([["REDIS_URL", "redis://u:p@abcdefghijklmnopqrstuvwx:6379"]])).kind).toBe("none");
    expect(detectDatabaseEnv(env([["REDIS_HOST", "abcdefghijklmnopqrstuvwx"]])).kind).toBe("none");
  });

  it("handles a URL with no credentials", () => {
    const r = detectDatabaseEnv(env([["DATABASE_URL", "postgres://ydnuc6ifqktex1ynhcj68ekl:5432/db"]]));
    expect(r.kind).toBe("internal");
  });

  it("reads real_value when value is absent, and tolerates junk", () => {
    expect(
      detectDatabaseEnv([{ key: "DATABASE_URL", real_value: "postgres://u:p@ydnuc6ifqktex1ynhcj68ekl:5432/db" }]).kind
    ).toBe("internal");
    expect(detectDatabaseEnv([]).kind).toBe("none");
    expect(detectDatabaseEnv([{}, { key: "" }]).kind).toBe("none");
    expect(detectDatabaseEnv(null as never).kind).toBe("none");
  });

  it("de-duplicates repeated internal hosts", () => {
    const r = detectDatabaseEnv(
      env([
        ["DATABASE_URL", "postgres://u:p@bqijvhpgw7oyffopprd2lgri:5432/a"],
        ["POSTGRES_URL", "postgres://u:p@bqijvhpgw7oyffopprd2lgri:5432/a"]
      ])
    );
    expect(r.internalHosts).toEqual(["bqijvhpgw7oyffopprd2lgri"]);
  });
});
