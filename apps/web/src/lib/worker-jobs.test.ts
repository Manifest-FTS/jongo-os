import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { flag, intervalMinutesToCron, jobDefinitions, pgConnectionString } from "../../../../scripts/worker-jobs.mjs";

const byName = (env: Record<string, string>) =>
  Object.fromEntries(jobDefinitions(env).map((job: any) => [job.name, job]));

describe("worker job catalogue", () => {
  it("keeps the old defaults: deletion watch and usage on, backups and Namecheap off", () => {
    const jobs = byName({});
    expect(jobs["coolify-deletion-watch"]).toMatchObject({ enabled: true, cron: "* * * * *" });
    expect(jobs["usage-collect"]).toMatchObject({ enabled: true, cron: "*/5 * * * *", runAtStartup: true, retryLimit: 4, retryDelaySeconds: 15 });
    expect(jobs["backup-reconcile"]).toMatchObject({ enabled: false, cron: "0 * * * *", runAtStartup: true });
    expect(jobs["namecheap-domain-sync"]).toMatchObject({ enabled: false, cron: "17 3 * * *" });
  });

  it("reads the same environment variables as the old schedulers", () => {
    const jobs = byName({
      COOLIFY_DELETION_WATCH_ENABLED: "false",
      USAGE_COLLECT_ENABLED: "FALSE",
      USAGE_COLLECT_INTERVAL_MINUTES: "10",
      BACKUP_RECONCILE_SCHEDULE_ENABLED: "true",
      BACKUP_RECONCILE_INTERVAL_MINUTES: "360",
      BACKUP_RECONCILE_RUN_IMMEDIATE: "false",
      BACKUP_RECONCILE_STARTUP_ATTEMPTS: "3",
      NAMECHEAP_SYNC_SCHEDULE_ENABLED: "true"
    });
    expect(jobs["coolify-deletion-watch"].enabled).toBe(false);
    expect(jobs["usage-collect"]).toMatchObject({ enabled: false, cron: "*/10 * * * *" });
    expect(jobs["backup-reconcile"]).toMatchObject({ enabled: true, cron: "0 */6 * * *", runAtStartup: false, retryLimit: 2 });
    expect(jobs["namecheap-domain-sync"].enabled).toBe(true);
  });

  it("every job points at an existing one-pass function", async () => {
    for (const job of jobDefinitions({})) {
      expect(typeof (await job.load())).toBe("function");
    }
  });

  it("treats only an explicit value as a change from the default", () => {
    expect(flag({}, "X", true)).toBe(true);
    expect(flag({ X: "no" }, "X", true)).toBe(true);
    expect(flag({ X: "false" }, "X", true)).toBe(false);
    expect(flag({ X: "yes" }, "X", false)).toBe(false);
    expect(flag({ X: " TRUE " }, "X", false)).toBe(true);
  });
});

describe("intervalMinutesToCron", () => {
  it("is exact where cron allows", () => {
    expect(intervalMinutesToCron(1)).toEqual({ cron: "* * * * *" });
    expect(intervalMinutesToCron(15)).toEqual({ cron: "*/15 * * * *" });
    expect(intervalMinutesToCron(60)).toEqual({ cron: "0 * * * *" });
    expect(intervalMinutesToCron(120)).toEqual({ cron: "0 */2 * * *" });
    expect(intervalMinutesToCron(1440)).toEqual({ cron: "0 0 * * *" });
  });

  it("rounds to a schedule that is never more frequent, and says so", () => {
    expect(intervalMinutesToCron(7)).toMatchObject({ cron: "*/10 * * * *", note: expect.any(String) });
    expect(intervalMinutesToCron(45)).toMatchObject({ cron: "0 * * * *", note: expect.any(String) });
    expect(intervalMinutesToCron(300)).toMatchObject({ cron: "0 */6 * * *", note: expect.any(String) });
    expect(intervalMinutesToCron(5000)).toMatchObject({ cron: "0 0 * * *", note: expect.any(String) });
  });
});

describe("pgConnectionString", () => {
  it("drops Prisma-only parameters and keeps the rest", () => {
    const out = pgConnectionString("postgresql://u:p@db:5432/jongo?schema=public&connection_limit=5&sslmode=require");
    expect(out).toBe("postgresql://u:p@db:5432/jongo?sslmode=require");
  });
});
