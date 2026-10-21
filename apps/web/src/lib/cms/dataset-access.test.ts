import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getDb: vi.fn(), transaction: vi.fn(), user: vi.fn(), dataset: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
// Assert that every query is isolated from the actual database client.
import { getDb } from "@/lib/db";
import { resolveDatasetCmsCapabilities, type DatasetCmsCapabilities } from "./dataset-access";

const ids = {
  actor: "11111111-1111-4111-8111-111111111111",
  owner: "22222222-2222-4222-8222-222222222222",
  dataset: "33333333-3333-4333-8333-333333333333",
  org: "44444444-4444-4444-8444-444444444444",
  site: "55555555-5555-4555-8555-555555555555",
  other: "66666666-6666-4666-8666-666666666666"
};
const now = new Date("2026-10-19T12:00:00Z");
const end = new Date("2026-10-20T12:00:00Z");
const bits = ["canRead", "canExport", "canEdit", "canPublish", "canManageDataset",
  "canManageGrants", "canCustomizeSchema"] as const;
const none = [false, false, false, false, false, false, false];
const read = [true, true, false, false, false, false, false];
const edit = [true, true, true, false, false, false, false];
const publish = [true, true, true, true, false, false, false];
const admin = [true, true, true, true, true, true, true];
const values = (result: DatasetCmsCapabilities) => bits.map((bit) => result[bit]);

// Evaluate actual Prisma-shaped where/select objects, including nested membership
// filters. Returning a fixed allowed fixture would hide cross-user/scope mistakes.
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]) => row[key] === value);
}
function project(row: any, select: any): any {
  if (!row) return null;
  return Object.fromEntries(Object.entries(select).map(([key, value]: [string, any]) => {
    if (value === true) return [key, row[key]];
    const related = row[key];
    return [key, Array.isArray(related)
      ? related.filter((item) => matches(item, value.where)).map((item) => project(item, value.select))
      : project(related, value.select)];
  }));
}
function fixture() {
  return {
    id: ids.dataset, organizationId: ids.org, siteId: ids.site, archivedAt: null as Date | null,
    organization: {
      id: ids.org, ownerId: ids.owner, deletedAt: null as Date | null,
      owner: { id: ids.owner, deletedAt: null as Date | null, subscriptionPlanId: "enterprise-sla" as string | null,
        subscriptionStatus: "active" as string | null, subscriptionCurrentPeriodEnd: end as Date | null,
        stripeCustomerId: "SECRET_CUSTOMER", billingNotes: "SECRET_NOTES" },
      collaborators: [] as any[], billingStatus: "pending_setup"
    },
    site: { id: ids.site, organizationId: ids.org, deletedAt: null as Date | null, collaborators: [] as any[] },
    grants: [] as any[], name: "PRIVATE_DATASET_NAME"
  };
}
let dataset: ReturnType<typeof fixture> | null;
let actor: any;
let db: any;
function orgMember(role = "collaborator") {
  dataset!.organization.collaborators = [{ organizationId: ids.org, userId: ids.actor, role, deletedAt: null }];
}
function siteMember(role = "collaborator") {
  dataset!.site.collaborators = [{ siteId: ids.site, userId: ids.actor, role, deletedAt: null }];
}
function grant(role = "editor") {
  dataset!.grants = [{ datasetId: ids.dataset, userId: ids.actor, role, revokedAt: null }];
}
const resolve = (userId: string = ids.actor, datasetId: string = ids.dataset) =>
  resolveDatasetCmsCapabilities(userId, datasetId);
async function expectDenied(userId?: string, datasetId?: string) {
  const result = await resolve(userId, datasetId);
  expect(values(result)).toEqual(none);
  expect(result.organizationId).toBeNull();
  expect(result.siteId).toBeNull();
}

beforeEach(() => {
  vi.resetAllMocks();
  expect(getDb).toBe(m.getDb);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("JONGO_CMS_ENABLED", "true");
  vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", "");
  actor = { id: ids.actor, deletedAt: null, role: "collaborator", email: "actor@example.test",
    subscriptionPlanId: "enterprise-sla", subscriptionStatus: "active", subscriptionCurrentPeriodEnd: end };
  dataset = fixture();
  orgMember();
  db = { $transaction: m.transaction };
  m.getDb.mockResolvedValue(db);
  m.transaction.mockImplementation(async (callback) => {
    // A transaction-local snapshot, not a shared in-process permission cache.
    const snapshot = structuredClone({ actor, dataset });
    return callback({
      user: { findUnique: async (query: any) => {
        await m.user(query);
        const user = [snapshot.actor, snapshot.dataset?.organization?.owner]
          .find((row) => row && matches(row, query.where));
        return project(user, query.select);
      } },
      cmsDataset: { findUnique: async (query: any) => {
        await m.dataset(query);
        return snapshot.dataset && matches(snapshot.dataset, query.where) ? project(snapshot.dataset, query.select) : null;
      } }
    });
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("dataset CMS permission boundaries", () => {
  it.each(["owner", "org admin"])("maps %s to dataset admin bounded by owner capacity", async (kind) => {
    if (kind === "owner") actor.id = ids.owner;
    else orgMember("admin");
    const result = await resolve(actor.id);
    expect(values(result)).toEqual(admin);
    expect(result).toEqual({ scope: "dataset", datasetId: ids.dataset, organizationId: ids.org,
      siteId: ids.site, ...Object.fromEntries(bits.map((bit) => [bit, true])) });
    expect(m.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "RepeatableRead" });
    expect(m.user).toHaveBeenCalledWith({ where: { id: actor.id }, select: { id: true, deletedAt: true } });
  });

  it("defaults org collaborators to read/export, never their own subscription capacity", async () => {
    expect(values(await resolve())).toEqual(read);
    grant("admin");
    dataset!.organization.owner.subscriptionPlanId = "starter";
    expect(values(await resolve())).toEqual(read);
    expect(m.user.mock.calls.every(([query]) => !query.select.subscriptionPlanId)).toBe(true);
  });

  it.each([["reader", read], ["editor", edit], ["publisher", publish], ["admin", admin]] as const)(
    "bounds explicit %s grants to their action bits for org and site members", async (role, expected) => {
      grant(role);
      expect(values(await resolve())).toEqual(expected);
      dataset!.organization.collaborators = [];
      siteMember("admin");
      expect(values(await resolve())).toEqual(expected);
    }
  );

  it.each(["admin", "collaborator"])("requires an explicit dataset grant even for site-only %s", async (role) => {
    dataset!.organization.collaborators = [];
    siteMember(role);
    await expectDenied();
    grant("reader");
    expect(values(await resolve())).toEqual(read);
  });

  it("does not downgrade mapped owner/org admin permissions with an additional reader grant", async () => {
    orgMember("admin");
    grant("reader");
    expect(values(await resolve())).toEqual(admin);
  });

  it("supports organization-wide datasets without borrowing any site membership", async () => {
    dataset!.siteId = null as any;
    dataset!.site = null as any;
    expect(values(await resolve())).toEqual(read);
    dataset!.organization.collaborators = [];
    grant("admin");
    await expectDenied();
  });

  it.each(["admin", "super_admin", "bootstrap", "platform grant"])(
    "never turns %s into CMS content authority", async (kind) => {
      dataset!.organization.collaborators = [];
      actor.role = kind;
      actor.platformAdminGrant = { id: "technical" };
      vi.stubEnv("BOOTSTRAP_ADMIN_EMAIL", actor.email);
      await expectDenied();
      grant("admin");
      await expectDenied();
      orgMember();
      expect(values(await resolve())).toEqual(admin);
    }
  );

  it.each(["org", "site"])("never accepts a leftover grant after %s membership revocation", async (scope) => {
    grant("admin");
    if (scope === "site") { dataset!.organization.collaborators = []; siteMember(); }
    expect(values(await resolve())).toEqual(admin);
    const memberships = scope === "org" ? dataset!.organization.collaborators : dataset!.site.collaborators;
    memberships[0].deletedAt = now;
    await expectDenied();
    memberships.length = 0;
    await expectDenied();
  });

  it.each(["other user", "other dataset", "revoked"])("ignores %s dataset grants", async (kind) => {
    grant("admin");
    const entry = dataset!.grants[0];
    if (kind === "other user") entry.userId = ids.other;
    if (kind === "other dataset") entry.datasetId = ids.other;
    if (kind === "revoked") entry.revokedAt = now;
    expect(values(await resolve())).toEqual(read);
    dataset!.organization.collaborators = [];
    siteMember();
    await expectDenied();
  });

  it.each(["other org", "other site", "other user"])("rejects %s membership scope", async (kind) => {
    grant("admin");
    if (kind === "other org") dataset!.organization.collaborators[0].organizationId = ids.other;
    if (kind === "other user") dataset!.organization.collaborators[0].userId = ids.other;
    if (kind === "other site") {
      dataset!.organization.collaborators = [];
      siteMember();
      dataset!.site.collaborators[0].siteId = ids.other;
    }
    await expectDenied();
  });

  it.each(["owner", "super_admin", "ADMIN", "", "constructor", "__proto__"])(
    "rejects unknown/injected role %s without permissive normalization", async (role) => {
      orgMember(role);
      grant("admin");
      await expectDenied();
      dataset!.organization.collaborators = [];
      siteMember(role);
      await expectDenied();
      orgMember();
      grant(role);
      await expectDenied();
    }
  );
});

describe("owner subscription capacity intersection", () => {
  it.each([
    ["starter", read], ["pro", read], ["core-sla", [true, true, true, true, true, true, false]],
    ["enterprise-sla", admin], ["studio", read], ["scale", read], ["unknown", read],
    ["constructor", read], ["__proto__", read], [null, read]
  ])("caps dataset admin under persisted owner plan %s", async (plan, expected) => {
    grant("admin");
    dataset!.organization.owner.subscriptionPlanId = plan as string | null;
    expect(values(await resolve())).toEqual(expected);
  });

  it.each(["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused", "trialing", "ACTIVE", "unknown", null])(
    "retains read/export only after status %s", async (status) => {
      grant("admin");
      dataset!.organization.owner.subscriptionStatus = status;
      expect(values(await resolve())).toEqual(read);
    }
  );

  it.each([now, new Date(now.getTime() - 1), new Date("invalid"), null, end.toISOString()])(
    "fails closed for authoring at invalid/expired paid end %s", async (period) => {
      grant("admin");
      dataset!.organization.owner.subscriptionCurrentPeriodEnd = period as Date | null;
      expect(values(await resolve())).toEqual(read);
    }
  );

  it("honors active paid capacity until exact expiry and immediate downgrade", async () => {
    grant("admin");
    expect(values(await resolve())).toEqual(admin);
    vi.setSystemTime(end);
    expect(values(await resolve())).toEqual(read);
    vi.setSystemTime(now);
    dataset!.organization.owner.subscriptionPlanId = "pro";
    expect(values(await resolve())).toEqual(read);
  });

  it.each([undefined, "", "false", "TRUE", "1", " true", "true "])("defaults disabled with flag %s", async (flag) => {
    grant("admin");
    vi.stubEnv("JONGO_CMS_ENABLED", flag);
    await expectDenied();
    expect(m.getDb).not.toHaveBeenCalled();
  });
});

describe("deleted resources, unavailable schema and untrusted inputs", () => {
  it.each(["missing actor", "deleted actor", "missing dataset", "archived dataset", "missing org", "deleted org",
    "missing owner", "deleted owner", "wrong owner", "missing site", "deleted site", "cross-org site", "wrong site", "wrong org"])(
    "fails closed for %s, even for a tenant admin", async (kind) => {
      orgMember("admin");
      if (kind === "missing actor") actor = null;
      if (kind === "deleted actor") actor.deletedAt = now;
      if (kind === "missing dataset") dataset = null;
      if (kind === "archived dataset") dataset!.archivedAt = now;
      if (kind === "missing org") dataset!.organization = null as any;
      if (kind === "deleted org") dataset!.organization.deletedAt = now;
      if (kind === "missing owner") dataset!.organization.owner = null as any;
      if (kind === "deleted owner") dataset!.organization.owner.deletedAt = now;
      if (kind === "wrong owner") dataset!.organization.owner.id = ids.other;
      if (kind === "missing site") dataset!.site = null as any;
      if (kind === "deleted site") dataset!.site.deletedAt = now;
      if (kind === "cross-org site") dataset!.site.organizationId = ids.other;
      if (kind === "wrong site") dataset!.site.id = ids.other;
      if (kind === "wrong org") dataset!.organization.id = ids.other;
      await expectDenied();
    }
  );

  it.each(["DB absent", "DB throws", "transaction absent", "transaction throws", "identity schema", "dataset schema",
    "missing grant table", "missing subscription column", "missing dataset delegate"])("disables ALL actions on %s", async (kind) => {
      orgMember("admin");
      if (kind === "DB absent") m.getDb.mockResolvedValue(null);
      if (kind === "DB throws") m.getDb.mockRejectedValue(new Error("SECRET_DB_URL"));
      if (kind === "transaction absent") db.$transaction = undefined;
      if (kind === "transaction throws") m.transaction.mockRejectedValue(new Error("snapshot unavailable"));
      if (kind === "identity schema") m.user.mockRejectedValue(new Error("missing deletedAt"));
      if (["dataset schema", "missing grant table", "missing subscription column"].includes(kind))
        m.dataset.mockRejectedValue(new Error(kind));
      if (kind === "missing dataset delegate") m.transaction.mockImplementation((callback) => callback({
        user: { findUnique: async () => actor }
      }));
      await expectDenied();
    }
  );

  it.each(["", " ", "not-a-uuid", "site-slug", "' OR TRUE --", ` ${ids.actor}`, `${ids.actor} `, null, undefined,
    { userId: ids.actor, role: "owner" }, 1])("rejects malformed identifiers %s before DB access", async (value) => {
      expect(values(await resolveDatasetCmsCapabilities(value as string, ids.dataset))).toEqual(none);
      expect(values(await resolveDatasetCmsCapabilities(ids.actor, value as string))).toEqual(none);
      expect(m.getDb).not.toHaveBeenCalled();
    }
  );

  it("rejects unknown UUIDs, no slug or provider-resource fallback", async () => {
    await expectDenied(ids.other);
    await expectDenied(ids.actor, ids.other);
    expect(m.dataset.mock.calls.every(([query]) => Object.keys(query.where).join() === "id")).toBe(true);
  });

  it("does not resolve in a browser", async () => {
    vi.stubGlobal("window", {});
    await expectDenied();
    expect(m.getDb).not.toHaveBeenCalled();
  });

  it("returns an allowlisted DTO, never financial, identity, resource names or raw errors", async () => {
    orgMember("admin");
    const result = await resolve();
    expect(Object.keys(result).sort()).toEqual(["scope", "datasetId", "organizationId", "siteId", ...bits].sort());
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|subscription|stripe|billing|email|ownerId|enterprise-sla/);
    const selection = m.dataset.mock.calls[0][0].select;
    expect(selection.organization.select.owner.select).toEqual({ id: true, deletedAt: true,
      subscriptionPlanId: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true });
    expect(selection.grants.where).toEqual({ userId: ids.actor, revokedAt: null });
    expect(selection.site.select.collaborators.where).toEqual({ userId: ids.actor, deletedAt: null });
  });
});

describe("fresh snapshots and concurrent callers", () => {
  it("observes role/grant/membership changes on every operation, without mutating old DTOs", async () => {
    orgMember("admin");
    const previous = await resolve();
    expect(values(previous)).toEqual(admin);
    orgMember();
    expect(values(await resolve())).toEqual(read);
    grant("publisher");
    expect(values(await resolve())).toEqual(publish);
    dataset!.grants[0].revokedAt = now;
    expect(values(await resolve())).toEqual(read);
    dataset!.organization.collaborators[0].deletedAt = now;
    await expectDenied();
    expect(values(previous)).toEqual(admin);
    expect(m.transaction).toHaveBeenCalledTimes(5);
  });

  it("isolates concurrent reader/owner/outsider scopes", async () => {
    const [readerResult, ownerResult, outsiderResult] = await Promise.all([
      resolve(), resolve(ids.owner), resolve(ids.other)
    ]);
    expect(values(readerResult)).toEqual(read);
    expect(values(ownerResult)).toEqual(admin);
    expect(values(outsiderResult)).toEqual(none);
    expect(m.transaction).toHaveBeenCalledTimes(3);
  });

  it("keeps an in-flight coherent snapshot while a later call observes revocation", async () => {
    grant("publisher");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const started = new Promise<void>((done) => { entered = done; });
    m.user.mockImplementationOnce(async () => { entered(); await gate; });
    const earlier = resolve();
    await started;
    dataset!.organization.collaborators[0].deletedAt = now;
    dataset!.grants[0].revokedAt = now;
    await expectDenied();
    release();
    expect(values(await earlier)).toEqual(publish);
    await expectDenied();
  });
});