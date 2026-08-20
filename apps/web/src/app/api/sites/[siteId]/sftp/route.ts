import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import {
  buildConnectionInfo,
  buildSftpHomePath,
  buildSftpUsername,
  generateSftpPassword
} from "@/lib/sftp-provision";
import { deleteSftpUser, isSftpConfigured, readSftpConfig, upsertSftpUser } from "@/lib/sftp-provision-apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

/**
 * SFTP access for one app.
 *
 *   GET    — current account, if any, plus connection details
 *   POST   — create it, or rotate the password ({ rotate: true })
 *   DELETE — revoke access
 *
 * Gated on canManageBackups: this hands out read/write access to every file the
 * site is built from, which is the same power as restoring a backup over it, and
 * a stricter bar than merely viewing the app.
 */

function present(account: Record<string, any> | null) {
  const config = readSftpConfig();
  if (!account || !config) {
    return { configured: isSftpConfigured(), account: null as null };
  }
  return {
    configured: true,
    account: {
      username: account.username,
      password: account.password,
      homePath: account.homePath,
      status: account.status,
      providerError: account.providerError ?? null,
      createdAt: account.createdAt,
      lastRotatedAt: account.lastRotatedAt ?? null,
      connection: buildConnectionInfo({
        host: config.publicHost,
        port: config.port,
        username: account.username
      })
    }
  };
}

async function resolve(siteId: string) {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false as const, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const workspace = await getSiteWorkspace(siteId, {
    userId: session.user.id,
    email: session.user.email
  });
  if (!workspace) {
    return { ok: false as const, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  const permissions = await resolveSitePermissionSnapshot({
    siteId,
    workspace,
    viewer: { userId: session.user.id, email: session.user.email }
  });
  if (!permissions.canManageBackups) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "You do not have permission to manage SFTP access for this app." },
        { status: 403 }
      )
    };
  }

  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  if (!db || !("sftpAccount" in db)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { ok: false, reason: "feature_unavailable", message: "SFTP access is not available in this environment yet." },
        { status: 503 }
      )
    };
  }

  return {
    ok: true as const,
    ctx: { db, workspace, actorId: session.user.id, resourceUuid: String(workspace.coolifyServiceUuid ?? "").trim() }
  };
}

export async function GET(_request: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolve(siteId);
  if (!resolved.ok) return resolved.response;
  const { db, workspace } = resolved.ctx;

  const account = await (db as any).sftpAccount.findFirst({ where: { siteId: workspace.id } });
  return NextResponse.json({ ok: true, ...present(account) });
}

export async function POST(request: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolve(siteId);
  if (!resolved.ok) return resolved.response;
  const { db, workspace, actorId, resourceUuid } = resolved.ctx;

  if (!isSftpConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        reason: "not_configured",
        message: "SFTP is not configured on this platform yet, so access cannot be provisioned."
      },
      { status: 503 }
    );
  }

  if (!resourceUuid) {
    return NextResponse.json(
      { ok: false, reason: "not_linked", message: "This app is not linked to a running resource." },
      { status: 409 }
    );
  }

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const existing = await (db as any).sftpAccount.findFirst({ where: { siteId: workspace.id } });
  const rotate = Boolean((body as any)?.rotate);

  // An existing account keeps its password unless a rotation is asked for:
  // regenerating it silently would break every client already using it.
  if (existing && !rotate) {
    return NextResponse.json({ ok: true, ...present(existing), message: "SFTP access is already set up." });
  }

  let username: string;
  let homePath: string;
  try {
    username = existing?.username ?? buildSftpUsername({ siteSlug: workspace.slug, resourceUuid });
    homePath = buildSftpHomePath(resourceUuid);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        reason: "unsafe_identifier",
        message: "This app's identifiers could not be turned into a safe SFTP path, so nothing was created."
      },
      { status: 409 }
    );
  }

  const password = generateSftpPassword();

  // The SFTP service is changed first. A row written before the account exists
  // would show a client credentials that do not work.
  const applied = await upsertSftpUser({ username, password, homePath });
  if (!applied.ok) {
    if (existing) {
      await (db as any).sftpAccount.update({
        where: { id: existing.id },
        data: { status: "failed", providerError: applied.reason }
      });
    }
    return NextResponse.json({ ok: false, reason: applied.reason, message: applied.message }, { status: 502 });
  }

  const saved = existing
    ? await (db as any).sftpAccount.update({
        where: { id: existing.id },
        data: {
          password,
          homePath,
          status: "active",
          providerError: null,
          lastRotatedAt: new Date()
        }
      })
    : await (db as any).sftpAccount.create({
        data: { siteId: workspace.id, username, password, homePath, status: "active", createdBy: actorId }
      });

  try {
    await (db as any).auditLog.create({
      data: {
        organizationId: workspace.organizationId,
        actorId,
        action: "site_updated",
        resourceType: "site",
        resourceId: workspace.id,
        details: {
          actionType: existing ? "sftp_password_rotated" : "sftp_access_created",
          username
        }
      }
    });
  } catch (error) {
    // Never fail a working provision because the audit row did not write.
    console.error("sftp: audit write failed", error);
  }

  return NextResponse.json({
    ok: true,
    ...present(saved),
    message: existing ? "A new SFTP password has been generated." : "SFTP access is ready."
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolve(siteId);
  if (!resolved.ok) return resolved.response;
  const { db, workspace, actorId } = resolved.ctx;

  const existing = await (db as any).sftpAccount.findFirst({ where: { siteId: workspace.id } });
  if (!existing) {
    return NextResponse.json({ ok: true, configured: isSftpConfigured(), account: null });
  }

  const removed = await deleteSftpUser(existing.username);
  if (!removed.ok) {
    await (db as any).sftpAccount.update({
      where: { id: existing.id },
      data: { status: "failed", providerError: removed.reason }
    });
    return NextResponse.json({ ok: false, reason: removed.reason, message: removed.message }, { status: 502 });
  }

  await (db as any).sftpAccount.delete({ where: { id: existing.id } });

  try {
    await (db as any).auditLog.create({
      data: {
        organizationId: workspace.organizationId,
        actorId,
        action: "site_updated",
        resourceType: "site",
        resourceId: workspace.id,
        details: { actionType: "sftp_access_revoked", username: existing.username }
      }
    });
  } catch (error) {
    console.error("sftp: audit write failed", error);
  }

  return NextResponse.json({
    ok: true,
    configured: isSftpConfigured(),
    account: null,
    message: "SFTP access has been revoked."
  });
}
