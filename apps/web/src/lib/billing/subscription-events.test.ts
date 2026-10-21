import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getDb: vi.fn(), retrieve: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: m.getDb }));
vi.mock("@/lib/stripe", () => ({ getStripeClient: () => ({ subscriptions: { retrieve: m.retrieve } }) }));
import { applySubscriptionEvent } from "./subscription-events";

const uid = "00000000-0000-0000-0000-000000000001";
function subscription(overrides: Record<string, unknown> = {}) {
  return { id: "sub", customer: "cus", created: 10, status: "active", current_period_end: 2_000_000_000,
    metadata: { jongoUserId: uid, jongoPlanId: "core-sla", jongoBillingInterval: "monthly" }, ...overrides };
}
function event(id = "evt", created = 100, object: Record<string, unknown> = subscription(), type = "customer.subscription.updated") {
  return { id, created, type, data: { object } } as unknown as Stripe.Event;
}
function replacementCheckout() {
  return event("checkout-B", 100, { id: "session-B", customer: "cus", subscription: "new-sub",
    mode: "subscription", payment_status: "paid", client_reference_id: uid, metadata: { jongoUserId: uid } }, "checkout.session.completed");
}
function ledger(overrides: Record<string, unknown> = {}) {
  return { subscriptionId: "sub", userId: uid, customerId: "cus", providerCreated: 10,
    eventCreated: 90, lastEventId: "previous", terminal: false, ...overrides };
}

// Serialized transaction double with rollback. This proves handler ordering,
// not actual PostgreSQL lock scheduling (requires isolated integration acceptance).
function database() {
  let data = {
    user: { id: uid, stripeCustomerId: "cus", stripeSubscriptionId: "sub", subscriptionStatus: "active",
      subscriptionPlanId: "core-sla", subscriptionInterval: "monthly", deletedAt: null } as any,
    events: new Map<string, any>(), states: new Map<string, any>()
  };
  let queue = Promise.resolve();
  const locks: { sql: string; values: unknown[] }[] = [];
  let locked = false;
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      locks.push({ sql: parts.join("?"), values }); locked = true; return [{ id: uid }];
    }),
    user: {
      findUnique: vi.fn(async ({ where }: any) => (where.id === uid || where.stripeCustomerId === data.user.stripeCustomerId) ? { ...data.user } : null),
      update: vi.fn(async ({ data: update }: any) => { Object.assign(data.user, update); return data.user; })
    },
    stripeSubscriptionEvent: {
      findUnique: vi.fn(async ({ where }: any) => data.events.get(where.eventId) ?? null),
      create: vi.fn(async ({ data: row }: any) => {
        if (data.events.has(row.eventId)) throw new Error("unique event");
        data.events.set(row.eventId, row); return row;
      })
    },
    stripeSubscriptionState: {
      findUnique: vi.fn(async ({ where }: any) => data.states.get(where.subscriptionId) ?? null),
      create: vi.fn(async ({ data: row }: any) => { data.states.set(row.subscriptionId, row); return row; }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const row = data.states.has(where.subscriptionId) ? { ...data.states.get(where.subscriptionId), ...update } : create;
        data.states.set(where.subscriptionId, row); return row;
      })
    }
  };
  const db = { $transaction: async (fn: (tx: any) => Promise<void>) => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const snapshot = structuredClone(data);
    locked = false;
    try { return await fn(tx); } catch (error) { data = snapshot; throw error; } finally { locked = false; release(); }
  } };
  return { db, tx, locks, get locked() { return locked; }, get data() { return data; } };
}

describe("durable subscription reconciliation", () => {
  let store: ReturnType<typeof database>;
  beforeEach(() => {
    vi.resetAllMocks(); store = database(); m.getDb.mockResolvedValue(store.db);
    m.retrieve.mockImplementation(async () => { expect(store.locked).toBe(true); return subscription(); });
  });
  it("retrieves under a targeted owner lock and commits state and unique completion together", async () => {
    await applySubscriptionEvent(event());
    expect(store.locks).toEqual([{ sql: 'SELECT id FROM "User" WHERE id = ?::uuid FOR UPDATE', values: [uid] }]);
    expect(store.data.events.get("evt").outcome).toBe("applied");
    expect(store.data.states.get("sub")).toMatchObject({ eventCreated: 100, lastEventId: "evt", terminal: false });
    expect(store.tx.user.update.mock.invocationCallOrder[0]).toBeLessThan(store.tx.stripeSubscriptionEvent.create.mock.invocationCallOrder[0]);
    await applySubscriptionEvent(event());
    expect(m.retrieve).toHaveBeenCalledTimes(1);
    expect(store.tx.user.update).toHaveBeenCalledTimes(1);
  });
  it("deduplicates concurrent deliveries inside the transaction", async () => {
    await Promise.all([applySubscriptionEvent(event()), applySubscriptionEvent(event())]);
    expect(store.data.events.size).toBe(1);
    expect(store.tx.user.update).toHaveBeenCalledTimes(1);
    expect(m.retrieve).toHaveBeenCalledTimes(1);
  });
  it.each([99, 100, 101])("an upgrade payload at time %i applies canonical downgrade, never payload grants", async time => {
    await applySubscriptionEvent(event("first", 100));
    m.retrieve.mockResolvedValue(subscription({ metadata: { jongoUserId: uid, jongoPlanId: "starter" } }));
    await applySubscriptionEvent(event("late-upgrade", time));
    expect(store.data.user.subscriptionPlanId).toBe("starter");
    expect(store.data.states.get("sub").eventCreated).toBe(Math.max(100, time));
  });
  it("a first old-created event still immediately applies authoritative past_due", async () => {
    m.retrieve.mockResolvedValue(subscription({ status: "past_due" }));
    await applySubscriptionEvent(event("old", 1));
    expect(store.data.user.subscriptionStatus).toBe("past_due");
  });
  it("cancellation is terminal even for an equal-time update or replayed checkout", async () => {
    m.retrieve.mockResolvedValue(subscription({ status: "canceled" }));
    await applySubscriptionEvent(event("cancel", 100, subscription({ status: "canceled" }), "customer.subscription.deleted"));
    m.retrieve.mockResolvedValue(subscription());
    await applySubscriptionEvent(event("upgrade", 100));
    await applySubscriptionEvent(event("checkout", 200, { ...subscription(), mode: "subscription", subscription: "sub", client_reference_id: uid }, "checkout.session.completed"));
    expect(store.data.user.subscriptionStatus).toBe("canceled");
    expect(store.data.states.get("sub").terminal).toBe(true);
    expect(m.retrieve).toHaveBeenCalledTimes(1);
  });
  it("accepts a deletion 404 tombstone only for the bound current subscription", async () => {
    m.retrieve.mockRejectedValue({ statusCode: 404, code: "resource_missing" });
    await applySubscriptionEvent(event("delete", 100, subscription({ status: "canceled" }), "customer.subscription.deleted"));
    expect(store.data.user.subscriptionStatus).toBe("canceled");
    expect(store.data.states.get("sub").terminal).toBe(true);
  });
  it.each(["customer.subscription.updated", "customer.subscription.deleted"])("ignores old unrelated subscription %s", async type => {
    await applySubscriptionEvent(event("old", 999, subscription({ id: "old-sub", status: "canceled" }), type));
    expect(store.tx.user.update).not.toHaveBeenCalled();
    expect(m.retrieve).not.toHaveBeenCalled();
  });
  it.each([
    { customer: "wrong" }, { metadata: { jongoUserId: "victim" } }
  ])("rejects event customer or metadata spoof %j", async overrides => {
    await applySubscriptionEvent(event("spoof", 100, subscription(overrides)));
    expect(store.tx.user.update).not.toHaveBeenCalled();
    expect(m.retrieve).not.toHaveBeenCalled();
  });
  it.each([
    { customer: "wrong" }, { id: "other-sub" }, { metadata: { jongoUserId: "victim", jongoPlanId: "enterprise-sla" } }
  ])("rejects canonical identity mismatch %j", async overrides => {
    m.retrieve.mockResolvedValue(subscription(overrides));
    await applySubscriptionEvent(event());
    expect(store.tx.user.update).not.toHaveBeenCalled();
    expect(store.data.events.get("evt").outcome).toBe("identity_mismatch");
  });
  it("removes revoked plan metadata instead of retaining authoring or trusting checkout fallback", async () => {
    m.retrieve.mockResolvedValue(subscription({ metadata: {} }));
    await applySubscriptionEvent(event("checkout", 100, { ...subscription(), mode: "subscription", subscription: "sub" }, "checkout.session.completed"));
    expect(store.data.user.subscriptionPlanId).toBeNull();
    expect(store.data.user.subscriptionInterval).toBeNull();
  });
  it("binds first checkout only by the verified customer and canonical subscription", async () => {
    store.data.user.stripeSubscriptionId = null;
    await applySubscriptionEvent(event("checkout", 100, { ...subscription(), subscription: "sub", client_reference_id: uid }, "checkout.session.completed"));
    expect(store.data.user.stripeSubscriptionId).toBe("sub");
  });
  it("does not let an old checkout replace an active different subscription", async () => {
    store.data.user.stripeSubscriptionId = "new-sub";
    m.retrieve.mockImplementation(async id => subscription({ id, created: id === "new-sub" ? 20 : 10 }));
    await applySubscriptionEvent(event("old-checkout", 999, { ...subscription(), subscription: "sub" }, "checkout.session.completed"));
    expect(store.data.user.stripeSubscriptionId).toBe("new-sub");
    expect(store.tx.user.update).not.toHaveBeenCalled();
    expect(store.data.events.get("old-checkout").outcome).toBe("unrelated_subscription");
    expect(m.retrieve.mock.calls.map(([id]) => id)).toEqual(["sub", "new-sub"]);
  });
  it.each([
    { cancelFirst: false, existingLedger: false }, { cancelFirst: true, existingLedger: false },
    { cancelFirst: false, existingLedger: true }, { cancelFirst: true, existingLedger: true }
  ])("binds B with Stripe-terminal A regardless of delivery order %j", async ({ cancelFirst, existingLedger }) => {
    if (existingLedger) store.data.states.set("sub", ledger());
    m.retrieve.mockImplementation(async (id, options) => {
      expect(store.locked).toBe(true);
      expect(options).toEqual({ timeout: 8_000, maxNetworkRetries: 0 });
      expect(["sub", "new-sub"]).toContain(id);
      return id === "sub" ? subscription({ status: "canceled" }) : subscription({ id: "new-sub", created: 20 });
    });
    const cancel = event("cancel-A", 99, subscription({ status: "canceled" }), "customer.subscription.deleted");
    if (cancelFirst) await applySubscriptionEvent(cancel);
    else expect(store.data.user.subscriptionStatus).toBe("active");
    await applySubscriptionEvent(replacementCheckout());
    const tombstone = structuredClone(store.data.states.get("sub"));
    expect(tombstone).toMatchObject({ userId: uid, customerId: "cus", providerCreated: 10, terminal: true });
    expect(store.data.events.get("checkout-B").outcome).toBe("applied");
    const retrievals = m.retrieve.mock.calls.length;
    if (!cancelFirst) await applySubscriptionEvent(cancel);
    await applySubscriptionEvent(replacementCheckout());
    await applySubscriptionEvent(event("replay-A", 999, { ...subscription(), subscription: "sub" }, "checkout.session.completed"));
    expect(m.retrieve).toHaveBeenCalledTimes(retrievals);
    await applySubscriptionEvent(event("update-B", 101, subscription({ id: "new-sub", created: 20 })));
    expect(store.data.user).toMatchObject({ stripeSubscriptionId: "new-sub", subscriptionStatus: "active", subscriptionPlanId: "core-sla" });
    expect(store.data.states.get("sub")).toEqual(tombstone);
    expect(store.data.events.get("update-B").outcome).toBe("applied");
    expect(store.data.events.get("replay-A").outcome).toBe("obsolete_or_terminal");
  });
  it.each(["active", "past_due", "unpaid", "incomplete", "trialing"])("rejects replacement when canonical A is still %s", async status => {
    store.data.user.subscriptionStatus = "canceled"; // A stale DB terminal status is not proof either.
    store.data.states.set("sub", ledger());
    m.retrieve.mockImplementation(async id => id === "sub"
      ? subscription({ status }) : subscription({ id: "new-sub", created: 20 }));
    await applySubscriptionEvent(replacementCheckout());
    expect(store.data.events.get("checkout-B").outcome).toBe("unrelated_subscription");
    expect(store.tx.user.update).not.toHaveBeenCalled();
    expect(store.data.states.get("sub").terminal).toBe(false);
    expect(store.data.states.has("new-sub")).toBe(false);
  });
  it.each([
    { id: "arbitrary-sub" }, { customer: "other-customer" }, { metadata: { jongoUserId: "victim" } }
  ])("rejects canonical bound A identity mismatch %j", async overrides => {
    m.retrieve.mockImplementation(async id => id === "sub"
      ? subscription({ status: "canceled", ...overrides }) : subscription({ id: "new-sub", created: 20 }));
    await applySubscriptionEvent(replacementCheckout());
    expect(store.data.events.get("checkout-B").outcome).toBe("identity_mismatch");
    expect(store.tx.user.update).not.toHaveBeenCalled();
    expect(store.data.states.size).toBe(0);
  });
  it.each([{ userId: "victim" }, { customerId: "other-customer" }])("rejects foreign A ledger identity %j", async overrides => {
    store.data.states.set("sub", ledger({ terminal: true, ...overrides }));
    m.retrieve.mockResolvedValue(subscription({ id: "new-sub", created: 20 }));
    await applySubscriptionEvent(replacementCheckout());
    expect(store.data.events.get("checkout-B").outcome).toBe("identity_mismatch");
    expect(store.tx.user.update).not.toHaveBeenCalled();
  });
  it.each([9, 10])("rejects replacement created at %i, not strictly newer than A", async created => {
    m.retrieve.mockImplementation(async id => id === "sub"
      ? subscription({ status: "canceled" }) : subscription({ id: "new-sub", created }));
    await applySubscriptionEvent(replacementCheckout());
    expect(store.data.events.get("checkout-B").outcome).toBe("obsolete_checkout");
    expect(store.tx.user.update).not.toHaveBeenCalled();
    expect(store.data.states.size).toBe(0);
  });
  it.each([NaN, -1, 1.5])("invalid canonical B creation %s cannot bind or fence A", async created => {
    m.retrieve.mockResolvedValue(subscription({ id: "new-sub", created }));
    await expect(applySubscriptionEvent(replacementCheckout())).rejects.toThrow("Invalid canonical");
    expect(store.data.events.size).toBe(0);
    expect(store.data.states.size).toBe(0);
    expect(store.tx.user.update).not.toHaveBeenCalled();
  });
  it.each([
    { statusCode: 503 }, { type: "StripeConnectionError" }, { statusCode: 404, code: "resource_missing" }
  ])("A lookup failure %j leaves B retryable until cancellation is proven", async failure => {
    m.retrieve.mockImplementation(async id => {
      expect(store.locked).toBe(true);
      if (id === "sub") throw failure;
      return subscription({ id: "new-sub", created: 20 });
    });
    await expect(applySubscriptionEvent(replacementCheckout())).rejects.toEqual(failure);
    expect(store.data.events.size).toBe(0);
    expect(store.data.states.size).toBe(0);
    expect(store.data.user.stripeSubscriptionId).toBe("sub");
    // Only a signed, bound deletion may turn a missing A into a tombstone.
    m.retrieve.mockRejectedValueOnce({ statusCode: 404, code: "resource_missing" });
    await applySubscriptionEvent(event("cancel-A", 99, subscription({ status: "canceled" }), "customer.subscription.deleted"));
    const tombstone = structuredClone(store.data.states.get("sub"));
    await applySubscriptionEvent(replacementCheckout());
    expect(store.data.user.stripeSubscriptionId).toBe("new-sub");
    expect(store.data.events.get("checkout-B").outcome).toBe("applied");
    expect(store.data.states.get("sub")).toEqual(tombstone);
  });
  it("rolls back both replacement binding and A tombstone if B completion fails", async () => {
    store.data.states.set("sub", ledger());
    m.retrieve.mockImplementation(async id => id === "sub"
      ? subscription({ status: "incomplete_expired" }) : subscription({ id: "new-sub", created: 20 }));
    store.tx.stripeSubscriptionEvent.create.mockRejectedValueOnce(new Error("storage failure"));
    await expect(applySubscriptionEvent(replacementCheckout())).rejects.toThrow("storage failure");
    expect(store.data.user.stripeSubscriptionId).toBe("sub");
    expect(store.data.states.get("sub")).toEqual(ledger());
    expect(store.data.states.has("new-sub")).toBe(false);
    expect(store.data.events.size).toBe(0);
    await applySubscriptionEvent(replacementCheckout());
    expect(store.data.user.stripeSubscriptionId).toBe("new-sub");
    expect(store.data.states.get("sub").terminal).toBe(true);
  });
  it("permits a new checkout after a recorded terminal subscription, but not an older one", async () => {
    m.retrieve.mockResolvedValue(subscription({ status: "canceled" }));
    await applySubscriptionEvent(event("cancel"));
    m.retrieve.mockResolvedValue(subscription({ id: "new-sub", created: 20 }));
    await applySubscriptionEvent(event("checkout", 100, { ...subscription({ id: "session" }), subscription: "new-sub" }, "checkout.session.completed"));
    expect(store.data.user.stripeSubscriptionId).toBe("new-sub");
    expect(store.data.user.subscriptionStatus).toBe("active");
  });
  it("rolls back state and completion on a write failure and allows retry", async () => {
    store.tx.stripeSubscriptionEvent.create.mockRejectedValueOnce(new Error("storage failure"));
    await expect(applySubscriptionEvent(event())).rejects.toThrow("storage failure");
    expect(store.data.events.size).toBe(0); expect(store.data.states.size).toBe(0);
    m.retrieve.mockResolvedValue(subscription({ status: "past_due" }));
    await applySubscriptionEvent(event());
    expect(store.data.user.subscriptionStatus).toBe("past_due");
    expect(store.data.events.size).toBe(1);
  });
  it("fences a pre-ledger canceled subscription even if provider retrieval says active", async () => {
    store.data.user.subscriptionStatus = "canceled";
    await applySubscriptionEvent(event());
    expect(store.data.user.subscriptionStatus).toBe("canceled");
    expect(store.data.states.get("sub").terminal).toBe(true);
  });
  it("verifies and fences a pre-ledger canceled subscription when accepting a newer checkout", async () => {
    store.data.user.subscriptionStatus = "canceled";
    m.retrieve.mockImplementation(async id => id === "sub"
      ? subscription({ status: "canceled" }) : subscription({ id: "new-sub", created: 20 }));
    await applySubscriptionEvent(event("new", 100, { ...subscription(), subscription: "new-sub" }, "checkout.session.completed"));
    expect(store.data.user.stripeSubscriptionId).toBe("new-sub");
    expect(store.data.states.get("sub").terminal).toBe(true);
    await applySubscriptionEvent(event("old-replay", 100, { ...subscription(), subscription: "sub" }, "checkout.session.completed"));
    expect(store.data.user.stripeSubscriptionId).toBe("new-sub");
  });
  it("rejects an older checkout after cancellation rather than comparing event IDs or delivery time", async () => {
    m.retrieve.mockResolvedValue(subscription({ status: "canceled" }));
    await applySubscriptionEvent(event("cancel"));
    m.retrieve.mockResolvedValue(subscription({ id: "older-sub", created: 9 }));
    await applySubscriptionEvent(event("zzzz-late", 999, { ...subscription(), subscription: "older-sub" }, "checkout.session.completed"));
    expect(store.data.user.stripeSubscriptionId).toBe("sub");
    expect(store.data.user.subscriptionStatus).toBe("canceled");
  });
  it("checks checkout client-reference identity independently from metadata", async () => {
    await applySubscriptionEvent(event("spoof", 100, { ...subscription(), subscription: "sub", client_reference_id: "victim" }, "checkout.session.completed"));
    expect(m.retrieve).not.toHaveBeenCalled();
    expect(store.tx.user.update).not.toHaveBeenCalled();
  });
  it.each(["customer.subscription.updated", "customer.subscription.deleted"])("provider outages never complete %s", async type => {
    m.retrieve.mockRejectedValue({ statusCode: 503 });
    await expect(applySubscriptionEvent(event("retry", 100, subscription(), type))).rejects.toBeDefined();
    expect(store.data.events.size).toBe(0); expect(store.tx.user.update).not.toHaveBeenCalled();
  });
  it("does not fall back to a tombstone for an update 404", async () => {
    m.retrieve.mockRejectedValue({ statusCode: 404, code: "resource_missing" });
    await expect(applySubscriptionEvent(event())).rejects.toBeDefined();
    expect(store.data.events.size).toBe(0);
  });
  it("serializes concurrent distinct updates and cancellation so no upgrade regrants", async () => {
    m.retrieve.mockResolvedValue(subscription({ status: "canceled" }));
    await Promise.all([applySubscriptionEvent(event("cancel", 100, subscription({ status: "canceled" }), "customer.subscription.deleted")), applySubscriptionEvent(event("upgrade", 100))]);
    expect(store.data.user.subscriptionStatus).toBe("canceled");
    expect(store.data.events.size).toBe(2);
  });
  it("fails closed without storage or with deleted accounts", async () => {
    m.getDb.mockResolvedValueOnce(null);
    await expect(applySubscriptionEvent(event())).rejects.toThrow("unavailable");
    store.data.user.deletedAt = new Date();
    await applySubscriptionEvent(event());
    expect(store.tx.user.update).not.toHaveBeenCalled();
    expect(m.retrieve).not.toHaveBeenCalled();
  });
});