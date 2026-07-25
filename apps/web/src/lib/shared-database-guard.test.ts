import { describe, expect, it } from "vitest";
import { assessSharedDatabaseRestore, type SiteRef } from "./shared-database-guard";

const site = (id: string, slug: string, uuid: string | null): SiteRef => ({
  id,
  slug,
  name: slug,
  coolifyServiceUuid: uuid
});

// Modelled on the real platform: an app whose data lives in a standalone
// database that is ALSO registered as its own app.
const JOYFEED_APP = site("s-joyfeed", "joyfeed-app", "gyn7ag00fyb4g9fydnggxt92");
const JOYFEED_DB = site("s-pdb-joyfeed", "pdb-joyfeed-web-prod", "bqijvhpgw7oyffopprd2lgri");
const UNRELATED = site("s-other", "freebling-app", "cgp8wmgqvzwc7nehjli9s0tj");

describe("assessSharedDatabaseRestore", () => {
  it("flags the database that is registered as its own app", () => {
    const r = assessSharedDatabaseRestore({
      site: JOYFEED_APP,
      databaseUuids: ["bqijvhpgw7oyffopprd2lgri"],
      allSites: [JOYFEED_APP, JOYFEED_DB, UNRELATED]
    });
    expect(r.shared).toBe(true);
    expect(r.affected.map((a) => a.slug)).toEqual(["pdb-joyfeed-web-prod"]);
    expect(r.affected[0].role).toBe("owner");
    expect(r.warning).toMatch(/shares its database/i);
  });

  it("does not flag a restore nobody else depends on", () => {
    const r = assessSharedDatabaseRestore({
      site: JOYFEED_APP,
      databaseUuids: ["some-private-db"],
      allSites: [JOYFEED_APP, JOYFEED_DB, UNRELATED]
    });
    expect(r.shared).toBe(false);
    expect(r.affected).toEqual([]);
    expect(r.warning).toBe("");
  });

  it("never counts the app being restored as collateral", () => {
    const dbAsSite = site("s-db", "pdb-joyfeed-web-prod", "bqijvhpgw7oyffopprd2lgri");
    const r = assessSharedDatabaseRestore({
      site: dbAsSite,
      databaseUuids: ["bqijvhpgw7oyffopprd2lgri"],
      allSites: [dbAsSite, UNRELATED]
    });
    expect(r.affected.map((a) => a.id)).not.toContain("s-db");
    expect(r.shared).toBe(false);
  });

  it("finds other apps that merely link to the same database", () => {
    const otherConsumer = site("s-consumer", "reporting-app", "aaaa1111");
    const r = assessSharedDatabaseRestore({
      site: JOYFEED_APP,
      databaseUuids: ["bqijvhpgw7oyffopprd2lgri"],
      allSites: [JOYFEED_APP, otherConsumer],
      linksBySiteId: { "s-consumer": ["bqijvhpgw7oyffopprd2lgri"] }
    });
    expect(r.shared).toBe(true);
    expect(r.affected[0]).toMatchObject({ slug: "reporting-app", role: "consumer" });
  });

  it("calls out the control-plane database in the strongest terms", () => {
    // jongo-open-source's linked database IS the jongo-os database. Restoring
    // it rolls back the record of the restore itself.
    const controlApp = site("s-jongo", "jongo-open-source", "oreu338s6akv34il5gwwj0wb");
    const r = assessSharedDatabaseRestore({
      site: controlApp,
      databaseUuids: ["o4g2cpls648gnz0f1he7be7c"],
      allSites: [controlApp],
      controlPlaneDatabaseUuid: "o4g2cpls648gnz0f1he7be7c"
    });
    expect(r.shared).toBe(true);
    expect(r.includesControlPlane).toBe(true);
    expect(r.warning).toMatch(/runs Jongo itself/i);
    expect(r.warning).toMatch(/record of this restore/i);
  });

  it("reports the control plane even when no other app is registered against it", () => {
    const controlApp = site("s-jongo", "jongo-open-source", "oreu338s6akv34il5gwwj0wb");
    const r = assessSharedDatabaseRestore({
      site: controlApp,
      databaseUuids: ["o4g2cpls648gnz0f1he7be7c"],
      allSites: [controlApp, UNRELATED],
      controlPlaneDatabaseUuid: "o4g2cpls648gnz0f1he7be7c"
    });
    expect(r.affected).toEqual([]);
    expect(r.shared).toBe(true);
  });

  it("names every affected app when several share the database", () => {
    const a = site("s-a", "app-a", "aaaa");
    const b = site("s-b", "app-b", "bbbb");
    const r = assessSharedDatabaseRestore({
      site: JOYFEED_APP,
      databaseUuids: ["shared-db"],
      allSites: [JOYFEED_APP, a, b],
      linksBySiteId: { "s-a": ["shared-db"], "s-b": ["shared-db"] }
    });
    expect(r.affected).toHaveLength(2);
    expect(r.warning).toMatch(/2 other apps/);
    expect(r.warning).toContain("app-a");
    expect(r.warning).toContain("app-b");
  });

  it("treats an empty or blank database list as nothing to warn about", () => {
    expect(
      assessSharedDatabaseRestore({ site: JOYFEED_APP, databaseUuids: [], allSites: [JOYFEED_DB] }).shared
    ).toBe(false);
    expect(
      assessSharedDatabaseRestore({ site: JOYFEED_APP, databaseUuids: ["  "], allSites: [JOYFEED_DB] }).shared
    ).toBe(false);
  });

  it("de-duplicates an app that both owns and links the database", () => {
    const r = assessSharedDatabaseRestore({
      site: JOYFEED_APP,
      databaseUuids: ["bqijvhpgw7oyffopprd2lgri"],
      allSites: [JOYFEED_APP, JOYFEED_DB],
      linksBySiteId: { "s-pdb-joyfeed": ["bqijvhpgw7oyffopprd2lgri"] }
    });
    expect(r.affected).toHaveLength(1);
  });
});
