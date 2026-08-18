import { describe, expect, it, vi } from "vitest";
import { applyCoolifyDeletion } from "./coolify-webhook";

/**
 * applyCoolifyDeletion is the single applier shared by /api/webhooks/coolify
 * (an HTTP delivery) and the deletion watcher (an in-process call). Tested
 * directly with a mock db so both callers are covered by one suite and a
 * regression in either caller's usage shows up here first.
 */
function makeDb(overrides: Partial<Record<string, any>> = {}) {
  return {
    webhookEvent: {
      create: vi.fn().mockResolvedValue({ id: "event-1" }),
      update: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0)
    },
    site: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 })
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({})
    },
    ...overrides
  };
}

const baseInput = {
  deliveryId: "delivery-1",
  eventType: "application.deleted",
  resourceUuids: ["svc-1"],
  authMethod: "hmac"
};

describe("applyCoolifyDeletion", () => {
  it("returns duplicate when the delivery id was already claimed", async () => {
    const db = makeDb();
    db.webhookEvent.create.mockRejectedValue({ code: "P2002" });

    const result = await applyCoolifyDeletion({ db, ...baseInput });

    expect(result).toEqual({ status: "duplicate", deliveryId: "delivery-1", message: "Delivery already processed." });
    expect(db.site.findMany).not.toHaveBeenCalled();
  });

  it("returns unmatched when no Jongo site is linked to the resource", async () => {
    const db = makeDb();

    const result = await applyCoolifyDeletion({ db, ...baseInput });

    expect(result.status).toBe("unmatched");
    expect(result.message).toContain("svc-1");
    expect(db.site.updateMany).not.toHaveBeenCalled();
  });

  it("throttles a burst of deletions instead of applying it", async () => {
    const db = makeDb({
      site: { findMany: vi.fn().mockResolvedValue([{ id: "site-1", slug: "s1", name: "S1", organizationId: "org-1" }]), updateMany: vi.fn() }
    });
    db.webhookEvent.count.mockResolvedValue(5);

    const result = await applyCoolifyDeletion({ db, ...baseInput });

    expect(result.status).toBe("throttled");
    expect(db.site.updateMany).not.toHaveBeenCalled();
  });

  it("soft-deletes every matched site and records an audit log", async () => {
    const sites = [
      { id: "site-1", slug: "s1", name: "S1", organizationId: "org-1" },
      { id: "site-2", slug: "s2", name: "S2", organizationId: "org-2" }
    ];
    const db = makeDb({
      site: { findMany: vi.fn().mockResolvedValue(sites), updateMany: vi.fn().mockResolvedValue({ count: 2 }) }
    });

    const result = await applyCoolifyDeletion({ db, ...baseInput });

    expect(result.status).toBe("applied");
    expect(result.archivedSiteIds).toEqual(["site-1", "site-2"]);
    expect(db.site.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["site-1", "site-2"] }, deletedAt: null } })
    );
    expect(db.auditLog.create).toHaveBeenCalledTimes(2);
  });

  it("reports failed rather than throwing when storage breaks mid-apply", async () => {
    const db = makeDb();
    db.site.findMany.mockRejectedValue(new Error("connection lost"));

    const result = await applyCoolifyDeletion({ db, ...baseInput });

    expect(result.status).toBe("failed");
    expect(result.message).toContain("connection lost");
  });
});
