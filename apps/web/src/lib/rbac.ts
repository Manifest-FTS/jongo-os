import { getDb } from "@/lib/db";

/** Global account roles are NOT organization/site membership roles. */
export type GlobalRole = "super_admin" | "admin" | "collaborator";

export type RbacPrincipal = {
  userId: string;
  email: string;
  role: GlobalRole;
  isPlatformAdmin: boolean;
};

export function normalizeGlobalRole(value: unknown): GlobalRole {
  return value === "super_admin" || value === "admin" ? value : "collaborator";
}

export function canViewBilling(principal: RbacPrincipal | null | undefined): boolean {
  return principal?.role === "super_admin";
}

export const canManageBilling = canViewBilling;

/** Global technical authority, including revocable legacy technical grants. */
export function canManageInfrastructure(principal: RbacPrincipal | null | undefined): boolean {
  return principal?.isPlatformAdmin === true;
}

/** Tenant access must be resolved for the requested resource, never from a URL alone. */
export function canViewInfrastructure(
  principal: RbacPrincipal | null | undefined,
  hasResourceAccess = false
): boolean {
  return Boolean(principal && (canManageInfrastructure(principal) || hasResourceAccess));
}

/** Never cached in a JWT, across requests, or in a process-wide role cache. */
export async function resolvePrincipal(userId?: string | null): Promise<RbacPrincipal | null> {
  if (!userId?.trim()) return null;
  try {
    const db = await getDb();
    if (!db) return null;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, deletedAt: true }
    });
    if (!user || user.deletedAt) return null;
    const role = normalizeGlobalRole(user.role);
    const seed = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    const isPlatformAdmin = role === "super_admin" || role === "admin" ||
      Boolean(seed && user.email.trim().toLowerCase() === seed) ||
      Boolean(await db.platformAdmin.findUnique({ where: { userId: user.id }, select: { id: true } }));
    return { userId: user.id, email: user.email, role, isPlatformAdmin };
  } catch {
    // Includes missing role migration/generated client, deleted identity and DB outage.
    // No bootstrap, session-email or legacy role fallback can grant finances.
    return null;
  }
}

export async function isSuperAdminUser(userId?: string | null): Promise<boolean> {
  return canViewBilling(await resolvePrincipal(userId));
}

export async function isPlatformAdminUser(userId?: string | null): Promise<boolean> {
  return (await resolvePrincipal(userId))?.isPlatformAdmin === true;
}

/** Existing seed-only technical grant management; never writes User.role. */
export async function canManagePlatformAdminGrants(userId?: string | null): Promise<boolean> {
  const principal = await resolvePrincipal(userId);
  const seed = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  return Boolean(principal && seed && principal.email.trim().toLowerCase() === seed);
}

/** Shared HTTP denial for financial handlers; check before parsing or side effects. */
export async function financialAccessDenial(userId?: string | null): Promise<Response | null> {
  if (userId && await isSuperAdminUser(userId)) return null;
  return Response.json({ error: userId ? "Forbidden" : "Unauthorized" }, {
    status: userId ? 403 : 401,
    headers: { "Cache-Control": "no-store", Vary: "Cookie" }
  });
}