/** Test-only: an in-memory world (users, one client/org/site, grants, OIDC clients, invitations, audit) behind the Prisma-shaped delegates the Craft admin code uses. */
import { randomUUID } from "node:crypto";

export const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SITE = id(1), ORG = id(2), OWNER = id(3), ORG_ADMIN = id(4), ORG_COLLAB = id(5), SITE_ADMIN = id(6), SUPER = id(7),
  OTHER_ADMIN = id(8), TARGET = id(9), STRANGER = id(10), OTHER_ORG = id(11), OTHER_SITE = id(12);
export const TARGET_EMAIL = "target@example.com";
const FUTURE = new Date("2099-01-01T00:00:00Z");

type Row = Record<string, any>;

export class CraftWorld {
  users = new Map<string, Row>();
  orgCollaborators: Row[] = [];
  siteCollaborators: Row[] = [];
  site: Row = { id: SITE, name: "Golf Lab", organizationId: ORG, deletedAt: null };
  orgDeletedAt: Date | null = null;
  subscriptionActive = true;
  platformAdmins = new Set<string>([SUPER]);
  grants: Row[] = [];
  clients: Row[] = [];
  invitations: Row[] = [];
  inviteRoles = new Map<string, string>();
  audits: Row[] = [];
  calls: string[] = [];

  constructor() {
    const names: Array<[string, string]> = [
      [OWNER, "owner"], [ORG_ADMIN, "orgadmin"], [ORG_COLLAB, "collab"], [SITE_ADMIN, "siteadmin"], [SUPER, "super"],
      [OTHER_ADMIN, "otheradmin"], [TARGET, "target"], [STRANGER, "stranger"]
    ];
    for (const [userId, name] of names) {
      this.users.set(userId, { id: userId, email: userId === TARGET ? TARGET_EMAIL : `${name}@example.com`, emailVerified: true, fullName: name, deletedAt: null });
    }
    this.orgCollaborators.push(
      { userId: ORG_ADMIN, role: "admin", deletedAt: null },
      { userId: ORG_COLLAB, role: "collaborator", deletedAt: null }
    );
    this.siteCollaborators.push({ id: id(200), siteId: SITE, userId: SITE_ADMIN, role: "admin", deletedAt: null });
  }

  addClient(overrides: Row = {}): Row {
    const row = {
      id: id(300), clientId: "jc_AAAAAAAAAAAAAAAAAAAAAA", organizationId: ORG, siteId: SITE, name: "Golf Lab Craft", datasetName: "production",
      status: "active", secretHash: "v1$salt$hash", previousSecretHash: null, previousSecretExpiresAt: null,
      redirectUris: ["https://golf.example/craft/auth/callback"], allowedOrigins: ["https://golf.example"],
      createdAt: new Date("2026-11-01T00:00:00Z"), rotatedAt: null, disabledAt: null, ...overrides
    };
    this.clients.push(row);
    return row;
  }

  addGrant(userId: string, role: string, grantedByUserId: string | null = OWNER): Row {
    const row = { id: id(100 + this.grants.length), siteId: SITE, userId, role, grantedByUserId, revokedAt: null, createdAt: new Date("2026-11-02T00:00:00Z"), updatedAt: new Date("2026-11-02T00:00:00Z") };
    this.grants.push(row);
    return row;
  }

  isPlatformAdmin = async (userId: string) => this.platformAdmins.has(userId) && !this.users.get(userId)?.deletedAt;

  /** Mirrors resolveSiteAccess: null unless the caller can see the (live) site at all. */
  resolveSiteAccess = async (siteParam: string, userId: string) => {
    this.calls.push("resolveSiteAccess");
    const user = this.users.get(userId);
    if (!user || user.deletedAt) return null;
    if (siteParam !== SITE || this.site.deletedAt || this.orgDeletedAt) return null;
    const platform = this.platformAdmins.has(userId);
    const orgRows = this.orgCollaborators.filter((c) => c.userId === userId && !c.deletedAt);
    const siteRows = this.siteCollaborators.filter((c) => c.userId === userId && !c.deletedAt);
    if (!platform && userId !== OWNER && orgRows.length === 0 && siteRows.length === 0) return null;
    return {
      site: {
        id: SITE, name: this.site.name, organizationId: ORG,
        organization: { id: ORG, ownerId: OWNER, collaborators: orgRows.map((c) => ({ role: c.role })) },
        collaborators: siteRows.map((c) => ({ role: c.role }))
      },
      isPlatformAdmin: platform,
      isAdmin: platform || userId === OWNER || orgRows[0]?.role === "admin" || siteRows[0]?.role === "admin"
    };
  };

  private owner() {
    return {
      id: OWNER, deletedAt: null, subscriptionPlanId: "core-sla",
      subscriptionStatus: this.subscriptionActive ? "active" : "canceled", subscriptionCurrentPeriodEnd: FUTURE
    };
  }

  private activeGrant = (siteId: string, userId: string) => this.grants.find((g) => g.siteId === siteId && g.userId === userId && g.revokedAt === null) ?? null;

  db: Row = {
    $transaction: async (fn: (tx: Row) => unknown) => fn(this.db),
    $executeRaw: async () => 0,
    user: {
      findUnique: async ({ where }: Row) => (where.id ? this.users.get(where.id) : [...this.users.values()].find((u) => u.email === where.email)) ?? null,
      findFirst: async ({ where }: Row) => {
        const wanted = String(where.email?.equals ?? "").toLowerCase();
        return [...this.users.values()].find((u) => u.email.toLowerCase() === wanted && (where.deletedAt === undefined || u.deletedAt === where.deletedAt)) ?? null;
      },
      findMany: async ({ where }: Row) => [...this.users.values()].filter((u) => where.id.in.includes(u.id))
    },
    site: {
      findUnique: async ({ where, select }: Row) => where.id !== SITE ? null : {
        id: SITE, organizationId: ORG, deletedAt: this.site.deletedAt,
        organization: {
          id: ORG, ownerId: OWNER, deletedAt: this.orgDeletedAt, owner: this.owner(),
          collaborators: this.orgCollaborators.filter((c) => c.userId === select.organization.select.collaborators.where.userId && !c.deletedAt)
        }
      },
      findFirst: async ({ where }: Row) => where.id === SITE && where.organizationId === ORG && !this.site.deletedAt ? { id: SITE } : null
    },
    organization: {
      findFirst: async ({ where }: Row) => where.id !== ORG || this.orgDeletedAt ? null : {
        ownerId: OWNER,
        owner: this.users.get(OWNER),
        collaborators: this.orgCollaborators.filter((c) => c.role === "admin" && !c.deletedAt).map((c) => ({ user: this.users.get(c.userId) }))
      }
    },
    collaborator: { findFirst: async ({ where }: Row) => this.orgCollaborators.find((c) => c.userId === where.userId && !c.deletedAt) ? { id: "m" } : null },
    siteCollaborator: {
      findFirst: async ({ where }: Row) => this.siteCollaborators.find((c) => c.userId === where.userId && !c.deletedAt) ? { id: "sm" } : null,
      upsert: async ({ create }: Row) => { this.siteCollaborators.push({ id: randomUUID(), deletedAt: null, ...create }); return create; },
      findMany: async ({ where }: Row) => this.siteCollaborators.filter((c) => c.siteId === where.siteId).map((c) => ({ ...c, createdAt: new Date(), user: this.users.get(c.userId) })),
      create: async ({ data }: Row) => {
        const row = { id: randomUUID(), deletedAt: null, ...data };
        this.siteCollaborators.push(row);
        return { ...row, user: this.users.get(data.userId) };
      }
    },
    siteCraftAccess: {
      findFirst: async ({ where }: Row) => this.activeGrant(where.siteId, where.userId),
      findMany: async ({ where }: Row) => this.grants.filter((g) => g.siteId === where.siteId && g.revokedAt === null).map((g) => ({ ...g, user: this.users.get(g.userId) })),
      create: async ({ data }: Row) => {
        if (this.activeGrant(data.siteId, data.userId)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const row = { id: id(100 + this.grants.length), revokedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        this.grants.push(row);
        return row;
      },
      update: async ({ where, data }: Row) => Object.assign(this.grants.find((g) => g.id === where.id)!, data, { updatedAt: new Date() }),
      updateMany: async ({ where, data }: Row) => {
        const rows = this.grants.filter((g) => g.siteId === where.siteId && g.userId === where.userId && g.revokedAt === null);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }
    },
    oidcClient: {
      findFirst: async ({ where }: Row) => this.clients.find((c) => (where.id ? c.id === where.id : c.siteId === where.siteId && (!where.organizationId || c.organizationId === where.organizationId))) ?? null,
      create: async ({ data }: Row) => {
        const row = { id: id(300 + this.clients.length), status: "active", previousSecretHash: null, previousSecretExpiresAt: null, createdAt: new Date(), rotatedAt: null, disabledAt: null, ...data };
        this.clients.push(row);
        return row;
      },
      update: async ({ where, data }: Row) => Object.assign(this.clients.find((c) => c.id === where.id)!, data)
    },
    invitation: {
      findUnique: async ({ where }: Row) => this.invitations.find((i) => (where.id ? i.id === where.id : i.tokenHash === where.tokenHash)) ?? null,
      findFirst: async ({ where }: Row) => this.invitations.find((i) => (typeof where.id !== "string" || i.id === where.id) && (!where.siteId || i.siteId === where.siteId) &&
        (!where.email || i.email === where.email) && (!where.inviteType || i.inviteType === where.inviteType) &&
        (where.acceptedAt === undefined || i.acceptedAt === where.acceptedAt) && (where.revokedAt === undefined || i.revokedAt === where.revokedAt) &&
        (!where.expiresAt?.gt || i.expiresAt > where.expiresAt.gt) && (!where.id?.not || i.id !== where.id.not)) ?? null,
      create: async ({ data }: Row) => { const row = { id: randomUUID(), acceptedAt: null, revokedAt: null, ...data }; this.invitations.push(row); return row; },
      update: async ({ where, data }: Row) => Object.assign(this.invitations.find((i) => i.id === where.id)!, data),
      findMany: async () => this.invitations
    },
    invitationCraftAccess: {
      upsert: async ({ where, create, update }: Row) => { this.inviteRoles.set(where.invitationId, (this.inviteRoles.has(where.invitationId) ? update : create).role); },
      findMany: async ({ where }: Row) => where.invitationId.in.filter((i: string) => this.inviteRoles.has(i)).map((i: string) => ({ invitationId: i, role: this.inviteRoles.get(i) })),
      findUnique: async ({ where }: Row) => { this.calls.push("invitationCraftAccess.findUnique"); return this.inviteRoles.has(where.invitationId) ? { role: this.inviteRoles.get(where.invitationId) } : null; }
    },
    auditLog: { create: async ({ data }: Row) => { this.audits.push(data); return data; } }
  };

  auditActions = () => this.audits.map((a) => a.action);
}
