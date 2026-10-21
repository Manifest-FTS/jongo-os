import { getDb } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/** The only workspace data allowed across the server/client boundary. */
export type WorkspaceOption = {
  id: string;
  name: string;
  slug: string;
  planLabel: "Starter" | "Pro" | "Studio" | "Scale" | null;
};
export type WorkspacePage = { items: WorkspaceOption[]; hasMore: boolean; nextCursor: string | null };
export type WorkspaceQuery = { search?: string; cursor?: string | null; limit?: number };
export const WORKSPACE_PAGE_LIMIT = 100;
export const WORKSPACE_SEARCH_LIMIT = 100;

export class WorkspaceQueryError extends Error {}
export class WorkspaceAuthenticationError extends Error {}

type Cursor = { name: string; id: string; search: string };
function parseQuery(query: WorkspaceQuery) {
  const search = (query.search ?? "").trim();
  const limit = query.limit ?? WORKSPACE_PAGE_LIMIT;
  if (search.length > WORKSPACE_SEARCH_LIMIT || !Number.isInteger(limit) || limit < 1 || limit > WORKSPACE_PAGE_LIMIT) {
    throw new WorkspaceQueryError("Invalid workspace search or page size.");
  }
  let cursor: Cursor | null = null;
  if (query.cursor != null) {
    try {
      if (!query.cursor || query.cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
      const value = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"));
      if (typeof value.name !== "string" || typeof value.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) ||
          value.search !== search) throw new Error();
      cursor = { name: value.name, id: value.id, search };
    } catch { throw new WorkspaceQueryError("Invalid workspace cursor."); }
  }
  return { search, limit, cursor };
}

const workspaceSelect = {
  id: true, name: true, slug: true,
  owner: { select: {
    deletedAt: true, subscriptionPlanId: true, subscriptionStatus: true, subscriptionCurrentPeriodEnd: true
  } }
} satisfies Prisma.OrganizationSelect;
type WorkspaceRecord = Prisma.OrganizationGetPayload<{ select: typeof workspaceSelect }>;

function planLabel(owner: WorkspaceRecord["owner"], now: Date): WorkspaceOption["planLabel"] {
  if (!owner || owner.deletedAt !== null || owner.subscriptionStatus !== "active" ||
      !owner.subscriptionCurrentPeriodEnd || owner.subscriptionCurrentPeriodEnd.getTime() <= now.getTime() ||
      !Number.isFinite(owner.subscriptionCurrentPeriodEnd.getTime())) return null;
  switch (owner.subscriptionPlanId) {
    case "starter": return "Starter";
    case "pro": return "Pro";
    case "core-sla": return "Studio";
    case "enterprise-sla": return "Scale";
    default: return null;
  }
}

/** Fresh tenant-only scope. No platform grants, session roles, site grants or mock fallback. */
export async function listWorkspaceOptions(userId: string, query: WorkspaceQuery = {}): Promise<WorkspacePage> {
  if (typeof window !== "undefined") throw new Error("Workspace queries are server-only.");
  if (!userId?.trim()) throw new WorkspaceAuthenticationError("Unauthorized");
  const { search, limit, cursor } = parseQuery(query);
  const db = await getDb();
  if (!db) throw new Error("Workspace service unavailable.");
  const user = await db.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true } });
  if (!user) throw new WorkspaceAuthenticationError("Unauthorized");
  const where: Prisma.OrganizationWhereInput = {
    deletedAt: null,
    AND: [
      { OR: [
        { ownerId: userId, owner: { deletedAt: null } },
        { collaborators: { some: { userId, deletedAt: null, user: { deletedAt: null } } } }
      ] },
      ...(search ? [{ OR: [
        { name: { contains: search, mode: "insensitive" as const } },
        { slug: { contains: search, mode: "insensitive" as const } }
      ] }] : []),
      ...(cursor ? [{ OR: [
        { name: { gt: cursor.name } },
        { name: cursor.name, id: { gt: cursor.id } }
      ] }] : [])
    ]
  };
  const rows: WorkspaceRecord[] = await db.organization.findMany({
    where, select: workspaceSelect, orderBy: [{ name: "asc" }, { id: "asc" }], take: limit + 1
  });
  const visible = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = visible[visible.length - 1];
  const now = new Date();
  return {
    items: visible.map((row) => ({ id: row.id, name: row.name, slug: row.slug, planLabel: planLabel(row.owner, now) })),
    hasMore,
    nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ name: last.name, id: last.id, search })).toString("base64url") : null
  };
}