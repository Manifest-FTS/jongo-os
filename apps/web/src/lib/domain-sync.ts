import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { getDomainListPage, namecheapMode } from "@/lib/namecheap";
import type { RegistrarDomain } from "@/lib/namecheap-xml";

/* eslint-disable @typescript-eslint/no-explicit-any */

const LOCK_ID = 4_711_302; // Distinct from usage collection's advisory lock.
const LEASE_KEY = "ops:namecheap-domain-sync:lease:v1";
const LEASE_MS = 5 * 60_000;
const MAX_PAGES = 100;
const MAX_DURATION_MS = 10 * 60_000;

export type DomainSyncResult = {
  ok: boolean;
  reason: "completed" | "already_running" | "sandbox_disabled" | "not_configured" | "database_unavailable" | "sync_failed";
  pages: number;
  fetched: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: { code: string; page: number | null }[];
};

class SyncFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

/**
 * One reserved WebhookEvent row is a durable ops-run marker (no tenant/FK).
 * The advisory lock serializes lease claims, renewals AND writes. Ownership is
 * checked inside each short transaction, fencing a paused worker after expiry.
 * Never use a session advisory lock through Prisma's connection pool.
 */
async function leaseTransaction<T>(db: any, fn: (tx: any, now: Date) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx: any) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    const [clock] = await tx.$queryRaw`SELECT clock_timestamp() AS now`;
    return fn(tx, new Date(clock.now));
  }, { maxWait: 5_000, timeout: 15_000 });
}

async function requireLease(tx: any, owner: string, now: Date): Promise<void> {
  const lease = await tx.webhookEvent.findUnique({ where: { deliveryId: LEASE_KEY } });
  if (!lease || lease.outcome !== "running" || lease.detail !== owner || now.getTime() - new Date(lease.receivedAt).getTime() >= LEASE_MS) {
    throw new SyncFailure("LEASE_LOST");
  }
  await tx.webhookEvent.update({ where: { deliveryId: LEASE_KEY }, data: { receivedAt: now } });
}

async function writeDomain(tx: any, domain: RegistrarDomain, now: Date): Promise<{ imported: number; updated: number; skipped: number }> {
  const technical = {
    registrarDomainId: domain.domainId,
    expiresAt: domain.expiresAt,
    autoRenew: domain.autoRenew,
    registrarSyncedAt: now
  };
  // INSERT ON CONFLICT DO NOTHING, then a narrow update. A checkout creating
  // the same name concurrently must not lose its client, status or billing.
  const created = await tx.domain.createMany({
    data: [{ name: domain.domain, organizationId: null, registrar: "namecheap", status: domain.expired ? "expired" : "active", ...technical }],
    skipDuplicates: true
  });
  if (created.count) return { imported: 1, updated: 0, skipped: 0 };
  const updated = await tx.domain.updateMany({
    where: { name: domain.domain, registrar: "namecheap", deletedAt: null },
    data: technical
  });
  // Existing status (including in-flight orders), assignment, billing flags,
  // charge history, DNS configuration and soft deletions are NEVER overwritten.
  return { imported: 0, updated: updated.count, skipped: updated.count ? 0 : 1 };
}

export async function syncNamecheapDomains(): Promise<DomainSyncResult> {
  const result: DomainSyncResult = { ok: false, reason: "sync_failed", pages: 0, fetched: 0, imported: 0, updated: 0, skipped: 0, errors: [] };
  const mode = namecheapMode();
  if (mode !== "live") return { ...result, reason: mode === "sandbox" ? "sandbox_disabled" : "not_configured" };
  const owner = randomUUID();
  let db: any;
  let claimed = false;
  let page: number | null = null;
  const started = Date.now();
  try {
    db = await getDb();
    if (!db) return { ...result, reason: "database_unavailable" };
    claimed = await leaseTransaction(db, async (tx, now) => {
      const lease = await tx.webhookEvent.findUnique({ where: { deliveryId: LEASE_KEY } });
      if (lease?.outcome === "running" && now.getTime() - new Date(lease.receivedAt).getTime() < LEASE_MS) return false;
      const data = { source: "namecheap-domain-sync", eventType: "inventory_sync", outcome: "running", detail: owner, receivedAt: now };
      await tx.webhookEvent.upsert({ where: { deliveryId: LEASE_KEY },
        create: { deliveryId: LEASE_KEY, resourceUuids: [], siteIds: [], ...data }, update: data });
      return true;
    });
    if (!claimed) return { ...result, ok: true, reason: "already_running" };

    const seen = new Set<string>();
    let total: number | null = null;
    for (page = 1; page <= MAX_PAGES; page += 1) {
      if (Date.now() - started >= MAX_DURATION_MS) throw new SyncFailure("DURATION_LIMIT");
      // Also recheck live mode in the client immediately before each request.
      if (namecheapMode() !== "live") throw new SyncFailure("LIVE_MODE_REQUIRED");
      await leaseTransaction(db, (tx, now) => requireLease(tx, owner, now));
      const batch = await getDomainListPage(page, 100); // No transaction held across the network.
      result.pages += 1;
      if (Date.now() - started >= MAX_DURATION_MS) throw new SyncFailure("DURATION_LIMIT");
      if (total !== null && batch.totalItems !== total) throw new SyncFailure("INVENTORY_CHANGED");
      total = batch.totalItems;
      if (Math.ceil(total / 100) > MAX_PAGES) throw new SyncFailure("PAGE_LIMIT");
      for (const domain of batch.domains) {
        if (seen.has(domain.domain)) throw new SyncFailure("DUPLICATE_DOMAIN");
        seen.add(domain.domain);
      }
      result.fetched += batch.domains.length;
      const counts = await leaseTransaction(db, async (tx, now) => {
        await requireLease(tx, owner, now);
        const counts = { imported: 0, updated: 0, skipped: 0 };
        for (const domain of batch.domains) {
          const row = await writeDomain(tx, domain, now);
          counts.imported += row.imported;
          counts.updated += row.updated;
          counts.skipped += row.skipped;
        }
        return counts;
      });
      result.imported += counts.imported;
      result.updated += counts.updated;
      result.skipped += counts.skipped;
      if (page * 100 >= total) {
        result.ok = true;
        result.reason = "completed";
        break;
      }
    }
  } catch (error) {
    // Never return upstream XML/messages, Prisma errors or credentials. Codes
    // below are local constants, not error.code from an untrusted API response.
    result.errors.push({ code: error instanceof SyncFailure ? error.code : "SYNC_FAILED", page });
  } finally {
    if (claimed && db) {
      try {
        await leaseTransaction(db, async (tx) => {
          await tx.webhookEvent.updateMany({ where: { deliveryId: LEASE_KEY, detail: owner, outcome: "running" },
            data: { outcome: result.ok ? "applied" : "failed", detail: null } });
        });
      } catch {
        result.ok = false;
        result.reason = "sync_failed";
        result.errors.push({ code: "LEASE_RELEASE_FAILED", page: null });
      }
    }
  }
  return result;
}