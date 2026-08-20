import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.config";
import { getSiteWorkspace } from "@/lib/repositories";
import { resolveSitePermissionSnapshot } from "@/lib/permissions";
import {
  DEFAULT_PRIVACY_USERNAME,
  generatePrivacyPassword,
  normalizePrivacyUsername
} from "@/lib/privacy-mode";
import { disablePrivacyMode, enablePrivacyMode } from "@/lib/privacy-mode-apply";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ siteId: string }> };

type Ctx = {
  db: any;
  siteRow: { id: string; organizationId?: string | null } & Record<string, unknown>;
  resourceUuid: string;
  actorId: string;
  permissions: { canDisablePrivacyMode: boolean; canManagePrivacyCredentials: boolean };
};

/**
 * The shape the UI renders. Credentials are included only because the caller has
 * already passed the manage check — this payload must never be widened to a
 * viewer who cannot toggle.
 */
function present(row: Record<string, any>) {
  return {
    enabled: Boolean(row.privacyModeEnabled),
    username: row.privacyModeUsername ?? DEFAULT_PRIVACY_USERNAME,
    password: row.privacyModePassword ?? null,
    updatedAt: row.privacyModeUpdatedAt ?? null,
    providerState: row.privacyModeProviderState ?? null,
    providerError: row.privacyModeProviderError ?? null
  };
}

/**
 * Record the attempt and its outcome.
 *
 * Deliberately best-effort: a site that is now genuinely private must not be
 * reported as a failure because the audit row could not be written. Failures are
 * logged for the operator instead.
 *
 * Never records the password — an audit table is exactly where a shared
 * credential should not accumulate in cleartext.
 */
async function recordPrivacyAudit(
  db: any,
  input: {
    organizationId?: string | null;
    actorId: string;
    siteId: string;
    enabled: boolean;
    outcome: "applied" | "failed";
    username?: string;
    reason?: string;
  }
): Promise<void> {
  if (!input.organizationId) return;
  try {
    await db.auditLog.create({
      data: {
        organizationId: input.organizationId,
        actorId: input.actorId,
        action: "site_updated",
        resourceType: "site",
        resourceId: input.siteId,
        details: {
          actionType: input.enabled ? "privacy_mode_enabled" : "privacy_mode_disabled",
          outcome: input.outcome,
          username: input.username,
          reason: input.reason
        }
      }
    });
  } catch (error) {
    console.error("privacy-mode: audit write failed", error);
  }
}

async function resolve(siteId: string): Promise<
  { ok: true; ctx: Ctx } | { ok: false; response: NextResponse }
> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const workspace = await getSiteWorkspace(siteId, {
    userId: session.user.id,
    email: session.user.email
  });
  if (!workspace) {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  const permissions = await resolveSitePermissionSnapshot({
    siteId,
    workspace,
    viewer: { userId: session.user.id, email: session.user.email }
  });
  if (!permissions.canEnablePrivacyMode) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "You do not have permission to change privacy mode for this app." },
        { status: 403 }
      )
    };
  }

  const { getDb } = await import("@/lib/db");
  const db = await getDb();
  if (!db || !("site" in db)) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, reason: "feature_unavailable", message: "Privacy mode is not available in this environment." },
        { status: 503 }
      )
    };
  }

  const siteRow = await (db as any).site.findUnique({ where: { id: workspace.id } });
  if (!siteRow) {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }

  const resourceUuid = String(workspace.coolifyServiceUuid ?? "").trim();
  return { ok: true, ctx: { db, siteRow, resourceUuid, actorId: session.user.id, permissions } };
}

/** Current persisted state, including whether the proxy actually reflects it. */
export async function GET(_request: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolve(siteId);
  if (!resolved.ok) return resolved.response;
  return NextResponse.json({ ok: true, ...present(resolved.ctx.siteRow) });
}

/**
 * Toggle privacy mode, or rotate the credentials while it is on.
 *
 * Body: { enabled: boolean, username?: string, regenerate?: boolean }
 *
 * The PROXY is changed first and the database second. The reverse order would
 * let a failed proxy write leave a row claiming the site is private while it
 * serves publicly — the single outcome this feature must never produce.
 */
export async function POST(request: Request, { params }: Params) {
  const { siteId } = await params;
  const resolved = await resolve(siteId);
  if (!resolved.ok) return resolved.response;
  const { db, siteRow, resourceUuid, actorId, permissions } = resolved.ctx;
  const organizationId = (siteRow.organizationId as string | undefined) ?? null;

  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const enabled = Boolean((body as any)?.enabled);

  // Turning privacy OFF publishes a site somebody deliberately hid.
  if (!enabled && !permissions.canDisablePrivacyMode) {
    return NextResponse.json(
      {
        ok: false,
        reason: "forbidden",
        message: "Only organisation admins can turn privacy mode off and make this site public."
      },
      { status: 403 }
    );
  }

  // Rotating or renaming cuts off everyone already using the credentials. The
  // first provision is exempt: there is nothing yet to break, and someone who
  // may enable privacy mode has to be given a way in.
  const alreadyProvisioned = Boolean(siteRow.privacyModePassword);
  const wantsCredentialChange =
    Boolean((body as any)?.regenerate) ||
    (typeof (body as any)?.username === "string" &&
      (body as any).username !== (siteRow.privacyModeUsername ?? DEFAULT_PRIVACY_USERNAME));
  if (enabled && alreadyProvisioned && wantsCredentialChange && !permissions.canManagePrivacyCredentials) {
    return NextResponse.json(
      {
        ok: false,
        reason: "forbidden",
        message:
          "Only organisation admins can change the privacy mode username or password, because anyone already using them would lose access."
      },
      { status: 403 }
    );
  }

  if (!resourceUuid) {
    return NextResponse.json(
      {
        ok: false,
        reason: "not_linked",
        message: "This app is not linked to a running resource, so privacy mode cannot be applied."
      },
      { status: 409 }
    );
  }

  if (!enabled) {
    const removal = await disablePrivacyMode(resourceUuid);
    if (!removal.ok) {
      await (db as any).site.update({
        where: { id: siteRow.id },
        data: { privacyModeProviderState: "failed", privacyModeProviderError: removal.reason }
      });
      await recordPrivacyAudit(db, {
        organizationId, actorId, siteId: siteRow.id, enabled: false, outcome: "failed", reason: removal.reason
      });
      return NextResponse.json({ ok: false, reason: removal.reason, message: removal.message }, { status: 502 });
    }

    const updated = await (db as any).site.update({
      where: { id: siteRow.id },
      data: {
        privacyModeEnabled: false,
        privacyModeUpdatedAt: new Date(),
        privacyModeUpdatedBy: actorId,
        privacyModeProviderState: "applied",
        privacyModeProviderError: null
      }
    });
    await recordPrivacyAudit(db, {
      organizationId, actorId, siteId: siteRow.id, enabled: false, outcome: "applied"
    });
    return NextResponse.json({
      ok: true,
      ...present(updated),
      message: "Privacy mode is off. The site is publicly reachable again."
    });
  }

  // Keep the existing password across unrelated edits: someone who has already
  // shared it with a client should not have it silently rotated because they
  // renamed the user.
  const wantsNewPassword = Boolean((body as any)?.regenerate) || !siteRow.privacyModePassword;
  const password = wantsNewPassword ? generatePrivacyPassword() : String(siteRow.privacyModePassword);
  const username = normalizePrivacyUsername(
    (body as any)?.username ?? siteRow.privacyModeUsername ?? DEFAULT_PRIVACY_USERNAME
  );

  const applied = await enablePrivacyMode({ resourceUuid, username, password });
  if (!applied.ok) {
    await (db as any).site.update({
      where: { id: siteRow.id },
      data: { privacyModeProviderState: "failed", privacyModeProviderError: applied.reason }
    });
    await recordPrivacyAudit(db, {
      organizationId, actorId, siteId: siteRow.id, enabled: true, outcome: "failed", username, reason: applied.reason
    });
    return NextResponse.json({ ok: false, reason: applied.reason, message: applied.message }, { status: 502 });
  }

  const updated = await (db as any).site.update({
    where: { id: siteRow.id },
    data: {
      privacyModeEnabled: true,
      privacyModeUsername: username,
      privacyModePassword: password,
      privacyModeUpdatedAt: new Date(),
      privacyModeUpdatedBy: actorId,
      privacyModeProviderState: "applied",
      privacyModeProviderError: null
    }
  });

  await recordPrivacyAudit(db, {
    organizationId, actorId, siteId: siteRow.id, enabled: true, outcome: "applied", username
  });

  return NextResponse.json({
    ok: true,
    ...present(updated),
    message: "Privacy mode is on. Visitors need these credentials to view the site."
  });
}
