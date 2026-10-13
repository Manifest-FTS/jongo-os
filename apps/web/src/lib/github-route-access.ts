import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";

/**
 * Who may act on an organization's GitHub connection: its client admins (and
 * platform admins). Collaborators can see the linked repo on a site but can't
 * connect, disconnect or link.
 */
export async function requireOrgAdmin(
  orgId: string
): Promise<{ userId: string; email: string | null } | { response: NextResponse }> {
  const session = await auth();
  if (!session?.user?.id) return { response: NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 }) };
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return { response: NextResponse.json({ ok: false, message: "Not found." }, { status: 404 }) };
  const { isClientAdmin } = await import("@/lib/repositories");
  const { isPlatformAdminEmail } = await import("@/lib/permissions");
  const allowed = (await isClientAdmin(orgId, session.user.id)) || (await isPlatformAdminEmail(session.user.email));
  if (!allowed) return { response: NextResponse.json({ ok: false, message: "Only the client's admins can manage GitHub." }, { status: 403 }) };
  return { userId: session.user.id, email: session.user.email ?? null };
}

/** Owner, admin or collaborator of the client (or a platform admin), with canDeployFromGithub. */
export async function canUseGithubForOrg(orgId: string, userId: string, email?: string | null): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return false;
  const { getDb } = await import("@/lib/db");
  const { getPermissions, isPlatformAdminEmail } = await import("@/lib/permissions");
  const db: any = await getDb();
  const org = db
    ? await db.organization.findFirst({
        where: { id: orgId, deletedAt: null },
        select: { ownerId: true, collaborators: { where: { userId, deletedAt: null }, select: { role: true }, take: 1 } }
      })
    : null;
  const platformAdmin = await isPlatformAdminEmail(email);
  const member = Boolean(org && (org.ownerId === userId || org.collaborators.length > 0));
  if (!member && !platformAdmin) return false;
  const role = org?.ownerId === userId ? "admin" : org?.collaborators[0]?.role;
  return getPermissions(role, platformAdmin).canDeployFromGithub;
}

/**
 * Anyone on the client's team (owner, admin or collaborator) with the
 * canDeployFromGithub permission: connects GitHub, lists shared repos and
 * creates apps from them.
 */
export async function requireOrgMember(
  orgId: string
): Promise<{ userId: string; email: string | null } | { response: NextResponse }> {
  const session = await auth();
  if (!session?.user?.id) return { response: NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 }) };
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return { response: NextResponse.json({ ok: false, message: "Not found." }, { status: 404 }) };
  const { getDb } = await import("@/lib/db");
  const { getPermissions, isPlatformAdminEmail } = await import("@/lib/permissions");
  const db: any = await getDb();
  const org = db
    ? await db.organization.findFirst({
        where: { id: orgId, deletedAt: null },
        select: { ownerId: true, collaborators: { where: { userId: session.user.id, deletedAt: null }, select: { role: true }, take: 1 } }
      })
    : null;
  const platformAdmin = await isPlatformAdminEmail(session.user.email);
  const member = Boolean(org && (org.ownerId === session.user.id || org.collaborators.length > 0));
  if (!member && !platformAdmin) return { response: NextResponse.json({ ok: false, message: "Not found." }, { status: 404 }) };
  const role = org?.ownerId === session.user.id ? "admin" : org?.collaborators[0]?.role;
  if (!getPermissions(role, platformAdmin).canDeployFromGithub) {
    return { response: NextResponse.json({ ok: false, message: "You can't deploy from GitHub for this client." }, { status: 403 }) };
  }
  return { userId: session.user.id, email: session.user.email ?? null };
}

export async function requirePlatformAdmin(): Promise<{ userId: string } | { response: NextResponse }> {
  const session = await auth();
  if (!session?.user?.id) return { response: NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 }) };
  const { isPlatformAdminEmail } = await import("@/lib/permissions");
  if (!(await isPlatformAdminEmail(session.user.email))) {
    return { response: NextResponse.json({ ok: false, message: "Only platform admins can do this." }, { status: 403 }) };
  }
  return { userId: session.user.id };
}

export function installStateSecret(): string {
  return process.env.NEXTAUTH_SECRET?.trim() || process.env.AUTH_SECRET?.trim() || "";
}

/** The public origin, behind Cloudflare/Traefik (never the container's own host). */
export function publicOrigin(request: Request): string {
  const configured = process.env.PUBLIC_SITE_URL?.trim() || process.env.NEXTAUTH_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const forwardedHost = request.headers.get("x-forwarded-host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  return forwardedHost ? `${proto}://${forwardedHost}` : new URL(request.url).origin;
}
